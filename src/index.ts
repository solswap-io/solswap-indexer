import Fastify from 'fastify'
import pino from 'pino'

import { loadConfig } from './config'
import { IndexerService } from './indexerService'
import type { CandleInterval } from './models'

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
})

const allowedIntervals = new Set<CandleInterval>(['1m', '5m', '15m', '1h', '4h', '1d'])

async function start() {
  const config = loadConfig()
  const service = new IndexerService(config)
  const app = Fastify({ logger: false })

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('access-control-allow-origin', config.corsAllowOrigin)
    reply.header('access-control-allow-methods', 'GET,OPTIONS')
    reply.header('access-control-allow-headers', 'content-type')
    if (_request.method === 'OPTIONS') {
      reply.status(204).send()
    }
  })

  app.get('/api/indexer/v1/health', async () => ({
    ok: true,
    rpcEndpoint: config.rpcEndpoint,
    syncedAt: Math.floor(Date.now() / 1000),
  }))

  app.get('/api/indexer/v1/accounts/:wallet/swaps', async (request) => {
    const params = request.params as { wallet: string }
    const query = request.query as { marketKey?: string }
    return service.getWalletSwaps(params.wallet, query.marketKey ?? null)
  })

  app.get('/api/indexer/v1/accounts/:wallet/spot-positions', async (request) => {
    const params = request.params as { wallet: string }
    return service.getSpotPositions(params.wallet)
  })

  app.get('/api/indexer/v1/accounts/:wallet/pending-intents', async (request) => {
    const params = request.params as { wallet: string }
    const query = request.query as { marketAddress?: string }
    return service.getPendingIntents(params.wallet, query.marketAddress ?? null)
  })

  app.get('/api/indexer/v1/markets/:marketAddress/candles', async (request, reply) => {
    const params = request.params as { marketAddress: string }
    const query = request.query as { interval?: CandleInterval; limit?: string }
    const interval = query.interval && allowedIntervals.has(query.interval) ? query.interval : '1h'
    const limit = Number.parseInt(query.limit ?? '120', 10)
    if (!Number.isFinite(limit) || limit <= 0) {
      reply.status(400)
      return { error: 'invalid_limit' }
    }
    return service.getMarketCandles(params.marketAddress, interval, Math.min(limit, 500))
  })

  app.get('/api/indexer/v1/markets/:marketAddress/overview', async (request) => {
    const params = request.params as { marketAddress: string }
    return service.getMarketOverview(params.marketAddress)
  })

  await app.listen({ host: config.host, port: config.port })
  logger.info({ host: config.host, port: config.port, rpcEndpoint: config.rpcEndpoint }, 'solswap-indexer started')
}

start().catch((error) => {
  logger.error({ error }, 'solswap-indexer failed to start')
  process.exit(1)
})
