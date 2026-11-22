# Payout API Reference & Versioning Policy

## API Versioning Policy
- **Semantic Versioning**: All route contracts adhere to `v1`, `v2` URL prefixes.
- **Breaking Changes**: Changing field types, removing fields, or adding required request headers requires a major version bump.
- **Deprecation**: Deprecated routes remain functional for a minimum of 6 months after formal notice.

## Current application endpoints

### `POST /api/fx-quote`

Request a server-priced, short-lived NGN payout quote:

```json
{ "tokenSymbol": "XLM", "tokenAmount": 10, "currency": "ngn" }
```

The response contains a `quoteId`, opaque signed `quoteToken`, exact decimal
exchange rate, rounded `fiatAmountMinorUnits`, rounding policy, provider
request/response identifiers, source, and `expiresAt`. The token amount and
exchange rate are canonicalized and the final amount is rounded half-up to
the currency's minor unit. Quotes expire after two minutes. Clients must use
the quoted amount and request a new quote after expiry; they must not calculate
or edit the payout value locally.

### `POST /api/initiate-transfer`

Requires an `X-Idempotency-Key` header. The request must include `amount`,
`currency`, `quoteId`, and the corresponding signed `quoteToken`, in addition
to the payout source and recipient. The server verifies the signature,
expiration, quote identifier, currency, precision, and exact minor-unit amount
before contacting the provider. The provider receives the canonical decimal
amount derived from those verified minor units.

The append-only `fx_quote_created`, `payout_initiated`, and
`payout_provider_accepted` audit events link the quote to the idempotency key,
provider reference, provider transfer ID/code, and final transfer amount and
currency. The signed token itself is not written to the audit ledger.

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

Payout routes retain the legacy `message` field and include a stable machine
code in `error.code`. Quote-related failures include `FX_QUOTE_REQUIRED`
(428), `FX_QUOTE_EXPIRED` (410), `FX_QUOTE_MISMATCH` (409),
and `FX_QUOTE_UNAVAILABLE` (503). Reusing an idempotency key with different
request details returns `IDEMPOTENCY_CONFLICT` (409). A client must obtain a
fresh quote after expiration and must not retry a modified request with an
already-used idempotency key.
