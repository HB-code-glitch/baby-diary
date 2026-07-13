import { describe, expect, it } from 'vitest'
import {
  FEEDING_BANDS,
  FEVER_CARE,
  FEVER_DURATION_GUIDANCE,
  FEVER_RED_FLAGS,
  GUIDANCE_ITEMS,
  GUIDANCE_MARKERS,
  evaluateFever,
  getCalendarGuidance,
  getCurrentFormulaGuidance,
  getFeedingBand,
  getGuidanceForAge,
  getGuidanceForDay,
} from '../src/lib/guidance'

describe('legacy health guidance exposure guard', () => {
  it('keeps only the minimum fever compatibility markers with Task 1 source-id seams', () => {
    expect(GUIDANCE_MARKERS.map(marker => marker.id).sort()).toEqual([
      'antipyretic_age_limits',
      'fever_red_flags',
      'fever_under_3mo_emergency',
    ])

    for (const marker of GUIDANCE_MARKERS) {
      expect(marker.sourceIds.length).toBeGreaterThan(0)
      expect(marker.sourceIds.every(id => id.startsWith('nice-'))).toBe(true)
      expect(marker.sourceLabel).toContain('NICE')
      expect(marker.titleKo).toBeTruthy()
      expect(marker.titleJa).toBeTruthy()
      expect(marker.bodyKo).toBeTruthy()
      expect(marker.bodyJa).toBeTruthy()
    }
  })

  it('removes fixed feeding quotas and stale fever-duration claims from all legacy screen data', () => {
    const exposed = JSON.stringify({
      markers: GUIDANCE_MARKERS,
      items: GUIDANCE_ITEMS,
      feedingBands: FEEDING_BANDS,
    })

    expect(exposed).not.toMatch(/formula_|960\s*m?l|24시간|24時間|3일|3日/)
    expect(exposed).not.toMatch(/KellyMom|Seattle Children|Nemours|たまひよ|mamanoko|ままのて/i)
    expect(exposed).not.toMatch(/직장 체온|直腸体温/)
  })

  it('retires fixed-day History/calendar/formula compatibility results', () => {
    expect(GUIDANCE_ITEMS).toEqual([])
    expect(FEEDING_BANDS).toEqual([])
    expect(getGuidanceForAge('2026-01-01', '2026-07-01')).toEqual([])
    expect(getCalendarGuidance('2026-01-01')).toEqual([])
    expect(getGuidanceForDay(0)).toEqual([])
    expect(getGuidanceForDay(120)).toEqual([])
    expect(getCurrentFormulaGuidance(60)).toBeNull()
    for (const ageDays of [-1, 0, 30, 90, 179, 365]) {
      expect(getFeedingBand(ageDays)).toBeNull()
    }
  })
})

