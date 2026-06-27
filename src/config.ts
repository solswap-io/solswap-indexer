import { clusterApiUrl, PublicKey } from '@solana/web3.js'

export type Config = {
  host: string
  port: number
  rpcEndpoint: string
  batchAuctionProgramId: PublicKey | null
  dlmmProgramId: PublicKey | null
  rfqProgramId: PublicKey | null
  ssMint: PublicKey | null
  quoteUsdRate: number
  accountScanLimit: number
  marketScanLimit: number
  cacheTtlMs: number
  corsAllowOrigin: string
  rateLimitWindowMs: number
  rateLimitMax: number
  rpcRetryAttempts: number
  rpcRetryBaseDelayMs: number
}

function envString(key: string): string | null {
  const raw = process.env[key]
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return value.length > 0 ? value : null
}

function envInt(key: string, fallback: number): number {
  const raw = envString(key)
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : fallback
}

function envFloat(key: string, fallback: number): number {
  const raw = envString(key)
  if (!raw) return fallback
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : fallback
}

function envPubkey(key: string): PublicKey | null {
  const raw = envString(key)
  if (!raw) return null
  try {
    return new PublicKey(raw)
  } catch {
    return null
  }
}

export function loadConfig(): Config {
  return {
    host: envString('HOST') ?? '0.0.0.0',
    port: envInt('PORT', 8788),
    rpcEndpoint: envString('SOLANA_RPC_ENDPOINT') ?? clusterApiUrl('mainnet-beta'),
    batchAuctionProgramId: envPubkey('BATCH_AUCTION_PROGRAM_ID'),
    dlmmProgramId: envPubkey('DLMM_PROGRAM_ID'),
    rfqProgramId: envPubkey('RFQ_PROGRAM_ID'),
    ssMint: envPubkey('SS_MINT'),
    quoteUsdRate: envFloat('QUOTE_USD_RATE', 1),
    accountScanLimit: envInt('ACCOUNT_SCAN_LIMIT', 150),
    marketScanLimit: envInt('MARKET_SCAN_LIMIT', 250),
    cacheTtlMs: envInt('CACHE_TTL_MS', 15_000),
    corsAllowOrigin: envString('CORS_ALLOW_ORIGIN') ?? '*',
    rateLimitWindowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000),
    rateLimitMax: envInt('RATE_LIMIT_MAX', 120),
    rpcRetryAttempts: envInt('RPC_RETRY_ATTEMPTS', 3),
    rpcRetryBaseDelayMs: envInt('RPC_RETRY_BASE_DELAY_MS', 250),
  }
}
