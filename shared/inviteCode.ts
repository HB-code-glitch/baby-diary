export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const INVITE_CODE_LENGTH = 6

export type RandomByteSource = (length: number) => Uint8Array

const MAX_ALPHABET_SYMBOLS = 256
const MAX_CODE_LENGTH = 64
const MAX_RANDOM_BYTES = 4_096

function secureRandomBytes(length: number): Uint8Array {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('secure random source is unavailable')
  }
  return cryptoApi.getRandomValues(new Uint8Array(length))
}

/**
 * Samples bytes with rejection sampling. Values outside the largest complete
 * multiple of the alphabet size are discarded, so every symbol has the same
 * probability even when the alphabet size does not divide 256.
 */
export function generateUniformCode(
  alphabet: string,
  length: number,
  randomBytes: RandomByteSource = secureRandomBytes,
): string {
  const symbols = Array.from(alphabet)
  if (
    symbols.length < 2
    || symbols.length > MAX_ALPHABET_SYMBOLS
    || new Set(symbols).size !== symbols.length
  ) {
    throw new Error('invite alphabet must contain 2..256 unique symbols')
  }
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_CODE_LENGTH) {
    throw new Error('invite code length must be a positive safe integer no greater than 64')
  }

  const acceptanceLimit = 256 - (256 % symbols.length)
  const output: string[] = []
  let sampledBytes = 0

  while (output.length < length) {
    const batchLength = Math.min(64, Math.max(16, (length - output.length) * 2))
    const batch = randomBytes(batchLength)
    if (!(batch instanceof Uint8Array) || batch.length !== batchLength) {
      throw new Error('secure random source returned an invalid byte buffer')
    }
    sampledBytes += batch.length
    if (sampledBytes > MAX_RANDOM_BYTES) {
      throw new Error('secure random source did not produce an acceptable byte')
    }

    for (let index = 0; index < batch.length; index += 1) {
      const value = batch[index]
      if (value >= acceptanceLimit) continue
      output.push(symbols[value % symbols.length])
      if (output.length === length) break
    }
  }

  return output.join('')
}

export function generateInviteCode(randomBytes: RandomByteSource = secureRandomBytes): string {
  return generateUniformCode(INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH, randomBytes)
}
