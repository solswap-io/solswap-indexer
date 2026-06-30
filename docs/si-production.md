# SI Production Deployment

This service is the Solana/Solswap read-only indexer backing `https://si.soramitsu.io`.

## Required Public Contract

- `GET /api/indexer/v1/health` must return a Solswap health payload with `ok=true`.
- `GET /api/indexer/v1/service-info` must identify `si.soramitsu.io`,
  `solana`, and `solana:mainnet`.
- `GET /api/indexer/v1/openapi.json` must expose the `Solswap Indexer API`
  contract. `GET /openapi.json` remains a compatibility alias.
- Wallet read endpoints must stay publicly reachable:
  - `/api/indexer/v1/accounts/{wallet}/balances`
  - `/api/indexer/v1/accounts/{wallet}/assets`
  - `/api/indexer/v1/accounts/{wallet}/state`
  - `/api/indexer/v1/accounts/{wallet}/txs`
  - `/api/indexer/v1/tokens/{mint}/metadata`
  - `/api/indexer/v1/tokens/metadata`
- Solswap analytics endpoints must stay publicly reachable:
  - `/api/indexer/v1/accounts/{wallet}/swaps`
  - `/api/indexer/v1/accounts/{wallet}/spot-positions`
  - `/api/indexer/v1/accounts/{wallet}/pending-intents`
  - `/api/indexer/v1/markets/{marketAddress}/candles`
  - `/api/indexer/v1/markets/{marketAddress}/overview`
- SI is read-only. Transaction simulation and broadcast must use wallet-configured
  Solana RPC endpoints, not SI.

## Required Routing Fix

`https://si.soramitsu.io` must route to this service. If the health payload
contains TON-only fields such as `lastMasterSeqno`, or the OpenAPI title is
`TONSWAP Indexer API`, the host is misrouted.

Do not integrate wallets against SI until the production smoke check passes.

## Recommended Environment

```sh
HOST=0.0.0.0
PORT=8788
SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com
CORS_ALLOW_ORIGIN=*
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120
RPC_RETRY_ATTEMPTS=3
RPC_RETRY_BASE_DELAY_MS=250
LOG_LEVEL=info
```

Configure `BATCH_AUCTION_PROGRAM_ID`, `DLMM_PROGRAM_ID`, `RFQ_PROGRAM_ID`, and
`SS_MINT` when those Solswap analytics routes are production-ready.

## Container Contract

Build the production image from this repo root:

```sh
docker build -t si-indexer:release .
```

Run the image and route `https://si.soramitsu.io` to port `8788`:

```sh
docker run --rm -p 8788:8788 \
  -e SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com \
  -e CORS_ALLOW_ORIGIN=* \
  -e RATE_LIMIT_MAX=120 \
  si-indexer:release
```

The checked-in `Dockerfile` defaults to the public read-only Solana mainnet
configuration. Program IDs can be supplied with environment variables when the
analytics routes are ready for production traffic.

## Preflight

Run before promoting a `master` build:

```sh
npm ci
npm test
npm run build
npm audit --omit=dev
```

## Smoke Checks

After deployment routing is updated:

```sh
npm run smoke:production
SOLSWAP_INDEXER_BASE_URL=https://si.soramitsu.io npm run smoke:production
```

The smoke check validates API identity and required wallet/OpenAPI paths. It
must fail if SI is accidentally routed to the TON indexer.

Deployment evidence is tracked in
`scripts/production-deployment-evidence.json`. Keep it blocked until the Docker
image digest, deployment ID, current release commit, exact smoke command,
operator, and UTC smoke timestamp are recorded together with the production
`/api/indexer/v1/service-info` identity payload observed by the smoke check, and
`npm run audit:deployment-evidence -- --require-ready` passes. The ready audit
compares the evidence commit with the local checkout `HEAD`; set
`DEPLOYMENT_EVIDENCE_EXPECTED_COMMIT` only when release tooling is validating a
specific tagged commit.
Generate a fill-in-ready evidence template before recording the live result:

```sh
npm run test:deployment-evidence-template
npm run generate:deployment-evidence-template -- --output build/reports/production-deployment-evidence-template.json
```
