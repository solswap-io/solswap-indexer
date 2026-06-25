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
  SolanaTokenBalance,
  SolanaTokenProgram,
  TokenMetadata,
  TokenMetadataBatchResponse,
  TokenMetadataResponse,
  TokenTransferFee,
  TokenTransferFeeConfig,
  TokenTransferHook,
  WalletAssetsResponse,
  WalletBalancesResponse,
  WalletStateResponse,
  WalletTransactionRecord,
  WalletTransactionsResponse,
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

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

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

  async getWalletBalances(walletAddress: string): Promise<WalletBalancesResponse> {
    const wallet = new PublicKey(walletAddress)
    const cacheKey = `wallet-balances:${wallet.toBase58()}`
    return this.memoize(cacheKey, async () => {
      const [lamports, splTokens, token2022Tokens] = await Promise.all([
        this.withRpcRetry(() => this.connection.getBalance(wallet, 'confirmed'), 'getBalance'),
        this.loadTokenAccounts(wallet, TOKEN_PROGRAM_ID, 'spl-token'),
        this.loadTokenAccounts(wallet, TOKEN_2022_PROGRAM_ID, 'token-2022'),
      ])
      const tokens = [...splTokens, ...token2022Tokens].sort((a, b) => {
        const byMint = a.mint.localeCompare(b.mint)
        return byMint !== 0 ? byMint : a.accountAddress.localeCompare(b.accountAddress)
      })

      return {
        wallet: wallet.toBase58(),
        native: {
          type: 'native',
          mint: 'SOL',
          lamports: this.numberToIntegerString(lamports),
          decimals: 9,
          uiAmountString: this.formatIntegerAmount(this.numberToIntegerString(lamports), 9),
        },
        tokens,
        total: tokens.length + 1,
        syncedAt: Math.floor(Date.now() / 1000),
      }
    })
  }

  async getWalletAssets(walletAddress: string): Promise<WalletAssetsResponse> {
    const balances = await this.getWalletBalances(walletAddress)
    return {
      wallet: balances.wallet,
      assets: [balances.native, ...balances.tokens],
      total: balances.total,
      syncedAt: balances.syncedAt,
    }
  }

  async getWalletState(walletAddress: string): Promise<WalletStateResponse> {
    const wallet = new PublicKey(walletAddress)
    const cacheKey = `wallet-state:${wallet.toBase58()}`
    return this.memoize(cacheKey, async () => {
      const account = await this.withRpcRetry(() => this.connection.getAccountInfo(wallet, 'confirmed'), 'getAccountInfo')
      if (!account) {
        return {
          wallet: wallet.toBase58(),
          exists: false,
          lamports: '0',
          owner: null,
          executable: false,
          rentEpoch: null,
          dataLength: 0,
          syncedAt: Math.floor(Date.now() / 1000),
        }
      }

      return {
        wallet: wallet.toBase58(),
        exists: true,
        lamports: this.numberToIntegerString(account.lamports),
        owner: account.owner.toBase58(),
        executable: account.executable,
        rentEpoch: account.rentEpoch == null ? null : account.rentEpoch.toString(),
        dataLength: account.data.length,
        syncedAt: Math.floor(Date.now() / 1000),
      }
    })
  }

  async getWalletTransactions(
    walletAddress: string,
    before: string | null,
    limit: number,
  ): Promise<WalletTransactionsResponse> {
    const wallet = new PublicKey(walletAddress)
    const boundedLimit = Math.max(1, Math.min(limit, this.config.accountScanLimit))
    const cacheKey = `wallet-txs:${wallet.toBase58()}:${before ?? ''}:${boundedLimit}`
    return this.memoize(cacheKey, async () => {
      const signatures = await this.withRpcRetry(
        () => this.connection.getSignaturesForAddress(wallet, {
          before: before ?? undefined,
          limit: boundedLimit,
        }),
        'getSignaturesForAddress',
      )
      const parsedTransactions = await this.loadParsedTransactions(signatures.map((entry) => entry.signature))
      const parsedBySignature = new Map(parsedTransactions.map((tx) => [tx.transaction.signatures[0], tx]))
      const transactions: WalletTransactionRecord[] = signatures.map((entry) => {
        const tx = parsedBySignature.get(entry.signature) ?? null
        return this.walletTransactionRecord(entry.signature, entry.slot, entry.blockTime ?? 0, entry.err != null, wallet.toBase58(), tx)
      })

      return {
        wallet: wallet.toBase58(),
        before,
        nextBefore: signatures.length === boundedLimit ? signatures[signatures.length - 1]?.signature ?? null : null,
        limit: boundedLimit,
        total: transactions.length,
        syncedAt: Math.floor(Date.now() / 1000),
        transactions,
      }
    })
  }

  async getTokenMetadata(mintAddress: string): Promise<TokenMetadataResponse> {
    const mint = new PublicKey(mintAddress)
    const cacheKey = `token-metadata:${mint.toBase58()}`
    return this.memoize(cacheKey, async () => {
      const syncedAt = Math.floor(Date.now() / 1000)
      const response = await this.withRpcRetry(
        () => this.connection.getParsedAccountInfo(mint, 'confirmed'),
        'getParsedAccountInfo',
      )
      const account = response.value
      if (!account) {
        return {
          mint: mint.toBase58(),
          exists: false,
          program: 'unknown',
          programId: null,
          extensions: [],
          transferFeeConfig: null,
          transferHook: null,
          decimals: null,
          supply: null,
          uiSupplyString: null,
          mintAuthority: null,
          freezeAuthority: null,
          isInitialized: null,
          name: null,
          symbol: null,
          uri: null,
          syncedAt,
        }
      }

      const parsed = (account.data as any)?.parsed?.info ?? null
      const decimals = typeof parsed?.decimals === 'number' ? parsed.decimals : null
      const supply = typeof parsed?.supply === 'string' ? parsed.supply : null
      const programId = account.owner.toBase58()
      const extensions = this.tokenExtensions(parsed)
      return {
        mint: mint.toBase58(),
        exists: true,
        program: this.tokenProgramName(programId),
        programId,
        extensions,
        transferFeeConfig: this.tokenTransferFeeConfig(parsed),
        transferHook: this.tokenTransferHook(parsed, mint),
        decimals,
        supply,
        uiSupplyString: supply != null && decimals != null ? this.formatIntegerAmount(supply, decimals) : null,
        mintAuthority: typeof parsed?.mintAuthority === 'string' ? parsed.mintAuthority : null,
        freezeAuthority: typeof parsed?.freezeAuthority === 'string' ? parsed.freezeAuthority : null,
        isInitialized: typeof parsed?.isInitialized === 'boolean' ? parsed.isInitialized : null,
        name: null,
        symbol: null,
        uri: null,
        syncedAt,
      }
    })
  }

  async getTokenMetadataBatch(mintAddresses: string[]): Promise<TokenMetadataBatchResponse> {
    const uniqueMints = [...new Set(mintAddresses)]
    const tokens = await Promise.all(uniqueMints.map((mint) => this.getTokenMetadata(mint)))
    return {
      total: tokens.length,
      syncedAt: Math.floor(Date.now() / 1000),
      tokens,
    }
  }

  private async loadTokenAccounts(
    owner: PublicKey,
    programId: PublicKey,
    program: SolanaTokenProgram,
  ): Promise<SolanaTokenBalance[]> {
    const response = await this.withRpcRetry(
      () => this.connection.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed'),
      'getParsedTokenAccountsByOwner',
    )
    return response.value.map((entry) => {
      const parsed = (entry.account.data as any)?.parsed?.info ?? {}
      const tokenAmount = parsed.tokenAmount ?? {}
      const amount = typeof tokenAmount.amount === 'string' ? tokenAmount.amount : '0'
      const decimals = typeof tokenAmount.decimals === 'number' ? tokenAmount.decimals : 0
      return {
        type: 'token',
        accountAddress: entry.pubkey.toBase58(),
        mint: typeof parsed.mint === 'string' ? parsed.mint : '',
        owner: typeof parsed.owner === 'string' ? parsed.owner : owner.toBase58(),
        program,
        programId: programId.toBase58(),
        amount,
        decimals,
        uiAmountString: this.formatIntegerAmount(amount, decimals),
        state: typeof parsed.state === 'string' ? parsed.state : null,
        isNative: Boolean(parsed.isNative),
        delegatedAmount: this.parsedTokenAmount(parsed.delegatedAmount),
        rentExemptReserve: this.parsedTokenAmount(parsed.rentExemptReserve),
      }
    })
  }

  private walletTransactionRecord(
    signature: string,
    slot: number,
    blockTime: number,
    signatureFailed: boolean,
    wallet: string,
    tx: ParsedTransactionWithMeta | null,
  ): WalletTransactionRecord {
    if (!tx) {
      return {
        signature,
        slot,
        timestamp: blockTime,
        status: signatureFailed ? 'failed' : 'success',
        feeLamports: null,
        nativeBalanceChangeLamports: null,
        tokenBalanceChanges: [],
        programIds: [],
        solswapRoute: null,
      }
    }

    return {
      signature,
      slot: tx.slot,
      timestamp: tx.blockTime ?? blockTime,
      status: tx.meta?.err || signatureFailed ? 'failed' : 'success',
      feeLamports: tx.meta?.fee == null ? null : this.numberToIntegerString(tx.meta.fee),
      nativeBalanceChangeLamports: this.nativeBalanceChangeLamports(tx, wallet),
      tokenBalanceChanges: this.walletTokenBalanceChanges(tx, wallet),
      programIds: [...this.collectProgramIds(tx)].sort(),
      solswapRoute: this.detectRoute(tx),
    }
  }

  private nativeBalanceChangeLamports(tx: ParsedTransactionWithMeta, wallet: string): string | null {
    let seen = false
    let delta = 0n
    for (let index = 0; index < tx.transaction.message.accountKeys.length; index += 1) {
      if (this.accountAddressAt(tx, index) !== wallet) continue
      const pre = tx.meta?.preBalances?.[index]
      const post = tx.meta?.postBalances?.[index]
      if (pre == null || post == null) continue
      seen = true
      delta += BigInt(Math.trunc(post)) - BigInt(Math.trunc(pre))
    }
    return seen ? delta.toString() : null
  }

  private walletTokenBalanceChanges(tx: ParsedTransactionWithMeta, wallet: string) {
    const before = this.ownerMintRawAmounts(tx.meta?.preTokenBalances ?? [], wallet)
    const after = this.ownerMintRawAmounts(tx.meta?.postTokenBalances ?? [], wallet)
    const mints = new Set([...before.keys(), ...after.keys()])
    return [...mints]
      .map((mint) => {
        const pre = before.get(mint)
        const post = after.get(mint)
        const preAmount = pre?.amount ?? 0n
        const postAmount = post?.amount ?? 0n
        const decimals = post?.decimals ?? pre?.decimals ?? 0
        const amountDelta = postAmount - preAmount
        return {
          mint,
          preAmount: preAmount.toString(),
          postAmount: postAmount.toString(),
          amountDelta: amountDelta.toString(),
          decimals,
          uiAmountDeltaString: this.formatSignedIntegerAmount(amountDelta.toString(), decimals),
        }
      })
      .filter((entry) => entry.amountDelta !== '0')
      .sort((a, b) => a.mint.localeCompare(b.mint))
  }

  private ownerMintRawAmounts(balances: TokenBalance[], wallet: string): Map<string, { amount: bigint; decimals: number }> {
    const totals = new Map<string, { amount: bigint; decimals: number }>()
    for (const balance of balances) {
      if (balance.owner !== wallet) continue
      const amount = this.parseIntegerAmount(balance.uiTokenAmount.amount)
      const existing = totals.get(balance.mint) ?? { amount: 0n, decimals: balance.uiTokenAmount.decimals }
      existing.amount += amount
      existing.decimals = balance.uiTokenAmount.decimals
      totals.set(balance.mint, existing)
    }
    return totals
  }

  private parsedTokenAmount(value: unknown): string | null {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object' && typeof (value as { amount?: unknown }).amount === 'string') {
      return (value as { amount: string }).amount
    }
    return null
  }

  private tokenProgramName(programId: string): SolanaTokenProgram | 'unknown' {
    if (programId === TOKEN_PROGRAM_ID.toBase58()) return 'spl-token'
    if (programId === TOKEN_2022_PROGRAM_ID.toBase58()) return 'token-2022'
    return 'unknown'
  }

  private tokenExtensions(parsed: unknown): string[] {
    return [...new Set(this.tokenExtensionEntries(parsed).map((entry) => entry.extension))].sort()
  }

  private tokenTransferFeeConfig(parsed: unknown): TokenTransferFeeConfig | null {
    const state = this.tokenExtensionState(parsed, 'transferFeeConfig')
    if (!state) return null

    return {
      transferFeeConfigAuthority: this.stringOrNull(state.transferFeeConfigAuthority),
      withdrawWithheldAuthority: this.stringOrNull(state.withdrawWithheldAuthority),
      withheldAmount: this.integerStringOrNull(state.withheldAmount),
      olderTransferFee: this.tokenTransferFee(state.olderTransferFee),
      newerTransferFee: this.tokenTransferFee(state.newerTransferFee),
    }
  }

  private tokenTransferHook(parsed: unknown, mint: PublicKey): TokenTransferHook | null {
    const state = this.tokenExtensionState(parsed, 'transferHook')
    if (!state) return null
    const programId = this.stringOrNull(state.programId)

    return {
      authority: this.stringOrNull(state.authority),
      programId,
      extraAccountMetasAddress: programId == null ? null : this.transferHookExtraAccountMetasAddress(mint, programId),
    }
  }

  private transferHookExtraAccountMetasAddress(mint: PublicKey, programId: string): string | null {
    try {
      const [address] = PublicKey.findProgramAddressSync(
        [Buffer.from('extra-account-metas'), mint.toBuffer()],
        new PublicKey(programId),
      )
      return address.toBase58()
    } catch {
      return null
    }
  }

  private tokenTransferFee(value: unknown): TokenTransferFee | null {
    if (!this.isRecord(value)) return null

    return {
      epoch: this.integerStringOrNull(value.epoch),
      maximumFee: this.integerStringOrNull(value.maximumFee),
      transferFeeBasisPoints: this.integerNumberOrNull(value.transferFeeBasisPoints),
    }
  }

  private tokenExtensionState(parsed: unknown, extensionName: string): Record<string, unknown> | null {
    const entry = this.tokenExtensionEntries(parsed).find((candidate) => candidate.extension === extensionName)
    return this.isRecord(entry?.state) ? entry.state : null
  }

  private tokenExtensionEntries(parsed: unknown): Array<{ extension: string; state: unknown }> {
    if (!this.isRecord(parsed) || !Array.isArray(parsed.extensions)) return []

    return parsed.extensions.flatMap((entry: unknown) => {
      if (!this.isRecord(entry) || typeof entry.extension !== 'string') return []
      return [{ extension: entry.extension, state: entry.state }]
    })
  }

  private stringOrNull(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
  }

  private integerStringOrNull(value: unknown): string | null {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value.toString()
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null
    return value
  }

  private integerNumberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null
    const parsed = Number.parseInt(value, 10)
    return Number.isSafeInteger(parsed) ? parsed : null
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value)
  }

  private parseIntegerAmount(value: string): bigint {
    try {
      return BigInt(value)
    } catch {
      return 0n
    }
  }

  private numberToIntegerString(value: number): string {
    if (!Number.isFinite(value)) return '0'
    return BigInt(Math.trunc(value)).toString()
  }

  private formatSignedIntegerAmount(value: string, decimals: number): string {
    const negative = value.startsWith('-')
    const formatted = this.formatIntegerAmount(negative ? value.slice(1) : value, decimals)
    if (!negative || formatted === '0') return formatted
    return `-${formatted}`
  }

  private formatIntegerAmount(value: string, decimals: number): string {
    const normalizedDecimals = Math.max(0, decimals)
    const digits = value.replace(/^\+/, '').replace(/^0+(?=\d)/, '') || '0'
    if (normalizedDecimals === 0) return digits
    const padded = digits.padStart(normalizedDecimals + 1, '0')
    const integerPart = padded.slice(0, -normalizedDecimals) || '0'
    const fractionPart = padded.slice(-normalizedDecimals).replace(/0+$/, '')
    return fractionPart.length === 0 ? integerPart : `${integerPart}.${fractionPart}`
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
      const marketAccount = await this.withRpcRetry(() => this.connection.getAccountInfo(market, 'confirmed'), 'getAccountInfo')
      if (!marketAccount) {
        return {
          wallet: wallet.toBase58(),
          marketAddress,
          syncedAt: Math.floor(Date.now() / 1000),
          intents: [],
        }
      }

      const marketConfig = decodeMarketConfig(Uint8Array.from(marketAccount.data))
      const slot = BigInt(await this.withRpcRetry(() => this.connection.getSlot('confirmed'), 'getSlot'))
      const currentEpoch = currentEpochForSlot(slot, marketConfig.scheduleStartSlot, marketConfig.auctionDurationSlots)
      const epochs = [currentEpoch - 1n, currentEpoch, currentEpoch + 1n].filter((value) => value >= 0n)
      const pdas = epochs.map((epoch) => batchIntentPda(this.config.batchAuctionProgramId as PublicKey, market, wallet, epoch))
      const accounts = await this.withRpcRetry(
        () => this.connection.getMultipleAccountsInfo(pdas, 'confirmed'),
        'getMultipleAccountsInfo',
      )
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
      const marketAccount = await this.withRpcRetry(() => this.connection.getAccountInfo(market, 'confirmed'), 'getAccountInfo')
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
      const signatures = await this.withRpcRetry(
        () => this.connection.getSignaturesForAddress(market, {
          limit: this.config.marketScanLimit,
        }),
        'getSignaturesForAddress',
      )
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
      const marketAccount = await this.withRpcRetry(() => this.connection.getAccountInfo(market, 'confirmed'), 'getAccountInfo')
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
        const slot = BigInt(await this.withRpcRetry(() => this.connection.getSlot('confirmed'), 'getSlot'))
        currentEpoch = currentEpochForSlot(slot, marketConfig.scheduleStartSlot, marketConfig.auctionDurationSlots)
        const epochPda = batchEpochPda(this.config.batchAuctionProgramId, market, currentEpoch)
        const epochAccount = await this.withRpcRetry(() => this.connection.getAccountInfo(epochPda, 'confirmed'), 'getAccountInfo')
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

  private async withRpcRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
    const maxAttempts = Math.max(1, this.config.rpcRetryAttempts)
    let lastError: unknown = null

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation()
      } catch (error) {
        lastError = error
        if (attempt >= maxAttempts || !this.isRetryableRpcError(error)) break
        await this.delay(this.retryDelayMs(attempt))
      }
    }

    throw new Error(`${label}_failed_after_${maxAttempts}_attempts`, { cause: lastError })
  }

  private isRetryableRpcError(error: unknown): boolean {
    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : null
    if (status != null) return status === 408 || status === 425 || status === 429 || status >= 500

    const code = typeof (error as { code?: unknown })?.code === 'string'
      ? (error as { code: string }).code
      : null
    if (code && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(code)) return true

    const message = error instanceof Error ? error.message.toLowerCase() : ''
    return message.includes('429') || message.includes('timeout') || message.includes('temporarily unavailable')
  }

  private retryDelayMs(attempt: number): number {
    const baseDelay = Math.max(0, this.config.rpcRetryBaseDelayMs)
    const cappedExponent = Math.min(attempt - 1, 6)
    return Math.min(baseDelay * 2 ** cappedExponent, 5_000)
  }

  private delay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve()
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async loadParsedTransactions(signatures: string[]): Promise<ParsedTransactionWithMeta[]> {
    if (signatures.length === 0) return []
    const parsed = await this.withRpcRetry(
      () => this.connection.getParsedTransactions(signatures, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }),
      'getParsedTransactions',
    )
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
