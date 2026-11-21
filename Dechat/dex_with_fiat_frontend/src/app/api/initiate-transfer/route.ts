import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { getPayoutProvider } from '@/lib/payout/providers/registry';
import {
  sanitizeProviderError,
} from '@/lib/payout/timeoutBudget';
import { telemetry } from '@/lib/telemetry';
import { applyRateLimit, getClientIp } from '@/lib/rateLimit';
import { setTransferStatus, getTransferStatus } from '@/lib/transferStore';
import { initiateTransferSchema } from '@/lib/apiSchemas';
import { payoutAuditLedger } from '@/lib/payout/auditLedger';
import { payoutRetryQueue } from '@/lib/payout/retryQueue';
import { enforcePayoutRouteSecurity } from '@/lib/payout/security';
import {
  extractOrGenerateCorrelationId,
  validationError,
  logStructuredError,
} from '@/lib/payout/errors';
import {
  enforcePayoutApiVersion,
  payoutSuccessResponse,
} from '@/lib/payout/schemaEvolution';
import { handlePayoutApiError } from '@/lib/payout/circuitBreaker';
import { validatePayoutAmount } from '@/lib/payout/minorUnits';

const RATE_LIMIT = { maxRequests: 3, windowMs: 60_000 };

const idempotencyCache = new Map<
  string,
  { result: unknown; timestamp: number }
>();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export async function OPTIONS(request: NextRequest) {
  return (
    enforcePayoutRouteSecurity(request) ||
    new NextResponse(null, { status: 204 })
  );
}

