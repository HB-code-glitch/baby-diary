import { describe, expect, it } from 'vitest'
import { HEALTH_EVIDENCE_SOURCES } from '../src/lib/healthEvidence'
import {
  AGE_GUIDANCE_DISCLAIMER,
  AGE_GUIDANCE_ITEMS,
  AGE_STAGES,
  DEVELOPMENT_CHECKPOINTS,
  calculateAgeInCompletedDays,
  calculateCompletedCalendarMonths,
  getAgeGuidanceForDate,
  getAgeStage,
  getDevelopmentCheckpointForDate,
  getPriorityAgeGuidanceForDate,
  localizeAgeGuidance,
} from '../src/lib/ageGuidance'

describe('getAgeStage', () => {
  const calendarMonthBoundaries = [
    ['2026-04-14', 'young-infant'],
    ['2026-04-15', 'three-to-five-months'],
    ['2026-07-15', 'six-to-eight-months'],
    ['2026-10-15', 'nine-to-eleven-months'],
    ['2027-01-15', 'twelve-to-seventeen-months'],
    ['2027-07-15', 'eighteen-to-twenty-three-months'],
    ['2028-01-15', 'two-years'],
    ['2029-01-15', 'three-to-four-years'],
    ['2031-01-15', 'five-plus'],
  ] as const

  it('uses exact days only for the 0–27 day newborn boundary', () => {
    expect(getAgeStage('2026-01-01', '2026-01-01')?.id).toBe('newborn')
    expect(getAgeStage('2026-01-01', '2026-01-28')?.id).toBe('newborn')
    expect(getAgeStage('2026-01-01', '2026-01-29')?.id).toBe('young-infant')
  })

  it.each(calendarMonthBoundaries)('routes 2026-01-15 → %s to %s', (asOf, expected) => {
    expect(getAgeStage('2026-01-15', asOf)?.id).toBe(expected)
  })

  it('rejects missing, invalid, impossible, and future birthdates', () => {
    expect(getAgeStage('', '2026-07-13')).toBeNull()
    expect(getAgeStage(undefined, '2026-07-13')).toBeNull()
    expect(getAgeStage('not-a-date', '2026-07-13')).toBeNull()
    expect(getAgeStage('2026-02-30', '2026-07-13')).toBeNull()
    expect(getAgeStage('2026-07-14', '2026-07-13')).toBeNull()
  })

  it('keeps the mixed day/month stage table explicit and immutable', () => {
    expect(Object.isFrozen(AGE_STAGES)).toBe(true)
    expect(AGE_STAGES.map(stage => stage.id)).toEqual([
      'newborn',
      'young-infant',
      'three-to-five-months',
      'six-to-eight-months',
      'nine-to-eleven-months',
      'twelve-to-seventeen-months',
      'eighteen-to-twenty-three-months',
      'two-years',
      'three-to-four-years',
      'five-plus',
    ])
    expect(AGE_STAGES[0].maxCompletedDays).toBe(27)
    expect(AGE_STAGES.at(-1)?.minCompletedMonths).toBe(60)
  })
})

