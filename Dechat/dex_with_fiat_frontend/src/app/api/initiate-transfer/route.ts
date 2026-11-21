import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import * as Sentry from '@sentry/nextjs';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import { credentialManager } from '@/lib/payout/credentialManager';
import { telemetry } from '@/lib/telemetry';
import {
  applyRateLimit,
  getClientIp,
  ROUTE_COST_BUCKETS,
} from '@/lib/rateLimit';
import { enforcePayoutRouteSecurity } from '@/lib/payout/security';
import { handlePayoutApiError } from '@/lib/payout/circuitBreaker';
import {
  logStructuredError,
  extractOrGenerateCorrelationId,
  validationError,
} from '@/lib/payout/errors';
import { validatePayoutAmount } from '@/lib/payout/minorUnits';
import { setTransferStatus } from '@/lib/transferStore';
import { initiateTransferSchema } from '@/lib/apiSchemas';
import { payoutAuditLedger } from '@/lib/payout/auditLedger';
import {
  payoutReservationLedger,
  PayoutReservationConflictError,
} from '@/lib/payout/reservationLedger';
import { ProviderIdempotencyReconciliationRequiredError } from '@/lib/payout/providerIdempotency';
import { payoutRetryQueue } from '@/lib/payout/retryQueue';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT = ROUTE_COST_BUCKETS['/api/initiate-transfer'];
const idempotencyCache = new Map<
  string,
  { result: unknown; payloadHash: string; timestamp: number }
>();

function hashPayoutRequest(payload: {
  source: string;
  reason?: string;
  amountMinor: bigint;
  currency: string;
  recipient: string;
  contractReceiptId?: string;
}): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        ...payload,
        amountMinor: payload.amountMinor.toString(),
      }),
    )
    .digest('hex');
}

export async function OPTIONS(request: NextRequest) {
  return (
    enforcePayoutRouteSecurity(request) ||
    new NextResponse(null, { status: 204 })
  );
}

