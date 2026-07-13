import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HEALTH_EVIDENCE_SOURCES, getEvidenceSources } from '../src/lib/healthEvidence'
import {
  FEEDING_BANDS,
  FEVER_CARE,
  FEVER_DURATION_GUIDANCE,
  FEVER_RED_FLAGS,
  GUIDANCE_ITEMS,
  GUIDANCE_MARKERS,
  GUIDANCE_SOURCES,
  evaluateFever,
  getCalendarGuidance,
  getCurrentFormulaGuidance,
  getFeedingBand,
  getFeverAgeContext,
  getGuidanceForAge,
  getGuidanceForDay,
} from '../src/lib/guidance'

describe('legacy health guidance exposure guard', () => {
  it('fully retires legacy marker cards from Settings', () => {
    expect(GUIDANCE_MARKERS).toEqual([])
  })

  it('uses the shared registry type and actual official source view without a pending seam', () => {
    const source = readFileSync('src/lib/guidance.ts', 'utf8')

    expect(source).toContain('HealthEvidenceSourceId')
    expect(source).not.toMatch(/PendingHealthEvidenceSourceId|TODO\(Task 1 integration\)/)
    expect(GUIDANCE_SOURCES).toHaveLength(HEALTH_EVIDENCE_SOURCES.length)
    for (const item of GUIDANCE_SOURCES) {
      const official = HEALTH_EVIDENCE_SOURCES.find(sourceItem => sourceItem.id === item.id)
      expect(official).toBeDefined()
      expect(item).not.toHaveProperty('url')
      expect(official).not.toHaveProperty('url')
      expect(item.reviewedOn).toBe(official?.reviewedOn)
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

  it('uses completed calendar months after both young-infant boundaries are crossed', () => {
    const base = {
      birthdate: '2026-01-31',
      measuredAt: '2026-05-01T12:00:00+09:00',
    }
    expect(evaluateFever({ ...base, celsius: 38.3 })).toBe('warning')
    expect(evaluateFever({ ...base, celsius: 39 })).toBe('danger')
  })

  it('keeps a 90-day-old baby urgent until the three-calendar-month boundary', () => {
    const base = { birthdate: '2026-03-01', measuredAt: '2026-05-30T12:00:00+09:00' }
    expect(getFeverAgeContext(base.birthdate, base.measuredAt)).toEqual({
      ageDays: 90,
      completedMonths: 2,
    })
    expect(evaluateFever({ ...base, celsius: 39 })).toBe('emergency')
    expect(evaluateFever({
      ...base,
      celsius: 39,
      measuredAt: '2026-06-01T12:00:00+09:00',
    })).toBe('danger')
  })

  it.each([
    ['28-day birth', '2026-01-28', '2026-04-27', '2026-04-28', '2026-04-28'],
    ['30-day birth', '2026-01-30', '2026-04-29', '2026-04-30', '2026-04-30'],
    ['31-day birth', '2026-01-31', '2026-04-29', '2026-04-30', '2026-05-01'],
    ['February 28 birth', '2026-02-28', '2026-05-27', '2026-05-28', '2026-05-29'],
    ['leap-day birth', '2024-02-29', '2024-05-28', '2024-05-29', '2024-05-29'],
    ['March 31 birth', '2026-03-31', '2026-06-29', '2026-06-30', '2026-06-30'],
  ])(
    'requires both 90 days and three completed calendar months for a %s',
    (_label, birthdate, dayBeforeThreeMonths, threeMonthDate, firstDatePastBoth) => {
      const before = getFeverAgeContext(birthdate, dayBeforeThreeMonths)
      const atThreeMonths = getFeverAgeContext(birthdate, threeMonthDate)
      const pastBoth = getFeverAgeContext(birthdate, firstDatePastBoth)

      expect(before?.completedMonths).toBe(2)
      expect(atThreeMonths?.completedMonths).toBe(3)
      expect(pastBoth?.ageDays).toBeGreaterThanOrEqual(90)
      expect(pastBoth?.completedMonths).toBeGreaterThanOrEqual(3)
      expect(evaluateFever({ celsius: 39, birthdate, measuredAt: dayBeforeThreeMonths })).toBe('emergency')
      expect(evaluateFever({ celsius: 39, birthdate, measuredAt: threeMonthDate })).toBe(
        atThreeMonths!.ageDays < 90 ? 'emergency' : 'danger'
      )
      expect(evaluateFever({ celsius: 39, birthdate, measuredAt: firstDatePastBoth })).toBe('danger')
    }
  )

  it.each(['UTC', 'Asia/Tokyo', 'America/New_York'])(
    'keeps date-only fever boundaries as local civil dates in %s',
    timeZone => {
      const root = process.cwd()
      const result = spawnSync(
        process.execPath,
        [
          join(root, 'node_modules', 'vite-node', 'vite-node.mjs'),
          join(root, 'tests', 'fixtures', 'feverAgeTimezoneProbe.ts'),
        ],
        {
          cwd: root,
          env: { ...process.env, TZ: timeZone },
          encoding: 'utf8',
        }
      )

      expect(result.status, result.stderr).toBe(0)
      const output = JSON.parse(result.stdout)
      expect(output.timeZone).toBe(timeZone)
      expect(output.dateOnly).toEqual({
        day89: { ageDays: 89, completedMonths: 2 },
        day90BeforeThreeMonths: { ageDays: 90, completedMonths: 2 },
        threeMonthsBefore90Days: { ageDays: 89, completedMonths: 3 },
        pastBoth: { ageDays: 90, completedMonths: 3 },
        beforeSixMonths: { ageDays: 181, completedMonths: 5 },
        sixMonths: { ageDays: 182, completedMonths: 6 },
      })
      expect(output.levels).toEqual({
        day89: 'emergency',
        day90BeforeThreeMonths: 'emergency',
        threeMonthsBefore90Days: 'emergency',
        pastBoth: 'danger',
        beforeSixMonths: 'danger',
        sixMonths: 'warning',
      })
      expect(output.dateObject).toEqual(output.timestamp)
      expect(output.timestamp.ageDays).toBe(timeZone === 'America/New_York' ? 89 : 90)
    }
  )

  it('keeps invalid age inputs conservative', () => {
    expect(getFeverAgeContext('not-a-date', '2026-07-14')).toBeNull()
    expect(getFeverAgeContext('2026-04-15', 'not-a-date')).toBeNull()
    expect(getFeverAgeContext('2026-04-15', '2026-02-30')).toBeNull()
    expect(getFeverAgeContext('2026-04-15', new Date(Number.NaN))).toBeNull()
    expect(evaluateFever({
      celsius: 38,
      birthdate: '2026-04-15',
      measuredAt: 'not-a-date',
    })).toBe('emergency')
  })

  it('keeps the newborn boundary on exact completed days', () => {
    expect(evaluateFever({
      celsius: 35.9,
      birthdate: '2026-01-01',
      measuredAt: '2026-01-28',
    })).toBe('emergency')
    expect(evaluateFever({
      celsius: 35.9,
      birthdate: '2026-01-01',
      measuredAt: '2026-01-29',
    })).toBeNull()
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
    expect('sourceLabel' in FEVER_CARE).toBe(false)
    expect(getEvidenceSources(FEVER_CARE.sourceIds, 'ko')[0].organization).toBeTruthy()
    expect(getEvidenceSources(FEVER_CARE.sourceIds, 'ja')[0].organization).toBeTruthy()
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