describe('evaluateFever safety routing', () => {
  it('routes an 89-day-old baby at 38.0°C to urgent care', () => {
    expect(evaluateFever({
      celsius: 38,
      birthdate: '2026-04-15',
      measuredAt: '2026-07-13T12:00:00+09:00',
    })).toBe('emergency')
  })

  it('uses completed calendar months after the under-90-day rule', () => {
    const base = {
      birthdate: '2026-01-31',
      measuredAt: '2026-05-01T12:00:00+09:00',
    }
    expect(evaluateFever({ ...base, celsius: 38.3 })).toBe('warning')
    expect(evaluateFever({ ...base, celsius: 39 })).toBe('danger')
  })

  it('does not approximate the three-month boundary from 90 days', () => {
    const base = { birthdate: '2026-03-01', measuredAt: '2026-05-30T12:00:00+09:00' }
    expect(evaluateFever({ ...base, celsius: 39 })).toBe('caution')
    expect(evaluateFever({
      ...base,
      celsius: 39,
      measuredAt: '2026-06-01T12:00:00+09:00',
    })).toBe('danger')
  })

  it('uses clinician contact without a serious-diagnosis label at 39.4°C after six months', () => {
    const base = {
      birthdate: '2026-01-01',
      measuredAt: '2026-07-13T12:00:00+09:00',
    }
    expect(evaluateFever({ ...base, celsius: 39.3 })).toBe('caution')
    expect(evaluateFever({ ...base, celsius: 39.4 })).toBe('warning')
    expect(evaluateFever({ ...base, celsius: 42 })).toBe('warning')
  })

  it('routes unknown age at either 38°C+ or below 36.0°C to immediate contact', () => {
    expect(evaluateFever({ celsius: 38, birthdate: null })).toBe('emergency')
    expect(evaluateFever({ celsius: 35.9, birthdate: null })).toBe('emergency')
    expect(evaluateFever({ celsius: 36, birthdate: null })).toBeNull()
  })

  it('routes newborn low temperature below 36.0°C to urgent care', () => {
    expect(evaluateFever({
      celsius: 35.9,
      birthdate: '2026-07-01',
      measuredAt: '2026-07-13T12:00:00+09:00',
    })).toBe('emergency')
    expect(evaluateFever({
      celsius: 36,
      birthdate: '2026-07-01',
      measuredAt: '2026-07-13T12:00:00+09:00',
    })).toBeNull()
  })

  it('routes structured red flags independently of temperature', () => {
    expect(evaluateFever({
      celsius: 36.8,
      birthdate: '2026-01-01',
      measuredAt: '2026-07-13T12:00:00+09:00',
      symptomIds: ['breathing_difficulty'],
    })).toBe('emergency')
    expect(evaluateFever({
      celsius: 36.8,
      birthdate: '2026-07-01',
      measuredAt: '2026-07-13T12:00:00+09:00',
      symptomIds: ['poor_feeding'],
    })).toBe('emergency')
  })

  it('rejects NaN and infinite temperatures without producing a medical tier', () => {
    expect(evaluateFever({ celsius: Number.NaN, birthdate: null })).toBeNull()
    expect(evaluateFever({ celsius: Number.POSITIVE_INFINITY, birthdate: null })).toBeNull()
    expect(evaluateFever({ celsius: Number.NEGATIVE_INFINITY, birthdate: null })).toBeNull()
  })

  it('keeps a selected red flag urgent even when the temperature value is invalid', () => {
    expect(evaluateFever({
      celsius: Number.NaN,
      birthdate: null,
      symptomIds: ['breathing_difficulty'],
    })).toBe('emergency')
  })
})

describe('fever guidance content safety', () => {
  it('provides structured bilingual red flags with stable ids', () => {
    expect(FEVER_RED_FLAGS.length).toBeGreaterThanOrEqual(8)
    expect(FEVER_RED_FLAGS.some(flag => flag.id === 'breathing_difficulty')).toBe(true)
    expect(FEVER_RED_FLAGS.some(flag => flag.id === 'poor_feeding' && flag.newbornOnly)).toBe(true)
    for (const flag of FEVER_RED_FLAGS) {
      expect(flag.id).toBeTruthy()
      expect(flag.ko).toBeTruthy()
      expect(flag.ja).toBeTruthy()
    }
  })

  it('keeps home care neutral, source-linked, and excludes tepid sponging', () => {
    const serialized = JSON.stringify(FEVER_CARE)
    expect(FEVER_CARE.sourceIds).toEqual(['nice-fever-ng143'])
    expect(FEVER_CARE.sourceLabel).toBe('NICE NG143')
    expect(serialized).not.toMatch(/미온|ぬるま湯|spong|NHS/i)
    expect(serialized).toMatch(/수분|水分/)
    expect(serialized).toMatch(/벗기|脱がせ/)
  })

  it('uses the five-day evaluation boundary instead of old 24-hour or 3-day rules', () => {
    const serialized = JSON.stringify(FEVER_DURATION_GUIDANCE)
    expect(serialized).toMatch(/5일|5日/)
    expect(serialized).not.toMatch(/24시간|24時間|3일|3日/)
  })
})