describe('age calculation', () => {
  it('calculates completed calendar days deterministically', () => {
    expect(calculateAgeInCompletedDays('2026-01-01', '2026-01-01')).toBe(0)
    expect(calculateAgeInCompletedDays('2026-01-01', '2026-01-29')).toBe(28)
  })

  it('clamps month-end anniversaries instead of assuming 30-day months', () => {
    expect(calculateCompletedCalendarMonths('2026-01-31', '2026-02-27')).toBe(0)
    expect(calculateCompletedCalendarMonths('2026-01-31', '2026-02-28')).toBe(1)
    expect(calculateCompletedCalendarMonths('2026-01-31', '2026-04-30')).toBe(3)
    expect(calculateCompletedCalendarMonths('2026-01-30', '2026-02-28')).toBe(1)
    expect(calculateCompletedCalendarMonths('2026-01-29', '2026-02-28')).toBe(1)
  })

  it('handles leap-day anniversaries', () => {
    expect(calculateCompletedCalendarMonths('2024-02-29', '2025-02-27')).toBe(11)
    expect(calculateCompletedCalendarMonths('2024-02-29', '2025-02-28')).toBe(12)
  })

  it('uses local calendar dates and ignores time-of-day/DST-length changes', () => {
    expect(calculateCompletedCalendarMonths('2026-03-08', new Date(2026, 5, 7, 23, 59))).toBe(2)
    expect(calculateCompletedCalendarMonths('2026-03-08', new Date(2026, 5, 8, 0, 1))).toBe(3)
    expect(calculateAgeInCompletedDays('2026-03-08', new Date(2026, 2, 9, 0, 1))).toBe(1)
  })

  it('proves six months is a calendar boundary, not day 182', () => {
    expect(calculateAgeInCompletedDays('2026-01-01', '2026-07-01')).toBe(181)
    expect(calculateCompletedCalendarMonths('2026-01-01', '2026-07-01')).toBe(6)
    expect(getAgeStage('2026-01-01', '2026-07-01')?.id).toBe('six-to-eight-months')

    expect(calculateAgeInCompletedDays('2026-01-31', '2026-07-30')).toBe(180)
    expect(calculateCompletedCalendarMonths('2026-01-31', '2026-07-30')).toBe(5)
    expect(getAgeStage('2026-01-31', '2026-07-30')?.id).toBe('three-to-five-months')
    expect(getAgeStage('2026-01-31', '2026-07-31')?.id).toBe('six-to-eight-months')
  })

  it('returns null for missing, malformed, impossible, or future birthdates', () => {
    expect(calculateAgeInCompletedDays('', '2026-07-13')).toBeNull()
    expect(calculateAgeInCompletedDays(undefined, '2026-07-13')).toBeNull()
    expect(calculateAgeInCompletedDays('not-a-date', '2026-07-13')).toBeNull()
    expect(calculateAgeInCompletedDays('2026-02-30', '2026-07-13')).toBeNull()
    expect(calculateAgeInCompletedDays('2026-07-14', '2026-07-13')).toBeNull()
    expect(calculateCompletedCalendarMonths('', '2026-07-13')).toBeNull()
    expect(calculateCompletedCalendarMonths('2026-07-14', '2026-07-13')).toBeNull()
  })
})

