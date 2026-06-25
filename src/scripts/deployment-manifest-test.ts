import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const DOCKERFILE = 'Dockerfile'
const DOCKERIGNORE = '.dockerignore'
const PRODUCTION_DOC = 'docs/si-production.md'
const RELEASE_CHECKLIST = 'docs/release-checklist.md'
const CI_WORKFLOW = '.github/workflows/ci.yml'

const requiredEnv: Array<[string, string]> = [
  ['NODE_ENV', 'production'],
  ['HOST', '0.0.0.0'],
  ['PORT', '8788'],
  ['SOLANA_RPC_ENDPOINT', 'https://api.mainnet-beta.solana.com'],
  ['CORS_ALLOW_ORIGIN', '*'],
  ['RATE_LIMIT_WINDOW_MS', '60000'],
  ['RATE_LIMIT_MAX', '120'],
  ['RPC_RETRY_ATTEMPTS', '3'],
  ['RPC_RETRY_BASE_DELAY_MS', '250'],
  ['LOG_LEVEL', 'info'],
]

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const readText = (root: string, relativePath: string) => readFileSync(join(root, relativePath), 'utf8')

export function validateDeploymentManifest(root = process.cwd()) {
  const dockerfile = readText(root, DOCKERFILE)
  const dockerignore = readText(root, DOCKERIGNORE)
  const productionDoc = readText(root, PRODUCTION_DOC)
  const releaseChecklist = readText(root, RELEASE_CHECKLIST)
  const ciWorkflow = readText(root, CI_WORKFLOW)

  assert.match(dockerfile, /FROM\s+node:20[^\n]*\s+AS\s+deps/i, 'Dockerfile must pin a Node 20 dependency stage.')
  assert.match(dockerfile, /FROM\s+deps\s+AS\s+build/i, 'Dockerfile must build from the dependency stage.')
  assert.match(dockerfile, /FROM\s+node:20[^\n]*\s+AS\s+runtime/i, 'Dockerfile must use a slim Node 20 runtime stage.')
  assert.match(dockerfile, /\bRUN\s+npm\s+ci\b/i, 'Dockerfile must install from package-lock.json with npm ci.')
  assert.match(dockerfile, /\bRUN\s+npm\s+run\s+build\b/i, 'Dockerfile must compile TypeScript during image build.')
  assert.match(dockerfile, /\bRUN\s+npm\s+prune\s+--omit=dev\b/i, 'Dockerfile must prune dev dependencies from runtime node_modules.')
  assert.match(dockerfile, /\bUSER\s+node\b/i, 'Dockerfile must run as the bundled non-root node user.')
  assert.match(dockerfile, /\bEXPOSE\s+8788\b/, 'Dockerfile must expose port 8788.')
  assert.match(dockerfile, /HEALTHCHECK[\s\S]+\/api\/indexer\/v1\/health/i, 'Dockerfile must healthcheck the v1 health route.')
  assert.match(dockerfile, /CMD\s+\[\s*"npm"\s*,\s*"start"\s*\]/, 'Dockerfile must start with npm start.')
  assert.doesNotMatch(dockerfile, /TON_NETWORK|TON_DATASOURCE|LITESERVER_POOL/i, 'Solswap Dockerfile must not use TON runtime variables.')

  for (const [key, value] of requiredEnv) {
    assert.match(
      dockerfile,
      new RegExp(`${key}\\s*=\\s*"?${escapeRegex(value)}"?`),
      `Dockerfile must set ${key}=${value}.`,
    )
  }

  const ignored = new Set(
    dockerignore
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  )
  for (const pattern of ['.git', 'node_modules', 'dist', 'coverage', '.env', '.env.*']) {
    assert.ok(ignored.has(pattern), `.dockerignore must exclude ${pattern}.`)
  }

  for (const requiredText of [
    'docker build',
    'docker run',
    'SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com',
    'si.soramitsu.io',
    '/api/indexer/v1/service-info',
    'SOLSWAP_INDEXER_BASE_URL=https://si.soramitsu.io npm run smoke:production',
  ]) {
    assert.match(productionDoc, new RegExp(escapeRegex(requiredText)), `Production docs must mention ${requiredText}.`)
  }

  assert.match(
    releaseChecklist,
    /docker build -t solswap-indexer:release \./,
    'Release checklist must require a production Docker image build.',
  )
  assert.match(
    releaseChecklist,
    /Docker\s+image\s+build/i,
    'Release checklist must include the Docker image build in required CI evidence.',
  )
  assert.match(
    ciWorkflow,
    /docker build -t solswap-indexer:ci \./,
    'CI must build the production Docker image.',
  )
}