export async function POST(request: NextRequest) {
  // Enforce payout API security
  const securityBlocked = enforcePayoutRouteSecurity(request);
  if (securityBlocked) return securityBlocked;
  const apiVersionBlocked = enforcePayoutApiVersion(request);
  if (apiVersionBlocked) return apiVersionBlocked;
  if (!request.headers.get('X-Idempotency-Key')) {
    return validationError({
      message: 'X-Idempotency-Key header is required',
      correlationId: extractOrGenerateCorrelationId(request.headers),
      code: 'VALIDATION_ERROR',
    });
  }

  const ip = getClientIp(request);
  const correlationId = extractOrGenerateCorrelationId(request.headers);

  const limited = applyRateLimit(ip, '/api/initiate-transfer', RATE_LIMIT);
  if (limited) return limited;

  const traceContext = telemetry.extractTraceFromHeaders(request.headers);
  const span = telemetry.createSpan(
    'initiate-transfer',
    traceContext.spanId,
    traceContext.traceId,
  );
  let idempotencyKey = '';

  try {
    telemetry.addLog(span.spanId, 'info', 'Starting transfer initiation', {
      endpoint: '/api/initiate-transfer',
      correlationId,
    });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      telemetry.addLog(span.spanId, 'warn', 'Malformed JSON body', {
        correlationId,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Invalid JSON body',
      });

      return validationError({
        message: 'Invalid JSON in request body.',
        correlationId,
        code: 'MALFORMED_REQUEST',
      });
    }

    // Validate with strict Zod schema
    const validationResult = initiateTransferSchema.safeParse(body);

    if (!validationResult.success) {
      telemetry.addLog(span.spanId, 'warn', 'Zod validation failed', {
        errors: validationResult.error.issues,
        correlationId,
      });
      telemetry.finishSpan(span.spanId, {
        success: false,
        error: 'Validation failed',
      });

      return validationError({
        message: 'Validation failed',
        correlationId,
        issues: validationResult.error.issues,
      });
    }

    const { source, reason, amount, recipient } = validationResult.data;
    const bodyRecord = body as Record<string, unknown>;
    const clientSessionId =
      request.headers.get('x-client-session-id') ||
      (typeof bodyRecord.clientSessionId === 'string'
        ? bodyRecord.clientSessionId
        : undefined);

    // Validate payout amounts using integer minor units (Issue #40)
    const currency =
      typeof bodyRecord.currency === 'string' ? bodyRecord.currency : 'NGN';
    const validatedAmount = validatePayoutAmount(amount, currency);

    // Resolve idempotency key: X-Idempotency-Key header, body reference, or generated
    const headerIdempotencyKey = request.headers.get('X-Idempotency-Key');
    idempotencyKey =
      headerIdempotencyKey ||
      (typeof bodyRecord.reference === 'string' && bodyRecord.reference
        ? bodyRecord.reference
        : `idemp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`);

    const cached = idempotencyCache.get(idempotencyKey);
    if (cached && Date.now() - cached.timestamp < IDEMPOTENCY_TTL_MS) {
      return payoutSuccessResponse(cached.result, { correlationId });
    }

    telemetry.addLog(span.spanId, 'info', 'Request validated', {
      hasSource: !!source,
      hasAmount: !!amount,
      hasRecipient: !!recipient,
      amount: amount,
      idempotencyKey,
    });

    // Record immutable audit event for payout initiation (Issue #38)
    payoutAuditLedger.recordEvent({
      payoutId: idempotencyKey,
      action: 'payout_initiated',
      actor: clientSessionId ? `client:${clientSessionId}` : 'client:user',
      requestCorrelationId: traceContext.traceId,
      providerReference: idempotencyKey,
      metadata: {
        source,
        reason,
        amount: Number(amount),
        recipient,
      },
    });

    const provider = getPayoutProvider();

    try {
      const data = await provider.initiateTransfer({
        source,
        reason,
        amount: Number(amount),
        recipient,
        reference: idempotencyKey,
      });

      const transferReference =
        typeof data.reference === 'string' && data.reference
          ? data.reference
          : idempotencyKey;

      if (transferReference) {
        setTransferStatus({
          reference: transferReference,
          status: 'pending',
          amount: Number(amount),
          updatedAt: new Date().toISOString(),
          clientSessionId,
        });
      }

      // Record successful provider acceptance in audit ledger
      payoutAuditLedger.recordEvent({
        payoutId: transferReference,
        action: 'payout_provider_accepted',
        actor: 'provider:paystack',
        requestCorrelationId: traceContext.traceId,
        providerReference: transferReference,
        metadata: { data: data as unknown as Record<string, unknown> },
      });

      idempotencyCache.set(idempotencyKey, {
        result: data,
        timestamp: Date.now(),
      });

      return payoutSuccessResponse(data, { correlationId });
    } catch (providerError: unknown) {
      const errorMessage =
        providerError instanceof Error
          ? providerError.message
          : 'Unknown provider error';

      // Enqueue into durable retry queue instead of losing payout intent (Issue #37)
      const retryJob = payoutRetryQueue.enqueueJob({
        payoutId: idempotencyKey,
        idempotencyKey,
        payload: {
          source,
          amount: Number(amount),
          recipient,
          reason,
        },
        error: errorMessage,
        correlationId: traceContext.traceId,
      });

      setTransferStatus({
        reference: idempotencyKey,
        status: 'pending',
        amount: Number(amount),
        updatedAt: new Date().toISOString(),
        updatedAtMs: Date.now(),
        clientSessionId,
        failureReason: `Transient error: ${errorMessage}. Queued for retry.`,
      });

      telemetry.addLog(
        span.spanId,
        'warn',
        'Provider call failed; enqueued into retry queue',
        {
          jobId: retryJob.id,
          idempotencyKey,
          error: errorMessage,
        },
      );

      return payoutSuccessResponse(
        {
          reference: idempotencyKey,
          jobId: retryJob.id,
        },
        {
          status: 202,
          correlationId,
          extra: {
            status: 'queued_for_retry',
            reference: idempotencyKey,
            jobId: retryJob.id,
            message: 'Transfer queued for retry due to provider failure',
          },
        },
      );
    }
  } catch (error: unknown) {
    logStructuredError('initiate-transfer', error, {
      endpoint: '/api/initiate-transfer',
      correlationId,
      ip: getClientIp(request),
    });

    Sentry.captureException(error, {
      tags: {
        endpoint: '/api/initiate-transfer',
        operation: 'transfer_initiation',
      },
      extra: {
        ip: getClientIp(request),
        correlationId,
        traceId: traceContext.traceId,
        spanId: span.spanId,
      },
    });

    const sanitized = sanitizeProviderError(error, 'initiate', idempotencyKey);

    telemetry.addLog(
      span.spanId,
      'error',
      'Unhandled error in transfer initiation',
      { error: sanitized.message, code: sanitized.code },
    );

    console.error('Initiate transfer error:', error);

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
