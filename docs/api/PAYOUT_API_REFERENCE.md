# Payout API Reference & Versioning Policy (Issue #101)

## API Versioning Policy
- **Semantic Versioning**: All route contracts adhere to `v1`, `v2` URL prefixes.
- **Breaking Changes**: Changing field types, removing fields, or adding required request headers requires a major version bump.
- **Deprecation**: Deprecated routes remain functional for a minimum of 6 months after formal notice.

## Key Endpoints
1. `POST /v1/payouts/initiate`
   - Requires `Idempotency-Key` header.
   - Body: `InitiatePayoutRequest` with on-chain `txHash`, `contractId`, and fiat recipient details.
2. `GET /v1/payouts/{reference}/status`
   - Returns real-time status mapped from provider webhooks and contract events.

## Beneficiary verification and authorization
- The payout UI establishes wallet identity by signing `authenticate:<wallet-address>:<timestamp>` with Freighter and posting the signature, address, and timestamp to `POST /api/auth/wallet-session`. The timestamp must be within five minutes. The endpoint returns a short-lived bearer session token and CSRF token and sets the session in an HttpOnly cookie.
- Browser clients send the bearer token as `Authorization: Bearer <sessionToken>` and the returned CSRF token as `X-CSRF-Token` on payout mutations. A wallet address supplied without a valid signature/session is not an identity credential.
- `POST /api/verify-account` requires a server-verified wallet session. On success it returns the verified account name, a masked account number, an opaque `verificationToken`, and its expiry; full account and bank identifiers are never returned.
- `POST /api/create-recipient` also requires the authenticated wallet session and the `verificationToken`. The signed token expires after five minutes and is bound to the wallet identity, account number, bank code, currency, and provider-verified account name. Changing any of these details requires a new verification.
- Missing/invalid authorization returns `BENEFICIARY_VERIFICATION_REQUIRED`; expired authorization returns `BENEFICIARY_VERIFICATION_EXPIRED`; mismatched details return HTTP 409 with `BENEFICIARY_DETAILS_CHANGED`.
- Client-supplied user IDs/scopes do not establish beneficiary ownership. Beneficiary deduplication and recovery are scoped to the authenticated wallet.
- Configure the same random `BENEFICIARY_DEDUPE_SECRET` on every production application instance. Keep it in the deployment secret manager; rotating it invalidates outstanding verification tokens.
- Verification tokens are self-contained and stateless so verification and recipient creation can be served by different application instances. They contain only keyed fingerprints, not account details.

## Error Model
Standard RFC 7807 Problem Details are returned for non-2xx responses:
```json
{
  "type": "https://errors.stellar-dex-chat.org/idempotency-conflict",
  "title": "Idempotency Conflict",
  "status": 409,
  "detail": "A payout with this Idempotency-Key was already initiated with different payload parameters."
}
```
