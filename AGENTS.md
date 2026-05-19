# AGENTS.md

## Repo Purpose

`solswap-indexer` is a Node.js 20+ TypeScript service that exposes read-only Solswap spot analytics for Solana. It normalizes on-chain activity into wallet swap history, spot position summaries, batch market candles, market overview data, and pending batch intents.

The service is intentionally stateless apart from a short in-memory cache. It reads Solana RPC data through `@solana/web3.js` and serves HTTP APIs with Fastify.

## Project Structure

- `src/index.ts` starts the Fastify server, configures CORS headers, and registers the `/api/indexer/v1/*` routes.
- `src/config.ts` parses environment variables and converts configured program IDs and mints into `PublicKey` values.
- `src/indexerService.ts` contains the main RPC query, transaction parsing, caching, candle aggregation, route detection, and position summary logic.
- `src/batchAuction.ts` decodes Solswap batch auction accounts and derives batch intent/epoch PDAs.
- `src/models.ts` defines the public API response types.
- `src/scripts/smoke.ts` contains the current smoke test coverage for batch auction decoding.

Generated directories such as `dist/`, `node_modules/`, `output/`, and `.soracloud-taira/` are local artifacts and should not be committed.

## Commands

- Install dependencies: `npm install`
- Run the dev server: `npm run dev`
- Build TypeScript: `npm run build`
- Run the service from build output: `npm start`
- Run smoke tests: `npm test`

Before committing code changes, run:

```bash
npm run build -- --noEmit
npm test
```

## Configuration

Configuration is read from environment variables in `src/config.ts`. Important variables include:

- `PORT` and `HOST` for the HTTP listener.
- `SOLANA_RPC_ENDPOINT` for RPC access.
- `BATCH_AUCTION_PROGRAM_ID`, `DLMM_PROGRAM_ID`, and `RFQ_PROGRAM_ID` for route detection.
- `SS_MINT` and `QUOTE_USD_RATE` for quote asset and USD calculations.
- `ACCOUNT_SCAN_LIMIT`, `MARKET_SCAN_LIMIT`, and `CACHE_TTL_MS` for RPC scan and cache behavior.
- `CORS_ALLOW_ORIGIN` for browser clients.

Do not commit real secrets or private RPC credentials. Use local `.env` files for machine-specific values.

## Development Notes

- Keep the API shape in `src/models.ts` aligned with route behavior in `src/index.ts`.
- Prefer extending `IndexerService` with small helpers over adding parsing logic directly to route handlers.
- Be careful with token amount math. Existing code uses parsed UI token amounts from Solana RPC, so precision-sensitive changes should be reviewed explicitly.
- Treat unknown or missing on-chain data as an empty/null response where the current API already does so.
- Keep tests focused and fast. The current baseline is a smoke test; add targeted tests when changing decoders, position math, or aggregation logic.
