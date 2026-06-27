import assert from 'node:assert/strict'

import { decodeEpochState } from '../batchAuction'
import { buildApp } from '../index'
import type { Config } from '../config'
import { IndexerService } from '../indexerService'

const VALID_WALLET = '11111111111111111111111111111111'
const VALID_MINT = 'So11111111111111111111111111111111111111112'

function testDecodeEpochState() {
  const data = new Uint8Array(90)
  new DataView(data.buffer).setBigUint64(34, 7n, true)
  data[42] = 1
  new DataView(data.buffer).setBigUint64(66, 12n, true)
  new DataView(data.buffer).setBigUint64(74, 24n, true)
  new DataView(data.buffer).setBigUint64(82, 8n, true)

  const decoded = decodeEpochState(data)
  assert.equal(decoded.epoch, 7n)
  assert.equal(decoded.cleared, true)
  assert.equal(decoded.totalTokenSupply, 12n)
  assert.equal(decoded.totalTokenDemand, 24n)
  assert.equal(decoded.totalTokenCleared, 8n)
}

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 0,
    rpcEndpoint: 'http://127.0.0.1:8899',
    batchAuctionProgramId: null,
    dlmmProgramId: null,
    rfqProgramId: null,
    ssMint: null,
    quoteUsdRate: 1,
    accountScanLimit: 150,
    marketScanLimit: 250,
    cacheTtlMs: 1,
    corsAllowOrigin: '*',
    rateLimitWindowMs: 60_000,
    rateLimitMax: 100,
    rpcRetryAttempts: 3,
    rpcRetryBaseDelayMs: 0,
    ...overrides,
  }
}

function fakeService() {
  return {
    async getWalletBalances(wallet: string) {
      return {
        wallet,
        native: {
          type: 'native' as const,
          mint: 'SOL' as const,
          lamports: '1234567890',
          decimals: 9 as const,
          uiAmountString: '1.23456789',
        },
        tokens: [
          {
            type: 'token' as const,
            accountAddress: VALID_WALLET,
            mint: VALID_MINT,
            owner: wallet,
            program: 'spl-token' as const,
            programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            amount: '18446744073709551616',
            decimals: 9,
            uiAmountString: '18446744073.709551616',
            state: 'initialized',
            isNative: false,
            delegatedAmount: null,
            rentExemptReserve: null,
          },
        ],
        total: 2,
        syncedAt: 1,
      }
    },
    async getWalletAssets(wallet: string) {
      const balances = await this.getWalletBalances(wallet)
      return {
        wallet,
        assets: [balances.native, ...balances.tokens],
        total: 2,
        syncedAt: 1,
      }
    },
    async getWalletState(wallet: string) {
      return {
        wallet,
        exists: false,
        lamports: '0',
        owner: null,
        executable: false,
        rentEpoch: null,
        dataLength: 0,
        syncedAt: 1,
      }
    },
    async getWalletTransactions(wallet: string, before: string | null, limit: number) {
      return {
        wallet,
        before,
        nextBefore: null,
        limit,
        total: 1,
        syncedAt: 1,
        transactions: [
          {
            signature: 'sig',
            slot: 1,
            timestamp: 1,
            status: 'success' as const,
            feeLamports: '5000',
            nativeBalanceChangeLamports: '-5000',
            tokenBalanceChanges: [
              {
                mint: VALID_MINT,
                preAmount: '0',
                postAmount: '18446744073709551616',
                amountDelta: '18446744073709551616',
                decimals: 9,
                uiAmountDeltaString: '18446744073.709551616',
              },
            ],
            programIds: [],
            solswapRoute: null,
          },
        ],
      }
    },
    async getTokenMetadata(mint: string) {
      return {
        mint,
        exists: true,
        program: 'spl-token' as const,
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        extensions: [],
        transferFeeConfig: null,
        transferHook: null,
        decimals: 9,
        supply: '18446744073709551616',
        uiSupplyString: '18446744073.709551616',
        mintAuthority: null,
        freezeAuthority: null,
        isInitialized: true,
        name: null,
        symbol: null,
        uri: null,
        syncedAt: 1,
      }
    },
    async getTokenMetadataBatch(mints: string[]) {
      return {
        total: mints.length,
        syncedAt: 1,
        tokens: await Promise.all(mints.map((mint) => this.getTokenMetadata(mint))),
      }
    },
    async getWalletSwaps(wallet: string) {
      return { wallet, total: 0, syncedAt: 1, swaps: [] }
    },
    async getSpotPositions(wallet: string) {
      return { wallet, total: 0, syncedAt: 1, positions: [] }
    },
    async getPendingIntents(wallet: string, marketAddress: string | null) {
      return { wallet, marketAddress, syncedAt: 1, intents: [] }
    },
    async getMarketCandles(marketAddress: string, interval: any) {
      return { marketAddress, marketKey: 'unknown', interval, syncedAt: 1, candles: [] }
    },
    async getMarketOverview(marketAddress: string) {
      return {
        marketAddress,
        marketKey: 'unknown',
        assetMint: 'unknown',
        quoteMint: 'unknown',
        currentPriceQuote: null,
        currentPriceUsd: null,
        sessionHighQuote: null,
        sessionLowQuote: null,
        sessionChangePct: null,
        demandSkewPct: null,
        currentEpoch: null,
        epochCleared: null,
        totalTokenSupply: null,
        totalTokenDemand: null,
        totalTokenCleared: null,
        syncedAt: 1,
      }
    },
  }
}

