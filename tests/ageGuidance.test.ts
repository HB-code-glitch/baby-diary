import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
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
    ['2031-01-15', 'five-years'],
    ['2032-01-15', 'older-child-fallback'],
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
      'five-years',
      'older-child-fallback',
    ])
    expect(AGE_STAGES[0].maxCompletedDays).toBe(27)
    expect(AGE_STAGES.find(stage => stage.id === 'five-years')).toMatchObject({
      minCompletedMonths: 60,
      maxCompletedMonths: 71,
    })
    expect(AGE_STAGES.at(-1)?.minCompletedMonths).toBe(72)
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

  it('counts local-midnight days in an isolated real DST zone', () => {
    const root = process.cwd()
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules', 'vite-node', 'vite-node.mjs'),
        join(root, 'tests', 'fixtures', 'ageGuidanceDstProbe.ts'),
      ],
      {
        cwd: root,
        env: { ...process.env, TZ: 'America/New_York' },
        encoding: 'utf8',
      }
    )

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      timeZone: 'America/New_York',
      springHours: 23,
      fallHours: 25,
      springDays: 1,
      fallDays: 1,
    })
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
      '강제할당량',
      '앱은',
      'アプリは',
      '添い寝',
      '評価を受け',
      '達成点',
      'cdcresponsivefeeding',
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
    expect(newborn.actionsKo.join(' ')).toContain('36°C 미만')
    expect(newborn.actionsJa.join(' ')).toContain('36°C未満')

    const feeding = AGE_GUIDANCE_ITEMS.find(item => item.id === 'newborn-responsive-feeding')!
    expect(feeding.actionsKo.join(' ')).toContain('즉시 의료진과 상의')
    expect(feeding.actionsJa.join(' ')).toContain('直ちに医療者へ相談')

    const young = AGE_GUIDANCE_ITEMS.find(item => item.id === 'young-infant-fever')!
    expect(young.priority).toBeLessThanOrEqual(3)
    expect(young.urgency).toBe('urgent')
    expect(young.actionsKo.join(' ')).toContain('38°C 이상')
    expect(young.actionsJa.join(' ')).toContain('38°C以上')
    expect(young.summaryJa).toContain('診察を受けてください')
  })

  it('shows the 3–5 month fever thresholds without mixing them into older stages', () => {
    const fever = AGE_GUIDANCE_ITEMS.find(item => item.id === 'three-five-fever')!
    expect(fever.actionsKo.join(' ')).toContain('38.3°C 이상')
    expect(fever.actionsKo.join(' ')).toContain('39.0°C 이상')
    expect(fever.actionsJa.join(' ')).toContain('38.3°C以上')
    expect(fever.actionsJa.join(' ')).toContain('39.0°C以上')
    expect(fever.sourceIds).toEqual(['aap-fever-baby', 'nice-fever-ng143'])
  })

  it('separates common red flags from young-infant-only signs', () => {
    const preschool = AGE_GUIDANCE_ITEMS.find(item => item.id === 'three-to-four-years-urgent-care')!
    const preschoolText = `${preschool.summaryKo} ${preschool.actionsKo.join(' ')}`
    expect(preschoolText).toContain('초록색 담즙성 구토')
    expect(preschoolText).not.toContain('대천문')
    expect(preschoolText).not.toContain('분출성')
    expect(preschool.sourceIds).toEqual(['nice-fever-ng143'])

    const infantOnly = AGE_GUIDANCE_ITEMS.find(item => item.id === 'young-infant-specific-urgent-care')!
    expect(infantOnly.actionsKo.join(' ')).toContain('대천문')
    expect(infantOnly.actionsJa.join(' ')).toContain('大泉門')
    expect(infantOnly.sourceIds).toContain('nice-newborn-red-flags-ng194')
  })

  it('shows concrete 12- and 15-month observations in the stage card', () => {
    const item = AGE_GUIDANCE_ITEMS.find(candidate => candidate.id === 'twelve-seventeen-development')!
    expect(item.actionsKo.join(' ')).toContain('손을 흔들')
    expect(item.actionsKo.join(' ')).toContain('가리키')
    expect(item.actionsJa.join(' ')).toContain('手を振る')
    expect(item.actionsJa.join(' ')).toContain('指さす')
  })

  it('maps Korean and Japanese 119 guidance to each country authority', () => {
    const kr = AGE_GUIDANCE_ITEMS.find(item => item.id === 'newborn-emergency-kr')!
    const jp = AGE_GUIDANCE_ITEMS.find(item => item.id === 'newborn-emergency-jp')!
    expect(kr).toMatchObject({ country: 'KR', linkPurpose: 'emergency' })
    expect(kr.sourceIds).toEqual(['kr-nfa-119'])
    expect(jp).toMatchObject({ country: 'JP', linkPurpose: 'emergency' })
    expect(jp.sourceIds).toEqual(['jp-fdma-119'])
  })

  it('uses age-scoped nutrition sources from 24 through 71 months', () => {
    for (const id of ['two-years-family-food-oral', 'three-four-nutrition-oral', 'five-years-nutrition-oral']) {
      const item = AGE_GUIDANCE_ITEMS.find(candidate => candidate.id === id)!
      expect(item.sourceIds, id).toContain('who-healthy-diet')
      expect(item.sourceIds, id).toContain('cdc-picky-eaters')
      expect(item.sourceIds, id).toContain('cdc-child-oral-health')
      expect(item.sourceIds, id).not.toContain('who-complementary-feeding')
    }
  })

  it('keeps key Korean and Japanese safety actions semantically paired', () => {
    const sleep = AGE_GUIDANCE_ITEMS.find(item => item.id === 'infant-safe-sleep')!
    expect(`${sleep.summaryKo} ${sleep.actionsKo.join(' ')}`).toMatch(/등을 대고|등으로/)
    expect(`${sleep.summaryJa} ${sleep.actionsJa.join(' ')}`).toContain('あおむけ')
    expect(sleep.actionsKo.join(' ')).toContain('단단')
    expect(sleep.actionsJa.join(' ')).toContain('硬')

    const food = AGE_GUIDANCE_ITEMS.find(item => item.id === 'six-eight-responsive-meals')!
    expect(`${food.summaryKo} ${food.actionsKo.join(' ')}`).toContain('철분')
    expect(`${food.summaryJa} ${food.actionsJa.join(' ')}`).toContain('鉄')

    const urgent = AGE_GUIDANCE_ITEMS.find(item => item.id === 'three-to-four-years-urgent-care')!
    expect(urgent.summaryKo).toMatch(/호흡곤란.*청색.*경련/)
    expect(urgent.summaryJa).toMatch(/呼吸困難.*青い.*けいれん/)
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

  it('makes every checkpoint an observation prompt with a not-yet trigger and no diagnosis', () => {
    for (const item of DEVELOPMENT_CHECKPOINTS) {
      expect(item.actionsKo.join(' '), `${item.completedMonth}m ko`).toContain('아직 못 하는 항목')
      expect(item.actionsJa.join(' '), `${item.completedMonth}m ja`).toContain('まだできていない項目')
      expect(item.actionsKo.join(' '), `${item.completedMonth}m ko`).toContain('진단이 아니')
      expect(item.actionsJa.join(' '), `${item.completedMonth}m ja`).toContain('診断ではありませ')
    }
  })

  it('shows the 60-month checkpoint only through 71 months and retires it at 72 months', () => {
    expect(getDevelopmentCheckpointForDate('2026-01-15', '2031-12-15')?.completedMonth).toBe(60)
    expect(getDevelopmentCheckpointForDate('2026-01-15', '2032-01-15')).toBeNull()
    expect(getDevelopmentCheckpointForDate('2020-02-29', '2026-02-28')).toBeNull()
  })
})

