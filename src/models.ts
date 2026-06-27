export type SpotRoute = 'batch' | 'dlmm' | 'rfq'
export type SwapRecordStatus = 'success' | 'failed'
export type SpotSide = 'buy' | 'sell' | 'swap'
export type CandleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'
export type SolanaTokenProgram = 'spl-token' | 'token-2022'
export type SolanaTransactionStatus = 'success' | 'failed'

export type TokenTransferFee = {
  epoch: string | null
  maximumFee: string | null
  transferFeeBasisPoints: number | null
}

export type TokenTransferFeeConfig = {
  transferFeeConfigAuthority: string | null
  withdrawWithheldAuthority: string | null
  withheldAmount: string | null
  olderTransferFee: TokenTransferFee | null
  newerTransferFee: TokenTransferFee | null
}

export type TokenTransferHook = {
  authority: string | null
  programId: string | null
  extraAccountMetasAddress: string | null
}

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

export type SolanaNativeBalance = {
  type: 'native'
  mint: 'SOL'
  lamports: string
  decimals: 9
  uiAmountString: string
}

export type SolanaTokenBalance = {
  type: 'token'
  accountAddress: string
  mint: string
  owner: string
  program: SolanaTokenProgram
  programId: string
  amount: string
  decimals: number
  uiAmountString: string
  state: string | null
  isNative: boolean
  delegatedAmount: string | null
  rentExemptReserve: string | null
}

export type WalletBalancesResponse = {
  wallet: string
  native: SolanaNativeBalance
  tokens: SolanaTokenBalance[]
  total: number
  syncedAt: number
}

export type WalletAsset = SolanaNativeBalance | SolanaTokenBalance

export type WalletAssetsResponse = {
  wallet: string
  assets: WalletAsset[]
  total: number
  syncedAt: number
}

export type WalletStateResponse = {
  wallet: string
  exists: boolean
  lamports: string
  owner: string | null
  executable: boolean
  rentEpoch: string | null
  dataLength: number
  syncedAt: number
}

export type TokenBalanceChange = {
  mint: string
  preAmount: string
  postAmount: string
  amountDelta: string
  decimals: number
  uiAmountDeltaString: string
}

export type WalletTransactionRecord = {
  signature: string
  slot: number
  timestamp: number
  status: SolanaTransactionStatus
  feeLamports: string | null
  nativeBalanceChangeLamports: string | null
  tokenBalanceChanges: TokenBalanceChange[]
  programIds: string[]
  solswapRoute: SpotRoute | null
}

export type WalletTransactionsResponse = {
  wallet: string
  before: string | null
  nextBefore: string | null
  limit: number
  total: number
  syncedAt: number
  transactions: WalletTransactionRecord[]
}

export type TokenMetadata = {
  mint: string
  exists: boolean
  program: SolanaTokenProgram | 'unknown'
  programId: string | null
  extensions: string[]
  transferFeeConfig: TokenTransferFeeConfig | null
  transferHook: TokenTransferHook | null
  decimals: number | null
  supply: string | null
  uiSupplyString: string | null
  mintAuthority: string | null
  freezeAuthority: string | null
  isInitialized: boolean | null
  name: string | null
  symbol: string | null
  uri: string | null
  syncedAt: number
}

export type TokenMetadataResponse = TokenMetadata

export type TokenMetadataBatchResponse = {
  total: number
  syncedAt: number
  tokens: TokenMetadata[]
}