describe('AGE_GUIDANCE_ITEMS', () => {
  it('has complete bilingual text and immutable nested data', () => {
    expect(Object.isFrozen(AGE_GUIDANCE_ITEMS)).toBe(true)
    for (const item of AGE_GUIDANCE_ITEMS) {
      expect(item.titleKo.trim(), `${item.id} titleKo`).not.toBe('')
      expect(item.titleJa.trim(), `${item.id} titleJa`).not.toBe('')
      expect(item.summaryKo.trim(), `${item.id} summaryKo`).not.toBe('')
      expect(item.summaryJa.trim(), `${item.id} summaryJa`).not.toBe('')
      expect(item.actionsKo.length, `${item.id} actionsKo`).toBeGreaterThan(0)
      expect(item.actionsJa.length, `${item.id} actionsJa`).toBe(item.actionsKo.length)
      expect(item.actionsKo.every(action => action.trim().length > 0)).toBe(true)
      expect(item.actionsJa.every(action => action.trim().length > 0)).toBe(true)
      expect(item.sourceIds.length, `${item.id} sources`).toBeGreaterThan(0)
      expect(Object.isFrozen(item)).toBe(true)
      expect(Object.isFrozen(item.actionsKo)).toBe(true)
      expect(Object.isFrozen(item.actionsJa)).toBe(true)
      expect(Object.isFrozen(item.sourceIds)).toBe(true)
    }
  })

  it('maps every item to a valid stage and official source ID', () => {
    const stageIds = new Set(AGE_STAGES.map(stage => stage.id))
    const sourceIds = new Set(HEALTH_EVIDENCE_SOURCES.map(source => source.id))

    for (const item of AGE_GUIDANCE_ITEMS) {
      expect(stageIds.has(item.stageId), item.id).toBe(true)
      for (const sourceId of item.sourceIds) {
        expect(sourceIds.has(sourceId), `${item.id}: ${sourceId}`).toBe(true)
      }
    }
  })

  it('does not contain retired risk marketing, fixed quotas, or commercial labels', () => {
    const allText = JSON.stringify([AGE_GUIDANCE_ITEMS, DEVELOPMENT_CHECKPOINTS])
    const normalized = allText.toLowerCase().replace(/[\s,_~〜·-]+/g, '')
    for (const forbidden of [
      '2.313.1',
      '80%감소',
      '79%감소',
      '960ml',
      '1000ml',
      '400iu로수렴',
      '58iu/l',
      'leap연구',
      'petit연구',
      '더원하면이유식',
      '남은양',
      '残りの量',
      '다음수유시간',
      '次の授乳時間',
      'nextfeed',
      '6시간간격',
      '6時間間隔',
      '발달지연입니다',
      '発達遅滞です',
      'seattlechildren',
      'nemours',
      'kellymom',
      'mamanoko',
    ]) {
      expect(normalized, forbidden).not.toContain(forbidden)
    }
  })

  it('includes a conservative corrected-age and clinical-plan disclaimer in both languages', () => {
    expect(AGE_GUIDANCE_DISCLAIMER.ko).toContain('교정 연령')
    expect(AGE_GUIDANCE_DISCLAIMER.ko).toContain('진료 계획')
    expect(AGE_GUIDANCE_DISCLAIMER.ja).toContain('修正月齢')
    expect(AGE_GUIDANCE_DISCLAIMER.ja).toContain('診療計画')
  })

  it('states both-direction rolling and stop-swaddling-at-first-attempt rules', () => {
    const sleep = AGE_GUIDANCE_ITEMS.find(item => item.id === 'infant-safe-sleep')
    expect(sleep).toBeDefined()
    expect(sleep?.actionsKo.join(' ')).toContain('양방향으로 스스로 뒤집')
    expect(sleep?.actionsKo.join(' ')).toContain('뒤집으려는 시도')
    expect(sleep?.actionsKo.join(' ')).toContain('속싸개를 중단')
    expect(sleep?.actionsJa.join(' ')).toContain('両方向に自分で寝返り')
    expect(sleep?.actionsJa.join(' ')).toContain('寝返りを試みたら')
    expect(sleep?.actionsJa.join(' ')).toContain('おくるみをやめ')
  })

  it('keeps newborn hypothermia and young-infant fever in the top urgent guidance', () => {
    const newborn = AGE_GUIDANCE_ITEMS.find(item => item.id === 'newborn-urgent-signs')!
    expect(newborn.actionsKo.join(' ')).toContain('35.5°C 미만')
    expect(newborn.actionsJa.join(' ')).toContain('35.5°C未満')

    const young = AGE_GUIDANCE_ITEMS.find(item => item.id === 'young-infant-fever')!
    expect(young.priority).toBeLessThanOrEqual(3)
    expect(young.urgency).toBe('urgent')
    expect(young.actionsKo.join(' ')).toContain('38°C 이상')
    expect(young.actionsJa.join(' ')).toContain('38°C以上')
  })

  it('keeps safe sleep through 11 months and age-specific accident prevention', () => {
    const sixEight = AGE_GUIDANCE_ITEMS.filter(item => item.stageId === 'six-to-eight-months')
    expect(sixEight.some(item => item.category === 'safe-sleep')).toBe(true)

    const accidentStages = new Set(
      AGE_GUIDANCE_ITEMS
        .filter(item => item.id.endsWith('accident-prevention'))
        .map(item => item.stageId)
    )
    for (const stageId of [
      'three-to-five-months',
      'six-to-eight-months',
      'nine-to-eleven-months',
      'twelve-to-seventeen-months',
      'eighteen-to-twenty-three-months',
    ]) {
      expect(accidentStages.has(stageId as never), stageId).toBe(true)
    }
  })

  it('has no known Korean copy typo and keeps Korean/Japanese action counts parallel', () => {
    expect(JSON.stringify(AGE_GUIDANCE_ITEMS)).not.toContain('피행요')
    for (const item of AGE_GUIDANCE_ITEMS) {
      expect(item.actionsJa.length, item.id).toBe(item.actionsKo.length)
    }
  })
})

describe('development checkpoint selector', () => {
  it('covers every CDC milestone checkpoint without using the broad stage as the selector', () => {
    expect(DEVELOPMENT_CHECKPOINTS.map(checkpoint => checkpoint.completedMonth)).toEqual([
      2, 4, 6, 9, 12, 15, 18, 24, 30, 36, 48, 60,
    ])

    for (const month of [2, 4, 6, 9, 12, 15, 18, 24, 30, 36, 48, 60]) {
      const year = 2026 + Math.floor(month / 12)
      const calendarMonth = (month % 12) + 1
      const asOf = `${year}-${String(calendarMonth).padStart(2, '0')}-15`
      expect(getDevelopmentCheckpointForDate('2026-01-15', asOf)?.completedMonth).toBe(month)
    }
  })

  it('does not show a future checkpoint before its calendar-month boundary', () => {
    expect(getDevelopmentCheckpointForDate('2026-01-31', '2026-05-30')?.completedMonth).toBe(2)
    expect(getDevelopmentCheckpointForDate('2026-01-31', '2026-05-31')?.completedMonth).toBe(4)
    expect(getDevelopmentCheckpointForDate('2026-01-15', '2026-03-14')).toBeNull()
  })

  it('labels general and autism screening months as discussion prompts, not diagnoses', () => {
    const at9 = DEVELOPMENT_CHECKPOINTS.find(item => item.completedMonth === 9)!
    const at18 = DEVELOPMENT_CHECKPOINTS.find(item => item.completedMonth === 18)!
    const at24 = DEVELOPMENT_CHECKPOINTS.find(item => item.completedMonth === 24)!
    const at30 = DEVELOPMENT_CHECKPOINTS.find(item => item.completedMonth === 30)!

    expect(at9.screening).toEqual(['developmental'])
    expect(at18.screening).toEqual(['developmental', 'autism'])
    expect(at24.screening).toEqual(['autism'])
    expect(at30.screening).toEqual(['developmental'])
    for (const item of [at9, at18, at24, at30]) {
      expect(item.actionsKo.join(' ')).toContain('의료진과 상의')
      expect(item.actionsJa.join(' ')).toContain('医療者に相談')
      expect(item.sourceIds).toContain('cdc-developmental-screening')
    }
  })
})

