import Fastify, { type FastifyReply } from 'fastify'
import pino from 'pino'
import { PublicKey } from '@solana/web3.js'

import { loadConfig, type Config } from './config'
import { IndexerService } from './indexerService'
import type { CandleInterval } from './models'
import { openApiSpec } from './openapi'

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
})

const allowedIntervals = new Set<CandleInterval>(['1m', '5m', '15m', '1h', '4h', '1d'])

type IndexerServiceApi = Pick<
  IndexerService,
  | 'getWalletBalances'
  | 'getWalletAssets'
  | 'getWalletState'
  | 'getWalletTransactions'
  | 'getTokenMetadata'
  | 'getTokenMetadataBatch'
  | 'getWalletSwaps'
  | 'getSpotPositions'
  | 'getPendingIntents'
  | 'getMarketCandles'
  | 'getMarketOverview'
>

type RateBucket = {
  resetAt: number
  remaining: number
}

function normalizePublicKey(value: unknown, reply: FastifyReply): string | null {
  if (typeof value !== 'string') {
    reply.status(400)
    return null
  }
  try {
    return new PublicKey(value).toBase58()
  } catch {
    reply.status(400)
    return null
  }
}

function queryString(value: unknown): string | undefined | null {
  if (value == null) return undefined
  return typeof value === 'string' ? value : null
}

function normalizeSignature(value: unknown, reply: FastifyReply): string | null {
  const signature = queryString(value)
  if (signature === undefined) return null
  if (!signature || !/^[1-9A-HJ-NP-Za-km-z]{64,128}$/.test(signature)) {
    reply.status(400)
    return null
  }
  return signature
}

function parseLimit(value: unknown, fallback: number, max: number): number | null {
  const raw = queryString(value)
  if (raw === null) return null
  if (raw === undefined || raw.trim().length === 0) return fallback
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) return null
  return Math.min(parsed, max)
}

function errorBody(error: string) {
  return { error }
}

