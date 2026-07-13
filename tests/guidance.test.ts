import { describe, expect, it } from 'vitest'
import { HEALTH_EVIDENCE_SOURCES } from '../src/lib/healthEvidence'
import {
  GUIDANCE_DISCLAIMER,
  GUIDANCE_ITEMS,
  GUIDANCE_MARKERS,
  GUIDANCE_SOURCES,
  getCalendarGuidance,
  getCurrentFormulaGuidance,
  getGuidanceForAge,
  getGuidanceForDay,
} from '../src/lib/guidance'

describe('legacy guidance compatibility', () => {
  it('keeps only the minimum fever markers required until the structured modal replaces them', () => {
    expect(GUIDANCE_MARKERS.map(marker => marker.id).sort()).toEqual([
      'antipyretic_age_limits',
      'fever_red_flags',
      'fever_under_3mo_emergency',
    ])
    for (const marker of GUIDANCE_MARKERS) {
      expect(marker.titleKo).toBeTruthy()
      expect(marker.titleJa).toBeTruthy()
      expect(marker.bodyKo).toBeTruthy()
      expect(marker.bodyJa).toBeTruthy()
      expect(marker.sourceLabel).toMatch(/NICE/)
      expect(marker.sourceIds.length).toBeGreaterThan(0)
      expect(Object.isFrozen(marker.sourceIds)).toBe(true)
      for (const sourceId of marker.sourceIds) {
        expect(HEALTH_EVIDENCE_SOURCES.some(source => source.id === sourceId)).toBe(true)
      }
      expect(marker.evidenceLevel).toBe('guideline-consensus')
    }
  })

  it('does not expose retired formula, weaning, supplement, or risk-marketing prose', () => {
    const text = JSON.stringify(GUIDANCE_MARKERS).toLowerCase().replace(/[\s,_~〜·-]+/g, '')
    for (const forbidden of [
      'formula_',
      'weaning_',
      'allergen_',
      '2.313.1',
      '960ml',
      '1000ml',
      '58iu/l',
      '400iu로수렴',
      '80%감소',
      '79%감소',
      '더원하면이유식',
      'seattlechildren',
      'nemours',
    ]) {
      expect(text, forbidden).not.toContain(forbidden)
    }
  })

  it('retires fixed-day History/calendar guidance completely', () => {
    expect(GUIDANCE_ITEMS).toEqual([])
    expect(getGuidanceForAge('2026-01-01', '2026-07-01')).toEqual([])
    expect(getCalendarGuidance('2026-01-01')).toEqual([])
    expect(getGuidanceForDay(0)).toEqual([])
    expect(getGuidanceForDay(120)).toEqual([])
    expect(getCurrentFormulaGuidance(30)).toBeNull()
  })

  it('keeps fever key sentences complete without claiming a measurement site', () => {
    const fever = GUIDANCE_MARKERS.find(marker => marker.id === 'fever_under_3mo_emergency')!
    expect(fever.quoteKo).toContain('38.0°C 이상')
    expect(fever.quoteJa).toContain('38.0°C以上')
    expect(fever.quoteKo).not.toContain('직장')
    expect(fever.quoteJa).not.toContain('直腸')
    expect(fever.bodyKo).not.toContain('앱은')
    expect(fever.bodyJa).not.toContain('アプリは')
  })

  it('derives legacy source labels from typed registry source IDs', () => {
    const marker = GUIDANCE_MARKERS.find(item => item.id === 'fever_red_flags')!
    expect(marker.sourceIds).toEqual(['nice-fever-ng143', 'nice-newborn-red-flags-ng194'])
    const organizations = marker.sourceIds.map(id =>
      HEALTH_EVIDENCE_SOURCES.find(source => source.id === id)!.organization.ko
    )
    for (const organization of organizations) {
      expect(marker.sourceLabel).toContain(organization)
    }
  })
})

describe('legacy disclaimer and source view', () => {
  it('includes individual clinical plans and corrected age in both languages', () => {
    expect(GUIDANCE_DISCLAIMER.ko).toContain('교정 연령')
    expect(GUIDANCE_DISCLAIMER.ko).toContain('진료 계획')
    expect(GUIDANCE_DISCLAIMER.ja).toContain('修正月齢')
    expect(GUIDANCE_DISCLAIMER.ja).toContain('診療計画')
  })

  it('is derived from the immutable official registry without guessed publication years', () => {
    expect(GUIDANCE_SOURCES).toHaveLength(HEALTH_EVIDENCE_SOURCES.length)
    for (const source of GUIDANCE_SOURCES) {
      const official = HEALTH_EVIDENCE_SOURCES.find(item => item.id === source.id)
      expect(official).toBeDefined()
      expect(source.url).toBe(official?.url)
      expect(source.reviewedOn).toBe(official?.reviewedOn)
      expect('year' in source).toBe(false)
    }
  })
})
