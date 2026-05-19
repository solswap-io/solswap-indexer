import {
  Connection,
  type ParsedTransactionWithMeta,
  PublicKey,
  type TokenBalance,
} from '@solana/web3.js'

import { decodeEpochState, decodeIntent, decodeMarketConfig, batchEpochPda, batchIntentPda, currentEpochForSlot } from './batchAuction'
import type {
  CandleInterval,
  MarketCandle,
  MarketCandlesResponse,
  MarketOverview,
  PendingIntentSummary,
  PendingIntentsResponse,
  SpotPositionSummary,
  SpotRoute,
  WalletSwapRecord,
  WalletSwapsResponse,
  SpotPositionsResponse,
} from './models'
import type { Config } from './config'

type CacheEntry<T> = {
  expiresAt: number
  value: T
}

type RouteConfig = Record<SpotRoute, string | null>

const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
}

export class IndexerService {
  private readonly connection: Connection
  private readonly cache = new Map<string, CacheEntry<unknown>>()
  private readonly routePrograms: RouteConfig
  private readonly quoteMint: string | null

  constructor(private readonly config: Config) {
    this.connection = new Connection(config.rpcEndpoint, 'confirmed')
    this.routePrograms = {
      batch: config.batchAuctionProgramId?.toBase58() ?? null,
      dlmm: config.dlmmProgramId?.toBase58() ?? null,
      rfq: config.rfqProgramId?.toBase58() ?? null,
    }
    this.quoteMint = config.ssMint?.toBase58() ?? null
  }

  async getWalletSwaps(walletAddress: string, marketKey?: string | null): Promise<WalletSwapsResponse> {
    const wallet = new PublicKey(walletAddress)
    const cacheKey = `wallet-swaps:${wallet.toBase58()}:${marketKey ?? ''}`
    return this.memoize(cacheKey, async () => {
      const signatures = await this.connection.getSignaturesForAddress(wallet, {
        limit: this.config.accountScanLimit,
      })
      const parsedTransactions = await this.loadParsedTransactions(signatures.map((entry) => entry.signature))
      const swaps = parsedTransactions
        .map((tx) => this.extractWalletSwap(tx, wallet.toBase58()))
        .filter((entry): entry is WalletSwapRecord => !!entry)
        .filter((entry) => !marketKey || entry.marketKey === marketKey)
        .sort((a, b) => b.timestamp - a.timestamp)

      return {
        wallet: wallet.toBase58(),
        total: swaps.length,
        syncedAt: Math.floor(Date.now() / 1000),
        swaps,
      }
    })
  }

  async getSpotPositions(walletAddress: string): Promise<SpotPositionsResponse> {
    const swapsResponse = await this.getWalletSwaps(walletAddress)
    const positions = this.summarizePositions(swapsResponse.swaps)
    return {
      wallet: swapsResponse.wallet,
      total: positions.length,
      syncedAt: swapsResponse.syncedAt,
      positions,
    }
  }

