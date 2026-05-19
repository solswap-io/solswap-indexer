import { PublicKey } from '@solana/web3.js'

const SEED_PREFIX = new TextEncoder().encode('solswap')
const SEED_BATCH = new TextEncoder().encode('batch_auction')
const SEED_INTENT = new TextEncoder().encode('intent')
const SEED_EPOCH = new TextEncoder().encode('epoch')

function readPubkey(data: Uint8Array, offset: number): PublicKey {
  return new PublicKey(data.slice(offset, offset + 32))
}

function readU16LE(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 2).getUint16(0, true)
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true)
}

function readU128LE(data: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let i = 0; i < 16; i += 1) {
    value |= BigInt(data[offset + i] ?? 0) << BigInt(i * 8)
  }
  return value
}

function u64LeBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, true)
  return out
}

export type BatchMarketConfig = {
  mintToken: PublicKey
  mintXor: PublicKey
  vaultToken: PublicKey
  vaultXor: PublicKey
  auctionDurationSlots: bigint
  scheduleStartSlot: bigint
}

export function decodeMarketConfig(data: Uint8Array): BatchMarketConfig {
  if (data.length < 348) throw new Error('invalid_market_config')
  return {
    mintToken: readPubkey(data, 2),
    mintXor: readPubkey(data, 34),
    vaultToken: readPubkey(data, 66),
    vaultXor: readPubkey(data, 98),
    auctionDurationSlots: readU64LE(data, 324),
    scheduleStartSlot: readU64LE(data, 332),
  }
}

export type BatchEpochState = {
  epoch: bigint
  cleared: boolean
  priceQ64_64: bigint
  totalTokenSupply: bigint
  totalTokenDemand: bigint
  totalTokenCleared: bigint
}

export function decodeEpochState(data: Uint8Array): BatchEpochState {
  if (data.length < 90) throw new Error('invalid_epoch_state')
  return {
    epoch: readU64LE(data, 34),
    cleared: (data[42] ?? 0) !== 0,
    priceQ64_64: readU128LE(data, 50),
    totalTokenSupply: readU64LE(data, 66),
    totalTokenDemand: readU64LE(data, 74),
    totalTokenCleared: readU64LE(data, 82),
  }
}

export type BatchIntent = {
  epoch: bigint
  side: number
  amountIn: bigint
  maxDeviationBps: number
  minOut: bigint
  cleared: boolean
  cancelled: boolean
  claimed: boolean
  priceQ64_64: bigint
  filledIn: bigint
  amountOut: bigint
  refundIn: bigint
}

export function decodeIntent(data: Uint8Array): BatchIntent {
  if (data.length < 156) throw new Error('invalid_intent')
  return {
    epoch: readU64LE(data, 66),
    side: data[74] ?? 0,
    amountIn: readU64LE(data, 82),
    maxDeviationBps: readU16LE(data, 90),
    minOut: readU64LE(data, 92),
    cleared: (data[108] ?? 0) !== 0,
    cancelled: (data[109] ?? 0) !== 0,
    claimed: (data[110] ?? 0) !== 0,
    priceQ64_64: readU128LE(data, 116),
    filledIn: readU64LE(data, 132),
    amountOut: readU64LE(data, 140),
    refundIn: readU64LE(data, 148),
  }
}

export function batchIntentPda(
  programId: PublicKey,
  market: PublicKey,
  wallet: PublicKey,
  epoch: bigint,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_PREFIX, SEED_BATCH, SEED_INTENT, market.toBuffer(), wallet.toBuffer(), u64LeBytes(epoch)],
    programId,
  )[0]
}

export function batchEpochPda(
  programId: PublicKey,
  market: PublicKey,
  epoch: bigint,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [SEED_PREFIX, SEED_BATCH, SEED_EPOCH, market.toBuffer(), u64LeBytes(epoch)],
    programId,
  )[0]
}

export function currentEpochForSlot(
  slot: bigint,
  scheduleStartSlot: bigint,
  auctionDurationSlots: bigint,
): bigint {
  if (auctionDurationSlots <= 0n) return 0n
  if (slot < scheduleStartSlot) return 0n
  return (slot - scheduleStartSlot) / auctionDurationSlots
}