export function buildApp(config: Config = loadConfig(), service: IndexerServiceApi = new IndexerService(config)) {
  const app = Fastify({ logger: false })
  const rateBuckets = new Map<string, RateBucket>()
  const serviceInfo = {
    schemaVersion: 1,
    serviceId: 'si.soramitsu.io',
    serviceName: 'Solswap Indexer',
    ecosystem: 'solana',
    chainId: 'solana:mainnet',
    network: 'mainnet',
    publicBaseUrl: 'https://si.soramitsu.io',
    readOnly: true,
    capabilities: [
      'wallet-balances',
      'wallet-assets',
      'wallet-state',
      'wallet-transactions',
      'token-metadata',
      'token-metadata-batch',
      'token-2022-extension-metadata',
      'solswap-swaps',
      'spot-positions',
      'pending-intents',
      'market-candles',
      'market-overview',
    ],
    endpoints: {
      health: '/api/indexer/v1/health',
      openapi: '/api/indexer/v1/openapi.json',
      balances: '/api/indexer/v1/accounts/{wallet}/balances',
      assets: '/api/indexer/v1/accounts/{wallet}/assets',
      state: '/api/indexer/v1/accounts/{wallet}/state',
      transactions: '/api/indexer/v1/accounts/{wallet}/txs',
      tokenMetadata: '/api/indexer/v1/tokens/{mint}/metadata',
      tokenMetadataBatch: '/api/indexer/v1/tokens/metadata',
      swaps: '/api/indexer/v1/accounts/{wallet}/swaps',
      spotPositions: '/api/indexer/v1/accounts/{wallet}/spot-positions',
      pendingIntents: '/api/indexer/v1/accounts/{wallet}/pending-intents',
      marketCandles: '/api/indexer/v1/markets/{marketAddress}/candles',
      marketOverview: '/api/indexer/v1/markets/{marketAddress}/overview',
    },
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('access-control-allow-origin', config.corsAllowOrigin)
    reply.header('access-control-allow-methods', 'GET,POST,OPTIONS')
    reply.header('access-control-allow-headers', 'content-type')

    if (request.method === 'OPTIONS') {
      return reply.status(204).send()
    }

    if (config.rateLimitMax <= 0 || request.url === '/api/indexer/v1/health') return

    const now = Date.now()
    const key = request.ip ?? 'unknown'
    const existing = rateBuckets.get(key)
    const bucket =
      existing && existing.resetAt > now
        ? existing
        : {
            resetAt: now + config.rateLimitWindowMs,
            remaining: config.rateLimitMax,
          }

    bucket.remaining -= 1
    rateBuckets.set(key, bucket)
    reply.header('x-ratelimit-limit', config.rateLimitMax.toString())
    reply.header('x-ratelimit-remaining', Math.max(0, bucket.remaining).toString())
    reply.header('x-ratelimit-reset', Math.ceil(bucket.resetAt / 1000).toString())

    if (bucket.remaining < 0) {
      reply.header('retry-after', Math.ceil((bucket.resetAt - now) / 1000).toString())
      return reply.status(429).send(errorBody('rate_limit_exceeded'))
    }
  })

  app.setErrorHandler((error, _request, reply) => {
    logger.error({ error }, 'request failed')
    reply.status(500).send(errorBody('internal_error'))
  })

  app.get('/api/indexer/v1/health', async () => ({
    ok: true,
    rpcEndpoint: config.rpcEndpoint,
    syncedAt: Math.floor(Date.now() / 1000),
  }))

  app.get('/api/indexer/v1/service-info', async () => serviceInfo)

  app.get('/api/indexer/v1/accounts/:wallet/balances', async (request, reply) => {
    const params = request.params as { wallet: string }
    const wallet = normalizePublicKey(params.wallet, reply)
    if (!wallet) return errorBody('invalid_wallet')
    return service.getWalletBalances(wallet)
  })

  app.get('/api/indexer/v1/accounts/:wallet/assets', async (request, reply) => {
    const params = request.params as { wallet: string }
    const wallet = normalizePublicKey(params.wallet, reply)
    if (!wallet) return errorBody('invalid_wallet')
    return service.getWalletAssets(wallet)
  })

  app.get('/api/indexer/v1/accounts/:wallet/state', async (request, reply) => {
    const params = request.params as { wallet: string }
    const wallet = normalizePublicKey(params.wallet, reply)
    if (!wallet) return errorBody('invalid_wallet')
    return service.getWalletState(wallet)
  })

  app.get('/api/indexer/v1/accounts/:wallet/txs', async (request, reply) => {
    const params = request.params as { wallet: string }
    const query = request.query as { before?: unknown; limit?: unknown }
    const wallet = normalizePublicKey(params.wallet, reply)
    if (!wallet) return errorBody('invalid_wallet')
    const limit = parseLimit(query.limit, 50, Math.min(config.accountScanLimit, 250))
    if (limit == null) {
      reply.status(400)
      return errorBody('invalid_limit')
    }
    const before = normalizeSignature(query.before, reply)
    if (query.before != null && before == null) return errorBody('invalid_before')
    return service.getWalletTransactions(wallet, before, limit)
  })

  app.get('/api/indexer/v1/tokens/:mint/metadata', async (request, reply) => {
    const params = request.params as { mint: string }
    const mint = normalizePublicKey(params.mint, reply)
    if (!mint) return errorBody('invalid_mint')
    return service.getTokenMetadata(mint)
  })

  app.post('/api/indexer/v1/tokens/metadata', async (request, reply) => {
    const body = request.body as { mints?: unknown } | undefined
    if (!Array.isArray(body?.mints) || body.mints.length === 0 || body.mints.length > 100) {
      reply.status(400)
      return errorBody('invalid_mints')
    }

    const mints: string[] = []
    for (const mintValue of body.mints) {
      if (typeof mintValue !== 'string') {
        reply.status(400)
        return errorBody('invalid_mints')
      }
      const mint = normalizePublicKey(mintValue, reply)
      if (!mint) return errorBody('invalid_mint')
      mints.push(mint)
    }

    return service.getTokenMetadataBatch(mints)
  })

  app.get('/api/indexer/v1/accounts/:wallet/swaps', async (request, reply) => {
    const params = request.params as { wallet: string }
    const query = request.query as { marketKey?: string }
    const wallet = normalizePublicKey(params.wallet, reply)
    if (!wallet) return errorBody('invalid_wallet')
    return service.getWalletSwaps(wallet, query.marketKey ?? null)
  })

  app.get('/api/indexer/v1/accounts/:wallet/spot-positions', async (request, reply) => {
    const params = request.params as { wallet: string }
    const wallet = normalizePublicKey(params.wallet, reply)
    if (!wallet) return errorBody('invalid_wallet')
    return service.getSpotPositions(wallet)
  })

  app.get('/api/indexer/v1/accounts/:wallet/pending-intents', async (request, reply) => {
    const params = request.params as { wallet: string }
    const query = request.query as { marketAddress?: string }
    const wallet = normalizePublicKey(params.wallet, reply)
    if (!wallet) return errorBody('invalid_wallet')
    if (query.marketAddress && !normalizePublicKey(query.marketAddress, reply)) {
      return errorBody('invalid_market')
    }
    return service.getPendingIntents(wallet, query.marketAddress ?? null)
  })

  app.get('/api/indexer/v1/markets/:marketAddress/candles', async (request, reply) => {
    const params = request.params as { marketAddress: string }
    const query = request.query as { interval?: CandleInterval; limit?: unknown }
    const marketAddress = normalizePublicKey(params.marketAddress, reply)
    if (!marketAddress) return errorBody('invalid_market')
    const interval = query.interval && allowedIntervals.has(query.interval) ? query.interval : '1h'
    const limit = parseLimit(query.limit, 120, 500)
    if (limit == null) {
      reply.status(400)
      return errorBody('invalid_limit')
    }
    return service.getMarketCandles(marketAddress, interval, limit)
  })

  app.get('/api/indexer/v1/markets/:marketAddress/overview', async (request, reply) => {
    const params = request.params as { marketAddress: string }
    const marketAddress = normalizePublicKey(params.marketAddress, reply)
    if (!marketAddress) return errorBody('invalid_market')
    return service.getMarketOverview(marketAddress)
  })

  app.get('/api/indexer/v1/metrics', async (_request, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4')
    return [
      '# HELP solswap_indexer_uptime_seconds Process uptime in seconds.',
      '# TYPE solswap_indexer_uptime_seconds gauge',
      `solswap_indexer_uptime_seconds ${Math.floor(process.uptime())}`,
      '',
    ].join('\n')
  })

  app.get('/api/indexer/v1/openapi.json', async () => openApiSpec)
  app.get('/openapi.json', async () => openApiSpec)
  app.get('/docs', async (_request, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8')
    return '<!doctype html><html><head><title>Solswap Indexer API</title></head><body><h1>Solswap Indexer API</h1><p>OpenAPI: <a href="/api/indexer/v1/openapi.json">/api/indexer/v1/openapi.json</a></p></body></html>'
  })

  return app
}

async function start() {
  const config = loadConfig()
  const service = new IndexerService(config)
  const app = buildApp(config, service)

  await app.listen({ host: config.host, port: config.port })
  logger.info({ host: config.host, port: config.port, rpcEndpoint: config.rpcEndpoint }, 'solswap-indexer started')
}

if (require.main === module) {
  start().catch((error) => {
    logger.error({ error }, 'solswap-indexer failed to start')
    process.exit(1)
  })
}