  async getPendingIntents(walletAddress: string, marketAddress?: string | null): Promise<PendingIntentsResponse> {
    const wallet = new PublicKey(walletAddress)
    if (!this.config.batchAuctionProgramId || !marketAddress) {
      return {
        wallet: wallet.toBase58(),
        marketAddress: marketAddress ?? null,
        syncedAt: Math.floor(Date.now() / 1000),
        intents: [],
      }
    }

    const cacheKey = `pending-intents:${wallet.toBase58()}:${marketAddress}`
    return this.memoize(cacheKey, async () => {
      const market = new PublicKey(marketAddress)
      const marketAccount = await this.connection.getAccountInfo(market, 'confirmed')
      if (!marketAccount) {
        return {
          wallet: wallet.toBase58(),
          marketAddress,
          syncedAt: Math.floor(Date.now() / 1000),
          intents: [],
        }
      }

      const marketConfig = decodeMarketConfig(Uint8Array.from(marketAccount.data))
      const slot = BigInt(await this.connection.getSlot('confirmed'))
      const currentEpoch = currentEpochForSlot(slot, marketConfig.scheduleStartSlot, marketConfig.auctionDurationSlots)
      const epochs = [currentEpoch - 1n, currentEpoch, currentEpoch + 1n].filter((value) => value >= 0n)
      const pdas = epochs.map((epoch) => batchIntentPda(this.config.batchAuctionProgramId as PublicKey, market, wallet, epoch))
      const accounts = await this.connection.getMultipleAccountsInfo(pdas, 'confirmed')
      const intents: PendingIntentSummary[] = []

      for (let index = 0; index < accounts.length; index += 1) {
        const account = accounts[index]
        const epoch = epochs[index]
        if (!account || epoch == null) continue
        const decoded = decodeIntent(Uint8Array.from(account.data))
        if (decoded.cancelled || decoded.claimed) continue
        intents.push({
          id: `${wallet.toBase58()}:${market.toBase58()}:${epoch.toString()}`,
          marketAddress: market.toBase58(),
          wallet: wallet.toBase58(),
          epoch: epoch.toString(),
          side: decoded.side === 0 ? 'sell' : 'buy',
          amountIn: decoded.amountIn.toString(),
          minOut: decoded.minOut.toString(),
          filledIn: decoded.filledIn.toString(),
          amountOut: decoded.amountOut.toString(),
          refundIn: decoded.refundIn.toString(),
          priceQuote: this.q64ToNumber(decoded.priceQ64_64),
          cleared: decoded.cleared,
          cancelled: decoded.cancelled,
          claimed: decoded.claimed,
        })
      }

      return {
        wallet: wallet.toBase58(),
        marketAddress: market.toBase58(),
        syncedAt: Math.floor(Date.now() / 1000),
        intents: intents.sort((a, b) => Number(b.epoch) - Number(a.epoch)),
      }
    })
  }

  async getMarketCandles(
    marketAddress: string,
    interval: CandleInterval,
    limit: number,
  ): Promise<MarketCandlesResponse> {
    const cacheKey = `market-candles:${marketAddress}:${interval}:${limit}`
    return this.memoize(cacheKey, async () => {
      const market = new PublicKey(marketAddress)
      const marketAccount = await this.connection.getAccountInfo(market, 'confirmed')
      if (!marketAccount) {
        return {
          marketAddress,
          marketKey: 'unknown',
          interval,
          syncedAt: Math.floor(Date.now() / 1000),
          candles: [],
        }
      }

      const marketConfig = decodeMarketConfig(Uint8Array.from(marketAccount.data))
      const signatures = await this.connection.getSignaturesForAddress(market, {
        limit: this.config.marketScanLimit,
      })
      const parsedTransactions = await this.loadParsedTransactions(signatures.map((entry) => entry.signature))
      const candles = this.aggregateVaultCandles(parsedTransactions, marketConfig.vaultToken.toBase58(), marketConfig.vaultXor.toBase58(), interval)
        .slice(-limit)

      return {
        marketAddress,
        marketKey: this.marketKeyFor(marketConfig.mintToken.toBase58(), marketConfig.mintXor.toBase58()),
        interval,
        syncedAt: Math.floor(Date.now() / 1000),
        candles,
      }
    })
  }