async function testWalletRoutes() {
  const app = buildApp(testConfig(), fakeService())

  const balances = await app.inject({ method: 'GET', url: `/api/indexer/v1/accounts/${VALID_WALLET}/balances` })
  assert.equal(balances.statusCode, 200)
  const balancesBody = balances.json()
  assert.equal(balancesBody.native.lamports, '1234567890')
  assert.equal(balancesBody.tokens[0].amount, '18446744073709551616')

  const assets = await app.inject({ method: 'GET', url: `/api/indexer/v1/accounts/${VALID_WALLET}/assets` })
  assert.equal(assets.statusCode, 200)
  assert.equal(assets.json().assets.length, 2)

  const txs = await app.inject({ method: 'GET', url: `/api/indexer/v1/accounts/${VALID_WALLET}/txs?limit=1` })
  assert.equal(txs.statusCode, 200)
  assert.equal(txs.json().transactions[0].tokenBalanceChanges[0].amountDelta, '18446744073709551616')

  const metadata = await app.inject({ method: 'GET', url: `/api/indexer/v1/tokens/${VALID_MINT}/metadata` })
  assert.equal(metadata.statusCode, 200)
  assert.equal(metadata.json().supply, '18446744073709551616')

  const batch = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/tokens/metadata',
    payload: { mints: [VALID_MINT] },
  })
  assert.equal(batch.statusCode, 200)
  assert.equal(batch.json().total, 1)

  const openapi = await app.inject({ method: 'GET', url: '/api/indexer/v1/openapi.json' })
  assert.equal(openapi.statusCode, 200)
  assert.ok(openapi.json().paths['/api/indexer/v1/accounts/{wallet}/balances'])
  assert.ok(openapi.json().paths['/api/indexer/v1/service-info'])

  const legacyOpenapi = await app.inject({ method: 'GET', url: '/openapi.json' })
  assert.equal(legacyOpenapi.statusCode, 200)

  const serviceInfo = await app.inject({ method: 'GET', url: '/api/indexer/v1/service-info' })
  assert.equal(serviceInfo.statusCode, 200)
  assert.equal(serviceInfo.json().serviceId, 'si.soramitsu.io')
  assert.equal(serviceInfo.json().ecosystem, 'solana')
  assert.equal(serviceInfo.json().chainId, 'solana:mainnet')
  assert.equal(serviceInfo.json().publicBaseUrl, 'https://si.soramitsu.io')
  assert.equal(serviceInfo.json().readOnly, true)
  assert.equal(serviceInfo.json().endpoints.openapi, '/api/indexer/v1/openapi.json')

  await app.close()
}

async function testNegativeRoutes() {
  const app = buildApp(testConfig(), fakeService())

  const invalidWallet = await app.inject({ method: 'GET', url: '/api/indexer/v1/accounts/not-a-key/balances' })
  assert.equal(invalidWallet.statusCode, 400)
  assert.equal(invalidWallet.json().error, 'invalid_wallet')

  const invalidLimit = await app.inject({ method: 'GET', url: `/api/indexer/v1/accounts/${VALID_WALLET}/txs?limit=0` })
  assert.equal(invalidLimit.statusCode, 400)
  assert.equal(invalidLimit.json().error, 'invalid_limit')

  const oversizedLimit = await app.inject({ method: 'GET', url: `/api/indexer/v1/accounts/${VALID_WALLET}/txs?limit=999999` })
  assert.equal(oversizedLimit.statusCode, 400)
  assert.equal(oversizedLimit.json().error, 'invalid_limit')

  const invalidBefore = await app.inject({ method: 'GET', url: `/api/indexer/v1/accounts/${VALID_WALLET}/txs?before=../../../bad` })
  assert.equal(invalidBefore.statusCode, 400)
  assert.equal(invalidBefore.json().error, 'invalid_before')

  const invalidBatch = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/tokens/metadata',
    payload: { mints: [] },
  })
  assert.equal(invalidBatch.statusCode, 400)
  assert.equal(invalidBatch.json().error, 'invalid_mints')

  const nonStringMint = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/tokens/metadata',
    payload: { mints: [VALID_MINT, 123] },
  })
  assert.equal(nonStringMint.statusCode, 400)
  assert.equal(nonStringMint.json().error, 'invalid_mints')

  const tooManyMints = await app.inject({
    method: 'POST',
    url: '/api/indexer/v1/tokens/metadata',
    payload: { mints: Array.from({ length: 101 }, () => VALID_MINT) },
  })
  assert.equal(tooManyMints.statusCode, 400)
  assert.equal(tooManyMints.json().error, 'invalid_mints')

  await app.close()
}

async function testRateLimit() {
  const app = buildApp(testConfig({ rateLimitMax: 1 }), fakeService())
  const first = await app.inject({ method: 'GET', url: `/api/indexer/v1/accounts/${VALID_WALLET}/state` })
  assert.equal(first.statusCode, 200)
  const second = await app.inject({ method: 'GET', url: `/api/indexer/v1/accounts/${VALID_WALLET}/state` })
  assert.equal(second.statusCode, 429)
  assert.equal(second.json().error, 'rate_limit_exceeded')
  await app.close()
}

async function testRpcRetry() {
  const service = new IndexerService(testConfig({ rpcRetryAttempts: 3, rpcRetryBaseDelayMs: 0 }))
  let attempts = 0
  ;(service as any).connection = {
    async getAccountInfo() {
      attempts += 1
      if (attempts < 3) {
        const error = new Error('temporarily unavailable')
        ;(error as any).status = 503
        throw error
      }
      return null
    },
  }

  const response = await service.getWalletState(VALID_WALLET)
  assert.equal(response.exists, false)
  assert.equal(attempts, 3)
}

async function main() {
  testDecodeEpochState()
  await testWalletRoutes()
  await testNegativeRoutes()
  await testRateLimit()
  await testRpcRetry()
  process.stdout.write('solswap-indexer smoke tests passed\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