describe('age guidance selectors', () => {
  it('returns no generic advice when age is missing or invalid', () => {
    expect(getAgeGuidanceForDate('', '2026-07-13')).toEqual([])
    expect(getAgeGuidanceForDate('2026-07-14', '2026-07-13')).toEqual([])
  })

  it('returns at most three current priorities before disclosure for every stage', () => {
    const examples = [
      ['2026-01-15', '2026-01-20', 'newborn'],
      ['2026-01-15', '2026-02-15', 'young-infant'],
      ['2026-01-15', '2026-04-15', 'three-to-five-months'],
      ['2026-01-15', '2026-07-15', 'six-to-eight-months'],
      ['2026-01-15', '2026-10-15', 'nine-to-eleven-months'],
      ['2026-01-15', '2027-01-15', 'twelve-to-seventeen-months'],
      ['2026-01-15', '2027-07-15', 'eighteen-to-twenty-three-months'],
      ['2026-01-15', '2028-01-15', 'two-years'],
      ['2026-01-15', '2029-01-15', 'three-to-four-years'],
      ['2026-01-15', '2031-01-15', 'five-plus'],
    ] as const

    for (const [birthdate, asOf, stageId] of examples) {
      const priorities = getPriorityAgeGuidanceForDate(birthdate, asOf)
      expect(priorities.length, stageId).toBeGreaterThan(0)
      expect(priorities.length, stageId).toBeLessThanOrEqual(3)
      expect(priorities.every(item => item.stageId === stageId)).toBe(true)
    }
  })

  it('retires infant advice at 5 years instead of extrapolating it', () => {
    const items = getAgeGuidanceForDate('2021-07-13', '2026-07-13')
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(item => item.stageId === 'five-plus')).toBe(true)
    expect(items.some(item => item.id === 'five-plus-local-care-kr')).toBe(true)
    expect(items.some(item => item.category === 'feeding')).toBe(false)
    expect(items.some(item => item.category === 'safe-sleep')).toBe(false)
  })

  it('returns both countries when residence is unknown and filters only on explicit country', () => {
    const unknown = getAgeGuidanceForDate('2026-01-15', '2026-05-15')
    const kr = getAgeGuidanceForDate('2026-01-15', '2026-05-15', 'KR')
    const jp = getAgeGuidanceForDate('2026-01-15', '2026-05-15', 'JP')

    expect(unknown.some(item => item.country === 'KR')).toBe(true)
    expect(unknown.some(item => item.country === 'JP')).toBe(true)
    expect(kr.some(item => item.country === 'KR')).toBe(true)
    expect(kr.some(item => item.country === 'JP')).toBe(false)
    expect(jp.some(item => item.country === 'JP')).toBe(true)
    expect(jp.some(item => item.country === 'KR')).toBe(false)
  })

  it('localizes content without inferring country or losing source order', () => {
    const item = getAgeGuidanceForDate('2026-01-15', '2026-07-15')
      .find(candidate => candidate.country === 'KR')!
    const ko = localizeAgeGuidance(item, 'ko')
    const ja = localizeAgeGuidance(item, 'ja')

    expect(ko.id).toBe(item.id)
    expect(ja.id).toBe(item.id)
    expect(ko.title).toBe(item.titleKo)
    expect(ja.title).toBe(item.titleJa)
    expect(ko.actions).toEqual(item.actionsKo)
    expect(ja.actions).toEqual(item.actionsJa)
    expect(ko.sourceIds).toEqual(item.sourceIds)
    expect(ja.country).toBe('KR')
    expect(Object.isFrozen(ko)).toBe(true)
    expect(Object.isFrozen(ko.actions)).toBe(true)
  })
})