  async getMarketOverview(marketAddress: string): Promise<MarketOverview> {
    const cacheKey = `market-overview:${marketAddress}`
    return this.memoize(cacheKey, async () => {
      const market = new PublicKey(marketAddress)
      const marketAccount = await this.connection.getAccountInfo(market, 'confirmed')
      if (!marketAccount) {
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
          syncedAt: Math.floor(Date.now() / 1000),
        }
      }

      const marketConfig = decodeMarketConfig(Uint8Array.from(marketAccount.data))
      const candlesResponse = await this.getMarketCandles(marketAddress, '1h', 48)
      const first = candlesResponse.candles[0]
      const last = candlesResponse.candles[candlesResponse.candles.length - 1]
      const sessionHighQuote =
        candlesResponse.candles.length > 0 ? Math.max(...candlesResponse.candles.map((entry) => entry.high)) : null
      const sessionLowQuote =
        candlesResponse.candles.length > 0 ? Math.min(...candlesResponse.candles.map((entry) => entry.low)) : null
      const sessionChangePct =
        first && last && first.open > 0 ? ((last.close - first.open) / first.open) * 100 : null

      let currentEpoch: bigint | null = null
      let epochState: ReturnType<typeof decodeEpochState> | null = null

      if (this.config.batchAuctionProgramId) {
        const slot = BigInt(await this.connection.getSlot('confirmed'))
        currentEpoch = currentEpochForSlot(slot, marketConfig.scheduleStartSlot, marketConfig.auctionDurationSlots)
        const epochPda = batchEpochPda(this.config.batchAuctionProgramId, market, currentEpoch)
        const epochAccount = await this.connection.getAccountInfo(epochPda, 'confirmed')
        if (epochAccount) {
          epochState = decodeEpochState(Uint8Array.from(epochAccount.data))
        }
      }

      const currentPriceQuote = this.q64ToNumber(epochState?.priceQ64_64 ?? null) ?? last?.close ?? null
      return {
        marketAddress,
        marketKey: this.marketKeyFor(marketConfig.mintToken.toBase58(), marketConfig.mintXor.toBase58()),
        assetMint: marketConfig.mintToken.toBase58(),
        quoteMint: marketConfig.mintXor.toBase58(),
        currentPriceQuote,
        currentPriceUsd: currentPriceQuote == null ? null : currentPriceQuote * this.config.quoteUsdRate,
        sessionHighQuote,
        sessionLowQuote,
        sessionChangePct,
        demandSkewPct: epochState ? this.computeDemandSkew(epochState.totalTokenSupply, epochState.totalTokenDemand) : null,
        currentEpoch: currentEpoch?.toString() ?? null,
        epochCleared: epochState?.cleared ?? null,
        totalTokenSupply: epochState?.totalTokenSupply.toString() ?? null,
        totalTokenDemand: epochState?.totalTokenDemand.toString() ?? null,
        totalTokenCleared: epochState?.totalTokenCleared.toString() ?? null,
        syncedAt: Math.floor(Date.now() / 1000),
      }
    })
  }

  private async memoize<T>(key: string, resolver: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key) as CacheEntry<T> | undefined
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const value = await resolver()
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.config.cacheTtlMs,
    })
    return value
  }

  private async loadParsedTransactions(signatures: string[]): Promise<ParsedTransactionWithMeta[]> {
    if (signatures.length === 0) return []
    const parsed = await this.connection.getParsedTransactions(signatures, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    return parsed.filter((entry): entry is ParsedTransactionWithMeta => !!entry)
  }

  private extractWalletSwap(tx: ParsedTransactionWithMeta, wallet: string): WalletSwapRecord | null {
    const route = this.detectRoute(tx)
    if (!route) return null

    const status: 'success' | 'failed' = tx.meta?.err ? 'failed' : 'success'
    const deltas = this.ownerMintDeltas(tx, wallet)
    const negatives = [...deltas.entries()]
      .map(([mint, value]) => ({ mint, value }))
      .filter((entry) => entry.value < 0)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    const positives = [...deltas.entries()]
      .map(([mint, value]) => ({ mint, value }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))

    const pay = negatives[0]
    const receive = positives[0]

    if (!pay && !receive) {
      return {
        id: `${tx.transaction.signatures[0] ?? 'unknown'}:${route}`,
        signature: tx.transaction.signatures[0] ?? 'unknown',
        slot: tx.slot,
        timestamp: tx.blockTime ?? 0,
        status,
        route,
        marketKey: 'unknown',
        assetMint: null,
        quoteMint: this.quoteMint,
        payMint: null,
        receiveMint: null,
        payAmount: null,
        receiveAmount: null,
        side: 'swap',
        qty: null,
        priceQuote: null,
        notionalQuote: null,
        priceUsd: null,
        notionalUsd: null,
      }
    }

    const payMint = pay?.mint ?? null
    const receiveMint = receive?.mint ?? null
    const payAmount = pay ? Math.abs(pay.value) : null
    const receiveAmount = receive ? receive.value : null

    let assetMint: string | null = null
    let quoteMint: string | null = null
    let side: 'buy' | 'sell' | 'swap' = 'swap'
    let qty: number | null = null
    let notionalQuote: number | null = null

    if (this.quoteMint && (payMint === this.quoteMint || receiveMint === this.quoteMint)) {
      quoteMint = this.quoteMint
      if (payMint === this.quoteMint && receiveMint) {
        assetMint = receiveMint
        side = 'buy'
        qty = receiveAmount
        notionalQuote = payAmount
      } else if (receiveMint === this.quoteMint && payMint) {
        assetMint = payMint
        side = 'sell'
        qty = payAmount
        notionalQuote = receiveAmount
      }
    }

    const marketKey = assetMint && quoteMint ? this.marketKeyFor(assetMint, quoteMint) : this.marketKeyFor(payMint, receiveMint)
    const priceQuote =
      qty != null && notionalQuote != null && qty > 0 ? notionalQuote / qty : null

    return {
      id: `${tx.transaction.signatures[0] ?? 'unknown'}:${route}`,
      signature: tx.transaction.signatures[0] ?? 'unknown',
      slot: tx.slot,
      timestamp: tx.blockTime ?? 0,
      status,
      route,
      marketKey,
      assetMint,
      quoteMint,
      payMint,
      receiveMint,
      payAmount,
      receiveAmount,
      side,
      qty,
      priceQuote,
      notionalQuote,
      priceUsd: priceQuote == null ? null : priceQuote * this.config.quoteUsdRate,
      notionalUsd: notionalQuote == null ? null : notionalQuote * this.config.quoteUsdRate,
    }
  }

  private summarizePositions(swaps: WalletSwapRecord[]): SpotPositionSummary[] {
    const grouped = new Map<string, SpotPositionSummary>()

    for (const swap of swaps) {
      if (swap.status !== 'success' || !swap.assetMint || !swap.quoteMint || swap.side === 'swap') continue
      let summary = grouped.get(swap.marketKey)
      if (!summary) {
        summary = {
          marketKey: swap.marketKey,
          assetMint: swap.assetMint,
          quoteMint: swap.quoteMint,
          qty: 0,
          avgEntryQuote: null,
          avgEntryUsd: null,
          lastPriceQuote: null,
          lastPriceUsd: null,
          realizedPnlQuote: 0,
          realizedPnlUsd: 0,
          unrealizedPnlQuote: 0,
          unrealizedPnlUsd: 0,
          buyQty: 0,
          sellQty: 0,
          routeCounts: { batch: 0, dlmm: 0, rfq: 0 },
          lastTimestamp: 0,
        }
        grouped.set(swap.marketKey, summary)
      }

      summary.routeCounts[swap.route] += 1
      summary.lastTimestamp = Math.max(summary.lastTimestamp, swap.timestamp)
      if (swap.priceQuote != null) {
        summary.lastPriceQuote = swap.priceQuote
        summary.lastPriceUsd = swap.priceQuote * this.config.quoteUsdRate
      }

      if (swap.side === 'buy' && swap.qty != null && swap.notionalQuote != null) {
        const existingCost = (summary.avgEntryQuote ?? 0) * summary.qty
        summary.qty += swap.qty
        summary.buyQty += swap.qty
        summary.avgEntryQuote = summary.qty > 0 ? (existingCost + swap.notionalQuote) / summary.qty : null
        continue
      }

      if (swap.side === 'sell' && swap.qty != null && swap.notionalQuote != null) {
        const avgEntry = summary.avgEntryQuote ?? 0
        const qtySold = Math.min(summary.qty, swap.qty)
        summary.sellQty += swap.qty
        summary.realizedPnlQuote += swap.notionalQuote - qtySold * avgEntry
        summary.qty = Math.max(0, summary.qty - qtySold)
        if (summary.qty === 0) {
          summary.avgEntryQuote = null
        }
      }
    }

    const positions = [...grouped.values()].map((entry) => {
      const unrealizedQuote =
        entry.qty > 0 && entry.avgEntryQuote != null && entry.lastPriceQuote != null
          ? entry.qty * (entry.lastPriceQuote - entry.avgEntryQuote)
          : 0
      entry.avgEntryUsd = entry.avgEntryQuote == null ? null : entry.avgEntryQuote * this.config.quoteUsdRate
      entry.realizedPnlUsd = entry.realizedPnlQuote * this.config.quoteUsdRate
      entry.unrealizedPnlQuote = unrealizedQuote
      entry.unrealizedPnlUsd = unrealizedQuote * this.config.quoteUsdRate
      return entry
    })

    return positions.sort((a, b) => b.lastTimestamp - a.lastTimestamp)
  }

  private aggregateVaultCandles(
    transactions: ParsedTransactionWithMeta[],
    baseVaultAddress: string,
    quoteVaultAddress: string,
    interval: CandleInterval,
  ): MarketCandle[] {
    const candles = new Map<number, MarketCandle>()
    const bucketSize = INTERVAL_SECONDS[interval]

    for (const tx of transactions) {
      if (tx.meta?.err) continue
      const baseDelta = this.tokenAccountDelta(tx, baseVaultAddress)
      const quoteDelta = this.tokenAccountDelta(tx, quoteVaultAddress)
      if (baseDelta == null || quoteDelta == null) continue
      const volumeBase = Math.abs(baseDelta)
      const volumeQuote = Math.abs(quoteDelta)
      if (volumeBase <= 0 || volumeQuote <= 0) continue

      const timestamp = tx.blockTime ?? 0
      if (timestamp <= 0) continue
      const bucket = Math.floor(timestamp / bucketSize) * bucketSize
      const price = volumeQuote / volumeBase
      const existing = candles.get(bucket)

      if (!existing) {
        candles.set(bucket, {
          ts: bucket,
          open: price,
          high: price,
          low: price,
          close: price,
          volumeBase,
          volumeQuote,
          volumeUsd: volumeQuote * this.config.quoteUsdRate,
          tradeCount: 1,
        })
        continue
      }

      existing.high = Math.max(existing.high, price)
      existing.low = Math.min(existing.low, price)
      existing.close = price
      existing.volumeBase += volumeBase
      existing.volumeQuote += volumeQuote
      existing.volumeUsd = (existing.volumeUsd ?? 0) + volumeQuote * this.config.quoteUsdRate
      existing.tradeCount += 1
    }

    return [...candles.values()].sort((a, b) => a.ts - b.ts)
  }

  private detectRoute(tx: ParsedTransactionWithMeta): SpotRoute | null {
    const programs = this.collectProgramIds(tx)
    if (this.routePrograms.batch && programs.has(this.routePrograms.batch)) return 'batch'
    if (this.routePrograms.dlmm && programs.has(this.routePrograms.dlmm)) return 'dlmm'
    if (this.routePrograms.rfq && programs.has(this.routePrograms.rfq)) return 'rfq'
    return null
  }

  private collectProgramIds(tx: ParsedTransactionWithMeta): Set<string> {
    const ids = new Set<string>()
    const outerInstructions = tx.transaction.message.instructions ?? []
    for (const instruction of outerInstructions as any[]) {
      const id = this.programIdFromInstruction(instruction)
      if (id) ids.add(id)
    }
    for (const inner of tx.meta?.innerInstructions ?? []) {
      for (const instruction of (inner as any).instructions ?? []) {
        const id = this.programIdFromInstruction(instruction)
        if (id) ids.add(id)
      }
    }
    return ids
  }

  private programIdFromInstruction(instruction: any): string | null {
    const programId = instruction?.programId
    if (programId && typeof programId.toBase58 === 'function') return programId.toBase58()
    if (typeof programId === 'string') return programId
    if (typeof instruction?.programIdIndex === 'number') return null
    return null
  }

  private ownerMintDeltas(tx: ParsedTransactionWithMeta, wallet: string): Map<string, number> {
    const before = this.ownerMintAmounts(tx.meta?.preTokenBalances ?? [], wallet)
    const after = this.ownerMintAmounts(tx.meta?.postTokenBalances ?? [], wallet)
    const mints = new Set([...before.keys(), ...after.keys()])
    const deltas = new Map<string, number>()
    for (const mint of mints) {
      const delta = (after.get(mint) ?? 0) - (before.get(mint) ?? 0)
      if (Math.abs(delta) < 1e-12) continue
      deltas.set(mint, delta)
    }
    return deltas
  }

  private ownerMintAmounts(balances: TokenBalance[], wallet: string): Map<string, number> {
    const totals = new Map<string, number>()
    for (const balance of balances) {
      if (balance.owner !== wallet) continue
      const amount = Number.parseFloat(balance.uiTokenAmount.uiAmountString ?? '0')
      totals.set(balance.mint, (totals.get(balance.mint) ?? 0) + (Number.isFinite(amount) ? amount : 0))
    }
    return totals
  }

  private tokenAccountDelta(tx: ParsedTransactionWithMeta, tokenAccountAddress: string): number | null {
    const before = this.tokenAccountAmounts(tx, tx.meta?.preTokenBalances ?? []).get(tokenAccountAddress) ?? 0
    const after = this.tokenAccountAmounts(tx, tx.meta?.postTokenBalances ?? []).get(tokenAccountAddress) ?? 0
    const delta = after - before
    return Math.abs(delta) < 1e-12 ? null : delta
  }

  private tokenAccountAmounts(tx: ParsedTransactionWithMeta, balances: TokenBalance[]): Map<string, number> {
    const totals = new Map<string, number>()
    for (const balance of balances) {
      const tokenAccountAddress = this.accountAddressAt(tx, balance.accountIndex)
      if (!tokenAccountAddress) continue
      const amount = Number.parseFloat(balance.uiTokenAmount.uiAmountString ?? '0')
      totals.set(tokenAccountAddress, Number.isFinite(amount) ? amount : 0)
    }
    return totals
  }

  private accountAddressAt(tx: ParsedTransactionWithMeta, index: number): string | null {
    const account = tx.transaction.message.accountKeys[index] as any
    if (!account) return null
    if (typeof account === 'string') return account
    if (typeof account.pubkey === 'string') return account.pubkey
    if (account.pubkey && typeof account.pubkey.toBase58 === 'function') return account.pubkey.toBase58()
    if (typeof account.toBase58 === 'function') return account.toBase58()
    return null
  }

  private computeDemandSkew(totalSupply: bigint, totalDemand: bigint): number | null {
    const supply = Number(totalSupply)
    const demand = Number(totalDemand)
    const total = supply + demand
    if (!Number.isFinite(total) || total <= 0) return null
    return (demand / total) * 100
  }

  private marketKeyFor(assetMint: string | null, quoteMint: string | null): string {
    return `${assetMint ?? 'unknown'}::${quoteMint ?? 'unknown'}`
  }

  private q64ToNumber(value: bigint | null | undefined): number | null {
    if (value == null || value <= 0n) return null
    const q64 = 1n << 64n
    const intPart = value / q64
    if (intPart > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
    const fractional = Number((value % q64) * 1_000_000n / q64) / 1_000_000
    return Number(intPart) + fractional
  }
}
