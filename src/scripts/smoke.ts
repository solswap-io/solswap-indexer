import assert from 'node:assert/strict'

import { decodeEpochState } from '../batchAuction'

function testDecodeEpochState() {
  const data = new Uint8Array(90)
  new DataView(data.buffer).setBigUint64(34, 7n, true)
  data[42] = 1
  new DataView(data.buffer).setBigUint64(66, 12n, true)
  new DataView(data.buffer).setBigUint64(74, 24n, true)
  new DataView(data.buffer).setBigUint64(82, 8n, true)

  const decoded = decodeEpochState(data)
  assert.equal(decoded.epoch, 7n)
  assert.equal(decoded.cleared, true)
  assert.equal(decoded.totalTokenSupply, 12n)
  assert.equal(decoded.totalTokenDemand, 24n)
  assert.equal(decoded.totalTokenCleared, 8n)
}

function main() {
  testDecodeEpochState()
  process.stdout.write('solswap-indexer smoke tests passed\n')
}

main()
