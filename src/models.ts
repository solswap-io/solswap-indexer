export type SpotRoute = 'batch' | 'dlmm' | 'rfq'
export type SwapRecordStatus = 'success' | 'failed'
export type SpotSide = 'buy' | 'sell' | 'swap'
export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

export type WalletSwapRecord = {
  id: string
  signature: string
  slot: number
  timestamp: number
  status: SwapRecordStatus
  route: SpotRoute
  marketKey: string
  assetMint: string | null
  quoteMint: string | null
  payMint: string | null
  receiveMint: string | null
  payAmount: number | null
  receiveAmount: number | null
  side: SpotSide
  qty: number | null
  priceQuote: number | null
  notionalQuote: number | null
  priceUsd: number | null
  notionalUsd: number | null
}

export type SpotPositionSummary = {
  marketKey: string
  assetMint: string
  quoteMint: string
  qty: number
  avgEntryQuote: number | null
  avgEntryUsd: number | null
  lastPriceQuote: number | null
  lastPriceUsd: number | null
  realizedPnlQuote: number
  realizedPnlUsd: number
  unrealizedPnlQuote: number
  unrealizedPnlUsd: number
  buyQty: number
  sellQty: number
  routeCounts: Record<SpotRoute, number>
  lastTimestamp: number
}

export type PendingIntentSummary = {
  id: string
  marketAddress: string
  wallet: string
  epoch: string
  side: 'buy' | 'sell'
  amountIn: string
  minOut: string
  filledIn: string
  amountOut: string
  refundIn: string
  priceQuote: number | null
  cleared: boolean
  cancelled: boolean
  claimed: boolean
}

export type MarketCandle = {
  ts: number
  open: number
  high: number
  low: number
  close: number
  volumeBase: number
  volumeQuote: number
  volumeUsd: number | null
  tradeCount: number
}

export type MarketOverview = {
  marketAddress: string
  marketKey: string
  assetMint: string
  quoteMint: string
  currentPriceQuote: number | null
  currentPriceUsd: number | null
  sessionHighQuote: number | null
  sessionLowQuote: number | null
  sessionChangePct: number | null
  demandSkewPct: number | null
  currentEpoch: string | null
  epochCleared: boolean | null
  totalTokenSupply: string | null
  totalTokenDemand: string | null
  totalTokenCleared: string | null
  syncedAt: number
}

export type WalletSwapsResponse = {
  wallet: string
  total: number
  syncedAt: number
  swaps: WalletSwapRecord[]
}

export type SpotPositionsResponse = {
  wallet: string
  total: number
  syncedAt: number
  positions: SpotPositionSummary[]
}

export type PendingIntentsResponse = {
  wallet: string
  marketAddress: string | null
  syncedAt: number
  intents: PendingIntentSummary[]
}

export type MarketCandlesResponse = {
  marketAddress: string
  marketKey: string
  interval: CandleInterval
  syncedAt: number
  candles: MarketCandle[]
}
