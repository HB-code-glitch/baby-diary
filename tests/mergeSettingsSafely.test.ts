import { describe, it, expect } from 'vitest'
import { mergeSettingsSafely, FormSnapshot } from '../src/lib/mergeSettings'
import { AppSettings } from '../shared/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CURRENT: AppSettings = {
  baby:     { name: '민준', birthdate: '2024-03-15', gender: 'boy' },
  profile:  { uid: 'uid-1', name: '아빠', role: 'dad' },
  familyId: 'family-abc',
  firebase: null,
  language: 'ko',
  theme:    'light',
}

const EMPTY_FORM: FormSnapshot = {
  babyName:   '',
  birthdate:  '',
  babyGender: undefined,
  myName:     '',
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mergeSettingsSafely', () => {
  // ── guard: empty form must never overwrite non-empty disk data ─────────

  it('empty form: keeps all non-empty saved values intact', () => {
    const result = mergeSettingsSafely(BASE_CURRENT, EMPTY_FORM)

    expect(result.baby.name).toBe('민준')
    expect(result.baby.birthdate).toBe('2024-03-15')
    expect(result.baby.gender).toBe('boy')
    expect(result.profile.name).toBe('아빠')
  })

  it('empty form: preserves familyId, firebase, language, theme from current', () => {
    const result = mergeSettingsSafely(BASE_CURRENT, EMPTY_FORM)

    expect(result.familyId).toBe('family-abc')
    expect(result.firebase).toBeNull()
    expect(result.language).toBe('ko')
    expect(result.theme).toBe('light')
  })

  it('empty form on blank disk: results in empty fields (no data to protect)', () => {
    const blankCurrent: AppSettings = {
      baby:     { name: '', birthdate: '' },
      profile:  { uid: 'uid-2', name: '', role: 'mom' },
      familyId: '',
      firebase: null,
    }

    const result = mergeSettingsSafely(blankCurrent, EMPTY_FORM)

    expect(result.baby.name).toBe('')
    expect(result.baby.birthdate).toBe('')
    expect(result.profile.name).toBe('')
  })

  // ── normal edit: form values win when non-empty ────────────────────────

  it('partial form: non-empty form fields override saved values', () => {
    const form: FormSnapshot = {
      babyName:   '서윤',
      birthdate:  '2025-01-10',
      babyGender: 'girl',
      myName:     '엄마',
    }

    const result = mergeSettingsSafely(BASE_CURRENT, form)

    expect(result.baby.name).toBe('서윤')
    expect(result.baby.birthdate).toBe('2025-01-10')
    expect(result.baby.gender).toBe('girl')
    expect(result.profile.name).toBe('엄마')
  })

  it('partial form: only name changed, birthdate and gender protected from empty', () => {
    const form: FormSnapshot = {
      babyName:   '서준',   // changed
      birthdate:  '',        // empty — should fall back to saved
      babyGender: undefined, // empty — should fall back to saved
      myName:     '',        // empty — should fall back to saved
    }

    const result = mergeSettingsSafely(BASE_CURRENT, form)

    expect(result.baby.name).toBe('서준')        // form value used
    expect(result.baby.birthdate).toBe('2024-03-15') // kept from disk
    expect(result.baby.gender).toBe('boy')           // kept from disk
    expect(result.profile.name).toBe('아빠')         // kept from disk
  })

  it('whitespace-only form values are treated as empty (trim check)', () => {
    const form: FormSnapshot = {
      babyName:   '   ',
      birthdate:  '\t',
      babyGender: undefined,
      myName:     '  ',
    }

    const result = mergeSettingsSafely(BASE_CURRENT, form)

    // After trim, form values are empty → saved values must be kept
    expect(result.baby.name).toBe('민준')
    expect(result.baby.birthdate).toBe('2024-03-15')
    expect(result.profile.name).toBe('아빠')
  })

  // ── gender edge cases ──────────────────────────────────────────────────

  it('gender: form undefined when disk has value → keeps disk value', () => {
    const form: FormSnapshot = { ...EMPTY_FORM, babyGender: undefined }
    const result = mergeSettingsSafely(BASE_CURRENT, form)
    expect(result.baby.gender).toBe('boy')
  })

  it('gender: form value provided → uses form value (override to girl)', () => {
    const form: FormSnapshot = { ...EMPTY_FORM, babyGender: 'girl' }
    const result = mergeSettingsSafely(BASE_CURRENT, form)
    expect(result.baby.gender).toBe('girl')
  })

  it('gender: disk undefined and form undefined → undefined', () => {
    const noGenderCurrent: AppSettings = {
      ...BASE_CURRENT,
      baby: { name: '아기', birthdate: '2024-01-01' },
    }
    const result = mergeSettingsSafely(noGenderCurrent, EMPTY_FORM)
    expect(result.baby.gender).toBeUndefined()
  })

  // ── immutability ───────────────────────────────────────────────────────

  it('does not mutate the current object', () => {
    const form: FormSnapshot = { babyName: '수아', birthdate: '', babyGender: undefined, myName: '' }
    const copy = JSON.parse(JSON.stringify(BASE_CURRENT)) as AppSettings

    mergeSettingsSafely(BASE_CURRENT, form)

    expect(BASE_CURRENT.baby.name).toBe(copy.baby.name)
    expect(BASE_CURRENT.baby.birthdate).toBe(copy.baby.birthdate)
  })
})
