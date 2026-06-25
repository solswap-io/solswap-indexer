# solswap-indexer

Solswap spot analytics indexer for Solana.

This service is a standalone read service that normalizes on-chain activity into
wallet-, chart-, and portfolio-friendly APIs for Fearless clients.

## What it serves
- Wallet swap history across Batch Swap, DLMM, and RFQ routes
- Read-only SOL, SPL Token, and Token-2022 wallet balances
- Wallet account state, transaction history, and token metadata
- Spot position summaries with avg entry and realized/unrealized P/L
- Batch market candles and market overview metrics
- Pending batch intents for a wallet + market

## Requirements
- Node.js 20+

## Setup
```bash
npm install
```

## Run
```bash
npm run dev
```

## Build
```bash
npm run build
npm start
```

## Production Container
```bash
docker build -t si-indexer:release .
docker run --rm -p 8788:8788 si-indexer:release
```

The image defaults to the public read-only Solana mainnet RPC contract used by
`https://si.soramitsu.io`.

## Production Smoke
```bash
npm run smoke:production
SOLSWAP_INDEXER_BASE_URL=https://si.soramitsu.io npm run smoke:production
```

The smoke check verifies that the target host serves the Solswap API contract,
not another indexer service.

For `https://si.soramitsu.io` production deployment guidance, see
`docs/si-production.md`.

## Configuration
Environment variables:
- `PORT` (default: `8788`)
- `HOST` (default: `0.0.0.0`)
- `SOLANA_RPC_ENDPOINT` (default: `https://api.mainnet-beta.solana.com`)
- `BATCH_AUCTION_PROGRAM_ID` (optional)
- `DLMM_PROGRAM_ID` (optional)
- `RFQ_PROGRAM_ID` (optional)
- `SS_MINT` (optional; used as the quote mint for avg entry / P&L)
- `QUOTE_USD_RATE` (default: `1`; USD conversion for the quote asset)
- `ACCOUNT_SCAN_LIMIT` (default: `150`)
- `MARKET_SCAN_LIMIT` (default: `250`)
- `CACHE_TTL_MS` (default: `15000`)
- `CORS_ALLOW_ORIGIN` (default: `*`)
- `RATE_LIMIT_WINDOW_MS` (default: `60000`)
- `RATE_LIMIT_MAX` (default: `120`)
- `RPC_RETRY_ATTEMPTS` (default: `3`)
- `RPC_RETRY_BASE_DELAY_MS` (default: `250`)

## API
- `GET /api/indexer/v1/health`
- `GET /api/indexer/v1/service-info`
- `GET /api/indexer/v1/accounts/:wallet/balances`
- `GET /api/indexer/v1/accounts/:wallet/assets`
- `GET /api/indexer/v1/accounts/:wallet/state`
- `GET /api/indexer/v1/accounts/:wallet/txs?before=...&limit=50`
- `GET /api/indexer/v1/tokens/:mint/metadata`
- `POST /api/indexer/v1/tokens/metadata` with `{ "mints": ["..."] }`
- `GET /api/indexer/v1/accounts/:wallet/swaps`
- `GET /api/indexer/v1/accounts/:wallet/spot-positions`
- `GET /api/indexer/v1/accounts/:wallet/pending-intents?marketAddress=...`
- `GET /api/indexer/v1/markets/:marketAddress/candles?interval=1h&limit=120`
- `GET /api/indexer/v1/markets/:marketAddress/overview`
- `GET /api/indexer/v1/openapi.json`
- `GET /openapi.json` (compatibility alias)
- `GET /docs`
- `GET /api/indexer/v1/metrics`

Token metadata responses include additive Token-2022 extension hints:
`extensions`, `transferFeeConfig`, and `transferHook`. `transferHook` includes
the standard ExtraAccountMetaList PDA when the hook program id is available.
Wallet clients use these fields to require transfer-fee acknowledgement and
transfer-hook extra-account resolution before constructing Token-2022 sends.

## Notes
- Wallet APIs are read-only. Transaction simulation and broadcast must use the
  wallet's configured Solana RPC endpoint directly.
- Wallet-facing amounts are raw integer strings. UI amount strings are derived
  display helpers and must not be used for accounting.
- Solana RPC reads use bounded retry with exponential backoff for transient
  timeout, 429, and 5xx-style failures.
- Wallet swap history is inferred from parsed token balance deltas for transactions routed through configured Batch/DLMM/RFQ program IDs.
- Market candles and overview are currently implemented for Batch markets using vault deltas and epoch state.
- USD values are derived from `QUOTE_USD_RATE`; when SS is the quote asset, the default is `1`.
