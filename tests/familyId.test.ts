import { describe, expect, it } from 'vitest'
import { assertFamilyId, isValidFamilyId } from '../shared/familyId'

describe('production family id validation', () => {
  it('accepts a Firestore-safe legacy segment and the production auto-id form', () => {
    expect(isValidFamilyId('family-legacy_01')).toBe(true)
    expect(isValidFamilyId('AbCdEfGhIjKlMnOpQrSt')).toBe(true)
    expect(assertFamilyId('AbCdEfGhIjKlMnOpQrSt')).toBe('AbCdEfGhIjKlMnOpQrSt')
  })

  it.each(['', '.', '..', 'family/child', 'line\nbreak', 'nul\u0000byte'])(
    'rejects the forbidden document segment %j',
    value => {
      expect(isValidFamilyId(value)).toBe(false)
      expect(() => assertFamilyId(value)).toThrow(/familyId/i)
    },
  )

  it('enforces the Firestore 1500-byte UTF-8 segment limit rather than JS character count', () => {
    expect(isValidFamilyId('가'.repeat(500))).toBe(true)
    expect(isValidFamilyId('가'.repeat(501))).toBe(false)
    expect(isValidFamilyId('a'.repeat(1_500))).toBe(true)
    expect(isValidFamilyId('a'.repeat(1_501))).toBe(false)
  })

  it('rejects non-string values consistently', () => {
    expect(isValidFamilyId(undefined)).toBe(false)
    expect(isValidFamilyId(null)).toBe(false)
    expect(isValidFamilyId(123)).toBe(false)
  })
})
