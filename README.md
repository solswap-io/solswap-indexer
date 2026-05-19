# solswap-indexer

Solswap spot analytics indexer for Solana.

This service is a standalone read service that normalizes on-chain activity into chart- and portfolio-friendly APIs for the web app.

## What it serves
- Wallet swap history across Batch Swap, DLMM, and RFQ routes
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

## API
- `GET /api/indexer/v1/health`
- `GET /api/indexer/v1/accounts/:wallet/swaps`
- `GET /api/indexer/v1/accounts/:wallet/spot-positions`
- `GET /api/indexer/v1/accounts/:wallet/pending-intents?marketAddress=...`
- `GET /api/indexer/v1/markets/:marketAddress/candles?interval=1h&limit=120`
- `GET /api/indexer/v1/markets/:marketAddress/overview`

## Notes
- Wallet swap history is inferred from parsed token balance deltas for transactions routed through configured Batch/DLMM/RFQ program IDs.
- Market candles and overview are currently implemented for Batch markets using vault deltas and epoch state.
- USD values are derived from `QUOTE_USD_RATE`; when SS is the quote asset, the default is `1`.