const writeFixture = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'solswap-indexer-deploy-'))
  for (const [relativePath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relativePath)), { recursive: true })
    writeFileSync(join(root, relativePath), content)
  }
  return root
}

const assertRejectsFixture = (files: Record<string, string>, expected: RegExp) => {
  const root = writeFixture(files)
  try {
    assert.throws(() => validateDeploymentManifest(root), expected)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const main = () => {
  validateDeploymentManifest()

  const actualFiles = {
    [DOCKERFILE]: readText(process.cwd(), DOCKERFILE),
    [DOCKERIGNORE]: readText(process.cwd(), DOCKERIGNORE),
    [PRODUCTION_DOC]: readText(process.cwd(), PRODUCTION_DOC),
    [RELEASE_CHECKLIST]: readText(process.cwd(), RELEASE_CHECKLIST),
    [CI_WORKFLOW]: readText(process.cwd(), CI_WORKFLOW),
  }

  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: actualFiles[DOCKERFILE].replace('EXPOSE 8788', 'EXPOSE 8787'),
    },
    /Dockerfile must expose port 8788/,
  )
  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: actualFiles[DOCKERFILE].replace(
        'SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com',
        'SOLANA_RPC_ENDPOINT=https://example.invalid',
      ),
    },
    /Dockerfile must set SOLANA_RPC_ENDPOINT=https:\/\/api\.mainnet-beta\.solana\.com/,
  )
  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: `${actualFiles[DOCKERFILE]}\nENV TON_NETWORK=mainnet\n`,
    },
    /Solswap Dockerfile must not use TON runtime variables/,
  )
  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERFILE]: actualFiles[DOCKERFILE].replace(/^HEALTHCHECK .*$/m, ''),
    },
    /Dockerfile must healthcheck/,
  )
  assertRejectsFixture(
    {
      ...actualFiles,
      [DOCKERIGNORE]: actualFiles[DOCKERIGNORE].replace(/^node_modules\n/m, ''),
    },
    /\.dockerignore must exclude node_modules/,
  )
  assertRejectsFixture(
    {
      ...actualFiles,
      [PRODUCTION_DOC]: actualFiles[PRODUCTION_DOC].replace(
        'SOLSWAP_INDEXER_BASE_URL=https://si.soramitsu.io npm run smoke:production',
        'npm run smoke:production',
      ),
    },
    /Production docs must mention SOLSWAP_INDEXER_BASE_URL=https:\/\/si\.soramitsu\.io npm run smoke:production/,
  )
  assertRejectsFixture(
    {
      ...actualFiles,
      [RELEASE_CHECKLIST]: actualFiles[RELEASE_CHECKLIST].replace(
        'docker build -t solswap-indexer:release .',
        'npm run build',
      ),
    },
    /Release checklist must require a production Docker image build/,
  )
  assertRejectsFixture(
    {
      ...actualFiles,
      [CI_WORKFLOW]: actualFiles[CI_WORKFLOW].replace('docker build -t solswap-indexer:ci .', 'npm run build'),
    },
    /CI must build the production Docker image/,
  )

  process.stdout.write('solswap deployment manifest tests passed\n')
}

main()