describe('age guidance selectors', () => {
  it('returns no generic advice when age is missing or invalid', () => {
    expect(getAgeGuidanceForDate('', '2026-07-13')).toEqual([])
    expect(getAgeGuidanceForDate('2026-07-14', '2026-07-13')).toEqual([])
  })

  it('returns the exact first three IDs and categories for every stage', () => {
    const examples = [
      ['2026-01-20', 'newborn', ['newborn-responsive-feeding', 'infant-safe-sleep', 'newborn-urgent-signs'], ['feeding', 'safe-sleep', 'urgent-care']],
      ['2026-02-15', 'young-infant', ['young-infant-responsive-feeding', 'young-infant-safe-sleep', 'young-infant-fever'], ['feeding', 'safe-sleep', 'urgent-care']],
      ['2026-04-15', 'three-to-five-months', ['three-five-safe-sleep', 'three-five-floor-play', 'three-five-solids-readiness'], ['safe-sleep', 'activity-sleep', 'feeding']],
      ['2026-07-15', 'six-to-eight-months', ['six-eight-responsive-meals', 'six-eight-allergen-choking', 'six-eight-foods-to-avoid'], ['feeding', 'food-safety', 'food-safety']],
      ['2026-10-15', 'nine-to-eleven-months', ['nine-eleven-meals-texture', 'nine-eleven-choking', 'nine-eleven-development'], ['feeding', 'food-safety', 'development']],
      ['2027-01-15', 'twelve-to-seventeen-months', ['twelve-seventeen-family-foods', 'twelve-seventeen-activity-sleep', 'twelve-seventeen-oral-care'], ['feeding', 'activity-sleep', 'oral-health']],
      ['2027-07-15', 'eighteen-to-twenty-three-months', ['eighteen-twenty-three-development', 'eighteen-twenty-three-activity', 'eighteen-twenty-three-family-care'], ['development', 'activity-sleep', 'feeding']],
      ['2028-01-15', 'two-years', ['two-years-development', 'two-years-activity-sleep', 'two-years-family-food-oral'], ['development', 'activity-sleep', 'oral-health']],
      ['2029-01-15', 'three-to-four-years', ['three-four-development', 'three-four-activity-sleep', 'three-four-injury-prevention'], ['development', 'activity-sleep', 'general']],
      ['2031-01-15', 'five-years', ['five-years-development', 'five-years-safety', 'five-years-nutrition-oral'], ['development', 'general', 'oral-health']],
      ['2032-01-15', 'older-child-fallback', ['older-child-general-care-kr', 'older-child-emergency-kr', 'older-child-local-guidance-kr'], ['general', 'urgent-care', 'checkup-vaccination']],
    ] as const

    for (const [asOf, stageId, ids, categories] of examples) {
      const birthdate = '2026-01-15'
      const priorities = getPriorityAgeGuidanceForDate(
        birthdate,
        asOf,
        stageId === 'older-child-fallback' ? 'KR' : undefined
      )
      expect(priorities.map(item => item.id), stageId).toEqual(ids)
      expect(priorities.map(item => item.category), stageId).toEqual(categories)
      expect(priorities.every(item => item.stageId === stageId)).toBe(true)
    }
  })

  it('uses a dedicated 60–71 month stage and a general 72+ fallback', () => {
    const five = getAgeGuidanceForDate('2021-07-13', '2026-07-13')
    expect(five.every(item => item.stageId === 'five-years')).toBe(true)
    expect(five.some(item => item.id === 'five-years-development')).toBe(true)

    const items = getAgeGuidanceForDate('2020-07-13', '2026-07-13')
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(item => item.stageId === 'older-child-fallback')).toBe(true)
    expect(items.some(item => item.id === 'older-child-local-guidance-kr')).toBe(true)
    expect(items.some(item => item.category === 'urgent-care')).toBe(true)
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

  it('keeps the 72+ fallback fully country-scoped without opposite-country content or sources', () => {
    const birthdate = '2020-01-15'
    const asOf = '2026-01-15'
    const unknown = getAgeGuidanceForDate(birthdate, asOf)
    const unknownPriority = getPriorityAgeGuidanceForDate(birthdate, asOf)
    const kr = getAgeGuidanceForDate(birthdate, asOf, 'KR')
    const jp = getAgeGuidanceForDate(birthdate, asOf, 'JP')

    expect(new Set(unknown.map(item => item.country))).toEqual(new Set(['KR', 'JP']))
    expect(new Set(unknownPriority.map(item => item.country))).toEqual(new Set(['KR', 'JP']))
    expect(Math.max(
      unknownPriority.filter(item => item.country === 'KR').length,
      unknownPriority.filter(item => item.country === 'JP').length
    )).toBeLessThanOrEqual(2)
    expect(kr.map(item => item.id)).toEqual([
      'older-child-general-care-kr',
      'older-child-emergency-kr',
      'older-child-local-guidance-kr',
    ])
    expect(jp.map(item => item.id)).toEqual([
      'older-child-general-care-jp',
      'older-child-emergency-jp',
      'older-child-local-guidance-jp',
    ])
    expect(kr.every(item => item.country === 'KR')).toBe(true)
    expect(jp.every(item => item.country === 'JP')).toBe(true)
    expect(kr.flatMap(item => item.sourceIds).some(id => /^(jp-|cfa-|mhlw-)/.test(id))).toBe(false)
    expect(jp.flatMap(item => item.sourceIds).some(id => /^(kr-|kdca-)/.test(id))).toBe(false)
    expect(JSON.stringify(kr)).not.toMatch(/일본|日本/)
    expect(JSON.stringify(jp)).not.toMatch(/한국|韓国/)
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

  it('marks local official links as check-up and vaccination resources', () => {
    const local = getAgeGuidanceForDate('2026-01-15', '2026-05-15')
      .filter(item => item.country)
    expect(local.length).toBeGreaterThan(0)
    expect(local.every(item => item.linkPurpose === 'checkup-vaccination' || item.linkPurpose === 'emergency')).toBe(true)
  })
})
