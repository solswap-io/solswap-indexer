import assert from 'node:assert/strict'

type OpenApiSpec = {
  info?: {
    title?: string
  }
  paths?: Record<string, unknown>
}

type ServiceInfo = {
  serviceId?: unknown
  ecosystem?: unknown
  chainId?: unknown
  publicBaseUrl?: unknown
  readOnly?: unknown
  endpoints?: {
    openapi?: unknown
  }
}

const DEFAULT_BASE_URL = 'https://si.soramitsu.io'

export function normalizeBaseUrl(value: string): URL {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}

function endpoint(baseUrl: URL, path: string): URL {
  const url = new URL(baseUrl.toString())
  url.pathname = `${baseUrl.pathname}${path}`.replace(/\/{2,}/g, '/')
  return url
}

async function fetchJson(baseUrl: URL, path: string): Promise<unknown> {
  const response = await fetch(endpoint(baseUrl, path), {
    headers: { accept: 'application/json' },
  })
  assert.equal(response.ok, true, `${path} returned HTTP ${response.status}`)
  const contentType = response.headers.get('content-type') ?? ''
  assert.match(contentType, /application\/json/i, `${path} did not return JSON`)
  return response.json()
}

function assertPath(spec: OpenApiSpec, path: string) {
  assert.ok(spec.paths?.[path], `OpenAPI is missing ${path}`)
}

export async function runProductionSmoke(baseUrlInput = process.env.SOLSWAP_INDEXER_BASE_URL || DEFAULT_BASE_URL) {
  const baseUrl = normalizeBaseUrl(baseUrlInput)
  const health = await fetchJson(baseUrl, '/api/indexer/v1/health') as { ok?: unknown; lastMasterSeqno?: unknown }
  assert.equal(health.ok, true, 'Solswap health response must include ok=true')
  assert.equal(
    'lastMasterSeqno' in health,
    false,
    'Solswap health response looks like the TON indexer contract',
  )

  const serviceInfo = await fetchJson(baseUrl, '/api/indexer/v1/service-info') as ServiceInfo
  assert.equal(serviceInfo.serviceId, 'si.soramitsu.io', 'service-info serviceId must be si.soramitsu.io')
  assert.equal(serviceInfo.ecosystem, 'solana', 'service-info ecosystem must be solana')
  assert.equal(serviceInfo.chainId, 'solana:mainnet', 'service-info chainId must be solana:mainnet')
  assert.equal(
    serviceInfo.publicBaseUrl,
    'https://si.soramitsu.io',
    'service-info publicBaseUrl must be https://si.soramitsu.io',
  )
  assert.equal(serviceInfo.readOnly, true, 'service-info readOnly must be true')
  assert.equal(
    serviceInfo.endpoints?.openapi,
    '/api/indexer/v1/openapi.json',
    'service-info openapi endpoint must be /api/indexer/v1/openapi.json',
  )

  const spec = await fetchJson(baseUrl, '/api/indexer/v1/openapi.json') as OpenApiSpec
  assert.equal(spec.info?.title, 'Solswap Indexer API', 'OpenAPI title must be Solswap Indexer API')
  assertPath(spec, '/api/indexer/v1/service-info')
  assertPath(spec, '/api/indexer/v1/accounts/{wallet}/balances')
  assertPath(spec, '/api/indexer/v1/accounts/{wallet}/assets')
  assertPath(spec, '/api/indexer/v1/accounts/{wallet}/state')
  assertPath(spec, '/api/indexer/v1/accounts/{wallet}/txs')
  assertPath(spec, '/api/indexer/v1/tokens/{mint}/metadata')
  assertPath(spec, '/api/indexer/v1/tokens/metadata')

  process.stdout.write(`solswap production smoke ok: ${baseUrl.toString()}\n`)
}

if (require.main === module) {
  const baseUrlInput = process.argv[2] || process.env.SOLSWAP_INDEXER_BASE_URL || DEFAULT_BASE_URL
  runProductionSmoke(baseUrlInput).catch((error) => {
    console.error(`solswap production smoke failed for ${normalizeBaseUrl(baseUrlInput).toString()}`)
    console.error(error)
    process.exit(1)
  })
}
