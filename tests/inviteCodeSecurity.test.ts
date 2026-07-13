import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  generateInviteCode,
  generateUniformCode,
  type RandomByteSource,
} from '../shared/inviteCode'

function queuedBytes(values: readonly number[], fallback = 0): RandomByteSource {
  let index = 0
  return (length: number) => {
    const bytes = new Uint8Array(length)
    for (let position = 0; position < length; position += 1) {
      bytes[position] = values[index] ?? fallback
      index += 1
    }
    return bytes
  }
}

describe('secure invite codes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the existing unambiguous six-character alphabet', () => {
    expect(INVITE_CODE_LENGTH).toBe(6)
    expect(INVITE_CODE_ALPHABET).toBe('ABCDEFGHJKLMNPQRSTUVWXYZ23456789')
    expect(new Set(INVITE_CODE_ALPHABET).size).toBe(INVITE_CODE_ALPHABET.length)
    expect(INVITE_CODE_ALPHABET).not.toMatch(/[01IO]/)
  })

  it('uses injected bytes deterministically without Math.random', () => {
    const source = queuedBytes([0, 1, 2, 3, 4, 5])
    expect(generateInviteCode(source)).toBe('ABCDEF')
  })

  it('rejects bytes above the largest unbiased range instead of applying modulo directly', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234' // 30 symbols; accepts only 0..239
    const source = queuedBytes([255, 240, 0, 29])
    expect(generateUniformCode(alphabet, 2, source)).toBe('A4')
  })

  it('fails closed when Web Crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined)
    expect(() => generateInviteCode()).toThrow(/secure random/i)
  })

  it('fails closed for malformed or non-progressing random sources', () => {
    expect(() => generateInviteCode(() => new Uint8Array(0))).toThrow(/random source/i)
    expect(() => generateUniformCode('ABC', 1, queuedBytes([], 255))).toThrow(/random source/i)
  })

  it('rejects unsafe alphabets and lengths', () => {
    const source = queuedBytes([0])
    expect(() => generateUniformCode('A', 6, source)).toThrow(/alphabet/i)
    expect(() => generateUniformCode('AABC', 6, source)).toThrow(/alphabet/i)
    expect(() => generateUniformCode('ABC', 0, source)).toThrow(/length/i)
  })
})
