import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { runProductionSmoke } from './production-smoke'

type Route = {
  status?: number
  contentType?: string
  body: unknown
}

type Routes = Record<string, Route>

const openApiPaths = () => ({
  '/api/indexer/v1/service-info': {},
  '/api/indexer/v1/accounts/{wallet}/balances': {},
  '/api/indexer/v1/accounts/{wallet}/assets': {},
  '/api/indexer/v1/accounts/{wallet}/state': {},
  '/api/indexer/v1/accounts/{wallet}/txs': {},
  '/api/indexer/v1/tokens/{mint}/metadata': {},
  '/api/indexer/v1/tokens/metadata': {},
})

const validRoutes = (): Routes => ({
  '/api/indexer/v1/health': {
    body: {
      ok: true,
      rpcEndpoint: 'http://127.0.0.1:8899',
      syncedAt: 1,
    },
  },
  '/api/indexer/v1/service-info': {
    body: {
      schemaVersion: 1,
      serviceId: 'si.soramitsu.io',
      ecosystem: 'solana',
      chainId: 'solana:mainnet',
      publicBaseUrl: 'https://si.soramitsu.io',
      readOnly: true,
      endpoints: {
        openapi: '/api/indexer/v1/openapi.json',
      },
    },
  },
  '/api/indexer/v1/openapi.json': {
    body: {
      openapi: '3.0.3',
      info: { title: 'Solswap Indexer API' },
      paths: openApiPaths(),
    },
  },
})

const withServer = async (routes: Routes, run: (baseUrl: string) => Promise<void>) => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes[path]
    if (!route) {
      response.statusCode = 404
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: 'not_found' }))
      return
    }

    response.statusCode = route.status ?? 200
    response.setHeader('content-type', route.contentType ?? 'application/json')
    response.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

const assertSmokeRejects = async (routes: Routes, expected: RegExp) => {
  await withServer(routes, async (baseUrl) => {
    await assert.rejects(() => runProductionSmoke(baseUrl), expected)
  })
}

const main = async () => {
  await withServer(validRoutes(), async (baseUrl) => {
    await runProductionSmoke(baseUrl)
  })

  const tonHealth = validRoutes()
  tonHealth['/api/indexer/v1/health'].body = { lastMasterSeqno: 123 }
  await assertSmokeRejects(tonHealth, /Solswap health response must include ok=true/)

  const wrongIdentity = validRoutes()
  wrongIdentity['/api/indexer/v1/service-info'].body = {
    serviceId: 'ti.soramitsu.io',
    ecosystem: 'ton',
    chainId: 'ton:mainnet',
    publicBaseUrl: 'https://ti.soramitsu.io',
    readOnly: true,
    endpoints: {
      openapi: '/api/indexer/v1/openapi.json',
    },
  }
  await assertSmokeRejects(wrongIdentity, /service-info serviceId must be si\.soramitsu\.io/)

  const nonJson = validRoutes()
  nonJson['/api/indexer/v1/health'] = {
    contentType: 'text/plain; charset=utf-8',
    body: 'ok',
  }
  await assertSmokeRejects(nonJson, /\/api\/indexer\/v1\/health did not return JSON/)

  const missingOpenApiPath = validRoutes()
  const spec = missingOpenApiPath['/api/indexer/v1/openapi.json'].body as { paths: Record<string, unknown> }
  delete spec.paths['/api/indexer/v1/tokens/metadata']
  await assertSmokeRejects(missingOpenApiPath, /OpenAPI is missing \/api\/indexer\/v1\/tokens\/metadata/)

  const wrongTitle = validRoutes()
  wrongTitle['/api/indexer/v1/openapi.json'].body = {
    openapi: '3.0.3',
    info: { title: 'TONSWAP Indexer API' },
    paths: openApiPaths(),
  }
  await assertSmokeRejects(wrongTitle, /OpenAPI title must be Solswap Indexer API/)

  process.stdout.write('solswap production smoke adversarial tests passed\n')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
