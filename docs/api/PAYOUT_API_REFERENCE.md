# Payout API Reference & Versioning Policy (Issue #101)

## API Versioning Policy
- **Semantic Versioning**: All route contracts adhere to `v1`, `v2` URL prefixes.
- **Breaking Changes**: Changing field types, removing fields, or adding required request headers requires a major version bump.
- **Deprecation**: Deprecated routes remain functional for a minimum of 6 months after formal notice.
- **Transport version**: Clients may set `X-API-Version: v1`. The header is optional for backward compatibility; missing headers select v1.
- **Incompatible versions**: Unsupported versions return HTTP 406 with `UNSUPPORTED_API_VERSION` in `body.error.code`.
- **Current success envelope**: `{ "version": "v1", "success": true, "data": ... }`. Legacy `success` and `data` fields remain present.
- **Deprecated schema removal**: No v1 field may be removed until the deprecation notice has remained active for at least 6 months and compatibility tests have passed.

## Key Endpoints
1. `POST /v1/payouts/initiate`
   - Requires `Idempotency-Key` header.
   - Body: `InitiatePayoutRequest` with on-chain `txHash`, `contractId`, and fiat recipient details.
2. `GET /v1/payouts/{reference}/status`
   - Returns real-time status mapped from provider webhooks and contract events.

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
