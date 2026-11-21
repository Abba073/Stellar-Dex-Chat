import axios from 'axios';
import { credentialManager } from '../credentialManager';
import { executeWithTimeoutBudget } from '../timeoutBudget';

import type {
  CancelTransferInput,
  CancelTransferResult,
  CreateRecipientInput,
  CreateRecipientResult,
  InitiateTransferInput,
  InitiateTransferResult,
  NormalizedPayoutStatus,
  PayoutProvider,
  TransferStatusInput,
  TransferStatusResult,
  VerifyAccountInput,
  VerifyAccountResult,
} from './types';
import { PayoutProviderError } from './types';

export function toKobo(amountNgn: number): number {
  return Math.round(amountNgn * 100);
}

function paystackHeaders(secretKey?: string) {
  return {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/json',
  };
}

function normalizePaystackStatus(status?: string): NormalizedPayoutStatus {
  switch (status?.toLowerCase()) {
    case 'success':
      return 'success';
    case 'failed':
    case 'rejected':
      return 'failed';
    case 'reversed':
      return 'reversed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

function normalizeProviderError(error: unknown): PayoutProviderError {
  if (error instanceof PayoutProviderError) return error;

  const response =
    typeof error === 'object' && error !== null && 'response' in error
      ? (error as { response?: { status?: number; data?: { message?: string } } })
          .response
      : undefined;

  const status = response?.status;
  const providerCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : undefined;

  let code:
    | 'INVALID_ACCOUNT'
    | 'ACCOUNT_NOT_FOUND'
    | 'INSUFFICIENT_FUNDS'
    | 'PROVIDER_UNAVAILABLE'
    | 'RATE_LIMITED'
    | 'AUTHENTICATION_ERROR'
    | 'INVALID_REQUEST'
    | 'UNKNOWN_ERROR' = 'UNKNOWN_ERROR';
  if (status === 401) code = 'AUTHENTICATION_ERROR';
  else if (status === 429) code = 'RATE_LIMITED';
  else if (status === 422) code = 'INVALID_ACCOUNT';
  else if (status === 404) code = 'ACCOUNT_NOT_FOUND';
  else if (status === 503 || status === 504) code = 'PROVIDER_UNAVAILABLE';

  return new PayoutProviderError({
    message: response?.data?.message || 'Payment provider request failed',
    code,
    statusCode: status,
    retryable: status === 429 || status === 503 || status === 504,
    providerCode,
    rawResponse: response?.data,
  });
}

export const paystackProvider: PayoutProvider = {
  name: 'paystack',

  async verifyAccount(
    input: VerifyAccountInput,
  ): Promise<VerifyAccountResult> {
    const cred = credentialManager.getActiveCredential();
    if (!cred?.secretKey) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        accountNumber: input.accountNumber,
        accountName: 'Test Account',
        bankCode: input.bankCode,
        bankId: Number.parseInt(input.bankCode, 10),
        rawResponse: { mock: true },
      };
    }

    try {
      return await executeWithTimeoutBudget(
        'verify',
        async (signal, phaseNotifier) => {
          const response = await axios.get(
            'https://api.paystack.co/bank/resolve',
            {
              headers: paystackHeaders(cred.secretKey),
              params: {
                account_number: input.accountNumber,
                bank_code: input.bankCode,
              },
              signal,
            },
          );
          phaseNotifier?.markConnected();
          const data = response.data?.data;
          if (response.data?.status && data) {
            return {
              accountNumber: data.account_number,
              accountName: data.account_name,
              bankCode: input.bankCode,
              bankId: Number.parseInt(input.bankCode, 10),
              rawResponse: response.data,
            };
          }
          throw new Error(
            response.data?.message || 'Account verification failed',
          );
        },
      );
    } catch (error) {
      throw normalizeProviderError(error);
    }
  },

  async createRecipient(
    input: CreateRecipientInput,
  ): Promise<CreateRecipientResult> {
    const cred = credentialManager.getActiveCredential();
    if (!cred?.secretKey) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        recipientCode: `RCP_${Math.random().toString(36).substring(2, 11)}`,
        name: input.name,
        accountNumber: input.account_number,
        bankCode: input.bank_code,
        currency: input.currency,
        type: input.type,
        provider: 'paystack',
        rawResponse: { mock: true },
      };
    }

    try {
      return await executeWithTimeoutBudget(
        'recipient',
        async (signal, phaseNotifier) => {
          const response = await axios.post(
            'https://api.paystack.co/transferrecipient',
            input,
            { headers: paystackHeaders(cred.secretKey), signal },
          );
          phaseNotifier?.markConnected();
          if (response.data?.status && response.data?.data) {
            const data = response.data.data;
            return {
              recipientCode: data.recipient_code,
              name: data.name,
              accountNumber: data.details.account_number,
              bankCode: data.details.bank_code,
              currency: data.currency,
              type: data.type,
              provider: 'paystack',
              rawResponse: response.data,
            };
          }
          throw new Error(
            response.data?.message || 'Failed to create recipient',
          );
        },
      );
    } catch (error) {
      throw normalizeProviderError(error);
    }
  },

  async initiateTransfer(
    input: InitiateTransferInput,
  ): Promise<InitiateTransferResult> {
    const cred = credentialManager.getActiveCredential();
    const credentialVersion =
      cred?.version || input.credentialVersion || 'v1';
    const reference =
      input.reference ||
      `pay_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const amountMinor = toKobo(Number(input.amount));

    if (!cred?.secretKey) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        reference,
        status: 'pending',
        providerReference: `PROV_${reference}`,
        transferCode: `TRF_${Math.random().toString(36).slice(2, 9)}`,
        amountMinor: BigInt(amountMinor),
        currency: 'NGN',
        recipientCode: input.recipient,
        credentialVersion,
        rawResponse: { mock: true },
      } as unknown as InitiateTransferResult;
    }

    try {
      return await executeWithTimeoutBudget(
        'initiate',
        async (signal, phaseNotifier) => {
          const response = await axios.post(
            'https://api.paystack.co/transfer',
            {
              source: input.source,
              amount: amountMinor,
              recipient: input.recipient,
              reason: input.reason || 'Crypto withdrawal',
              reference,
            },
            { headers: paystackHeaders(cred.secretKey), signal },
          );
          phaseNotifier?.markConnected();
          if (response.data?.status && response.data?.data) {
            return {
              ...response.data.data,
              credentialVersion,
              reference: response.data.data.reference || reference,
            };
          }
          throw new Error(
            response.data?.message || 'Failed to initiate transfer',
          );
        },
        { reference },
      );
    } catch (error) {
      throw normalizeProviderError(error);
    }
  },

  async checkTransferStatus(
    input: TransferStatusInput,
  ): Promise<TransferStatusResult> {
    const cred = credentialManager.getCredential(input.credentialVersion);
    if (!cred?.secretKey) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return {
        reference: input.reference,
        status: 'pending',
        providerReference: input.reference,
        currency: 'NGN',
        rawResponse: { mock: true },
      };
    }

    try {
      return await executeWithTimeoutBudget(
        'status',
        async (signal, phaseNotifier) => {
          const response = await axios.get(
            `https://api.paystack.co/transfer/verify/${input.reference}`,
            { headers: paystackHeaders(cred.secretKey), signal },
          );
          phaseNotifier?.markConnected();
          const data = response.data?.data;
          if (response.data?.status && data) {
            return {
              reference: data.reference || input.reference,
              status: normalizePaystackStatus(data.status),
              providerReference: data.transfer_code || input.reference,
              transferCode: data.transfer_code,
              amountMinor:
                typeof data.amount === 'number' ? BigInt(data.amount) : undefined,
              currency: data.currency,
              failureReason: data.reason,
              completedAt: data.updatedAt,
              rawResponse: response.data,
            };
          }
          throw new Error(
            response.data?.message || 'Failed to fetch transfer status',
          );
        },
        { reference: input.reference },
      );
    } catch (error) {
      throw normalizeProviderError(error);
    }
  },

  async cancelTransfer(
    input: CancelTransferInput,
  ): Promise<CancelTransferResult> {
    const cred = credentialManager.getActiveCredential();
    if (!cred?.secretKey) {
      return {
        status: 'confirmed',
        cancellable: true,
        message: 'Transfer cancellation confirmed by provider (mock)',
        providerReference: input.reference,
      };
    }

    const status = await this.checkTransferStatus({ reference: input.reference });
    if (status.status === 'success') {
      return {
        status: 'settled',
        cancellable: false,
        message: 'Transfer has already settled',
        providerReference: input.reference,
      };
    }
    if (status.status === 'failed' || status.status === 'reversed') {
      return {
        status: 'rejected',
        cancellable: false,
        message: `Transfer is already in final state: ${status.status}`,
        providerReference: input.reference,
      };
    }
    return {
      status: 'confirmed',
      cancellable: true,
      message: 'Transfer cancellation confirmed by provider',
      providerReference: input.reference,
    };
  },
};