export async function POST(request: NextRequest) {
  const securityBlocked = enforcePayoutRouteSecurity(request);
  if (securityBlocked) return securityBlocked;

  const correlationId = extractOrGenerateCorrelationId(request.headers);
  const ip = getClientIp(request);
  const limited = applyRateLimit(ip, '/api/initiate-transfer', RATE_LIMIT, {
    correlationId,
  });
  if (limited) return limited;

  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'initiate-transfer',
    traceContext.spanId,
    traceContext.traceId,
  );
  let idempotencyKey = '';

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return validationError({
        message: 'Invalid JSON in request body.',
        correlationId,
        code: 'MALFORMED_REQUEST',
      });
    }

    const bodyRecord =
      body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const headerIdempotencyKey = request.headers.get('X-Idempotency-Key');
    idempotencyKey =
      headerIdempotencyKey ||
      (typeof bodyRecord.reference === 'string' ? bodyRecord.reference : '');
    if (!idempotencyKey) {
      return validationError({
        message: 'X-Idempotency-Key header is required.',
        correlationId,
        code: 'INVALID_INPUT',
      });
    }

    const validationResult = initiateTransferSchema.safeParse(body);
    if (!validationResult.success) {
      return validationError({
        message: 'Validation failed',
        correlationId,
        issues: validationResult.error.issues.map((issue) => ({
          path: issue.path.filter(
            (segment): segment is string | number =>
              typeof segment !== 'symbol',
          ),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    const { source, reason, amount, recipient, contractReceiptId } =
      validationResult.data;
    const currency =
      typeof bodyRecord.currency === 'string'
        ? bodyRecord.currency.toUpperCase()
        : 'NGN';
    const validatedAmount = validatePayoutAmount(amount, currency);
    const payloadHash = hashPayoutRequest({
      source,
      reason,
      amountMinor: validatedAmount.amountMinor,
      currency,
      recipient,
      contractReceiptId,
    });

    const cached = idempotencyCache.get(idempotencyKey);
    if (cached && Date.now() - cached.timestamp < IDEMPOTENCY_TTL_MS) {
      if (cached.payloadHash !== payloadHash) {
        return NextResponse.json(
          {
            success: false,
            message:
              'Idempotency key was already used with a different request.',
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ success: true, data: cached.result });
    }
    if (cached) idempotencyCache.delete(idempotencyKey);

    const clientSessionId =
      request.headers.get('x-client-session-id') ||
      (typeof bodyRecord.clientSessionId === 'string'
        ? bodyRecord.clientSessionId
        : undefined);
    const credentialVersion =
      credentialManager.getActiveCredential()?.version || 'v1';
    const now = new Date().toISOString();

    if (contractReceiptId) {
      try {
        payoutReservationLedger.reserve({
          payoutId: idempotencyKey,
          contractReceiptId,
          amountMinor: validatedAmount.amountMinor,
          currency,
          timestamp: now,
        });
      } catch (error) {
        if (error instanceof PayoutReservationConflictError) {
          return NextResponse.json(
            { success: false, message: error.message },
            { status: 409 },
          );
        }
        throw error;
      }
    }

    payoutAuditLedger.recordEvent({
      payoutId: idempotencyKey,
      action: 'payout_initiated',
      actor: clientSessionId ? `client:${clientSessionId}` : 'client:user',
      requestCorrelationId: traceContext.traceId,
      providerReference: idempotencyKey,
      metadata: {
        source,
        reason,
        amountMinor: validatedAmount.amountMinor.toString(),
        currency,
        contractReceiptId,
      },
    });

    const provider = getPayoutProvider();
    try {
      const data = await provider.initiateTransfer({
        source,
        reason,
        amount: validatedAmount.canonicalDecimal,
        recipient,
        reference: idempotencyKey,
        idempotencyKey,
        currency,
        credentialVersion,
      });

      const transferReference = data.reference || idempotencyKey;
      setTransferStatus({
        reference: transferReference,
        status: data.status || 'pending',
        amount: Number(validatedAmount.canonicalDecimal),
        amountMinor: validatedAmount.amountMinor,
        currency,
        updatedAt: new Date().toISOString(),
        clientSessionId,
      });
      if (contractReceiptId) {
        payoutReservationLedger.linkProviderTransfer(
          idempotencyKey,
          transferReference,
        );
      }

      payoutAuditLedger.recordEvent({
        payoutId: idempotencyKey,
        action: 'payout_provider_accepted',
        actor: `provider:${provider.name}`,
        requestCorrelationId: traceContext.traceId,
        providerReference: transferReference,
        metadata: {
          status: data.status,
          providerReference: data.providerReference,
          settlementEstimate: data.settlementEstimate,
        },
      });

      idempotencyCache.set(idempotencyKey, {
        result: data,
        payloadHash,
        timestamp: Date.now(),
      });

      return NextResponse.json({ success: true, data });
    } catch (providerError) {
      if (
        providerError instanceof ProviderIdempotencyReconciliationRequiredError
      ) {
        return NextResponse.json(
          {
            success: false,
            code: 'PROVIDER_RECONCILIATION_REQUIRED',
            message: providerError.message,
          },
          { status: 409 },
        );
      }

      const errorMessage =
        providerError instanceof Error
          ? providerError.message
          : 'Unknown provider error';

      if (contractReceiptId) {
        payoutReservationLedger.markUnderReview(idempotencyKey);
      }

      const retryJob = payoutRetryQueue.enqueueJob({
        payoutId: idempotencyKey,
        idempotencyKey,
        payload: {
          source,
          amount: Number(validatedAmount.canonicalDecimal),
          recipient,
          reason,
        },
        error: errorMessage,
        correlationId: traceContext.traceId,
      });

      setTransferStatus({
        reference: idempotencyKey,
        status: 'pending',
        amount: Number(validatedAmount.canonicalDecimal),
        amountMinor: validatedAmount.amountMinor,
        currency,
        updatedAt: new Date().toISOString(),
        clientSessionId,
        failureReason: `Transfer outcome requires reconciliation: ${errorMessage}`,
      });

      return NextResponse.json(
        {
          success: true,
          status: 'queued_for_retry',
          reference: idempotencyKey,
          jobId: retryJob.id,
          message: 'Transfer queued for retry due to provider uncertainty',
        },
        { status: 202 },
      );
    }
  } catch (error: unknown) {
    logStructuredError('initiate-transfer', error, {
      endpoint: '/api/initiate-transfer',
      correlationId,
      ip,
    });
    Sentry.captureException(error, {
      tags: {
        endpoint: '/api/initiate-transfer',
        operation: 'transfer_initiation',
      },
      extra: { ip, correlationId, traceId: traceContext.traceId },
    });
    telemetry.addLog(span.spanId, 'error', 'Transfer initiation failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      idempotencyKey,
    });
    const errorDetails = handlePayoutApiError(
      error,
      'Failed to initiate transfer. Please try again.',
    );
    telemetry.finishSpan(span.spanId, {
      success: false,
      error: errorDetails.body.message,
    });
    return NextResponse.json(errorDetails.body, {
      status: errorDetails.status,
      headers: errorDetails.headers,
    });
  }
}
