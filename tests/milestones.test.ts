/**
 * tests/milestones.test.ts
 * Vitest unit tests for getMilestones() and getUpcoming().
 */

import { describe, it, expect } from 'vitest'
import { getMilestones, getUpcoming } from '../src/lib/milestones'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function find(birthdate: string, id: string, gender?: 'girl' | 'boy') {
  return getMilestones(birthdate, gender).find(m => m.id === id)
}

// ---------------------------------------------------------------------------
// 백일 (baekil) — birth+99 actual days (day 100 in day-1 convention)
// ---------------------------------------------------------------------------

describe('baekil (백일)', () => {
  it('2026-01-01 birth → 2026-04-10', () => {
    const m = find('2026-01-01', 'baekil')
    expect(m?.date).toBe('2026-04-10')
  })

  it('has culture=both', () => {
    const m = find('2026-01-01', 'baekil')
    expect(m?.culture).toBe('both')
  })

  it('descriptions include 百日 and 백일 keywords', () => {
    const m = find('2026-01-01', 'baekil')
    expect(m?.nameJa).toContain('百日')
    expect(m?.nameKo).toBe('백일')
  })
})

// ---------------------------------------------------------------------------
// 삼칠일 (samchil-il) — birth+20 actual days (day 21 in day-1 convention)
// ---------------------------------------------------------------------------

describe('삼칠일 (samchil-il)', () => {
  it('2026-01-01 birth → 2026-01-21', () => {
    const m = find('2026-01-01', 'samchil-il')
    expect(m?.date).toBe('2026-01-21')
  })

  it('culture=ko', () => {
    const m = find('2026-01-01', 'samchil-il')
    expect(m?.culture).toBe('ko')
  })

  it('desc ends with "날이에요" in Korean', () => {
    const m = find('2026-01-01', 'samchil-il')
    expect(m?.descKo).toMatch(/날이에요$/)
  })
})

// ---------------------------------------------------------------------------
// お七夜 (oshichiya) — birth+6 actual days (day 7 in day-1 convention)
// ---------------------------------------------------------------------------

describe('oshichiya (お七夜)', () => {
  it('2026-01-01 birth → 2026-01-07', () => {
    const m = find('2026-01-01', 'oshichiya')
    expect(m?.date).toBe('2026-01-07')
  })

  it('culture=ja', () => {
    const m = find('2026-01-01', 'oshichiya')
    expect(m?.culture).toBe('ja')
  })

  it('nameJa contains お七夜', () => {
    const m = find('2026-01-01', 'oshichiya')
    expect(m?.nameJa).toContain('お七夜')
  })
})

// ---------------------------------------------------------------------------
// お宮参り (omiyamairi)
// ---------------------------------------------------------------------------

describe('omiyamairi (お宮参り)', () => {
  it('boy: birth+30 actual days', () => {
    const m = find('2026-01-01', 'omiyamairi', 'boy')
    expect(m?.date).toBe('2026-01-31')
  })

  it('girl: birth+31 actual days', () => {
    const m = find('2026-01-01', 'omiyamairi', 'girl')
    expect(m?.date).toBe('2026-02-01')
  })

  it('no gender: birth+30 actual days (default=boy offset)', () => {
    const m = find('2026-01-01', 'omiyamairi')
    expect(m?.date).toBe('2026-01-31')
  })
})

// ---------------------------------------------------------------------------
// ハーフバースデー (half-birthday) — 6 calendar months
// ---------------------------------------------------------------------------

describe('half-birthday (ハーフバースデー)', () => {
  it('2026-01-01 → 2026-07-01', () => {
    const m = find('2026-01-01', 'half-birthday')
    expect(m?.date).toBe('2026-07-01')
  })

  it('month-add edge: 2026-01-31 → 2026-07-31', () => {
    const m = find('2026-01-31', 'half-birthday')
    expect(m?.date).toBe('2026-07-31')
  })

  it('culture=both', () => {
    const m = find('2026-01-01', 'half-birthday')
    expect(m?.culture).toBe('both')
  })
})

// ---------------------------------------------------------------------------
// 첫돌 (cheosdol) — 1st birthday (12 calendar months)
// ---------------------------------------------------------------------------

describe('cheosdol (첫돌)', () => {
  it('2026-01-01 → 2027-01-01', () => {
    const m = find('2026-01-01', 'cheosdol')
    expect(m?.date).toBe('2027-01-01')
  })

  it('nameKo=첫돌, nameJa contains 初誕生日', () => {
    const m = find('2026-01-01', 'cheosdol')
    expect(m?.nameKo).toBe('첫돌')
    expect(m?.nameJa).toContain('初誕生日')
  })
})

// ---------------------------------------------------------------------------
// 初節句 (hatsu-sekku)
// ---------------------------------------------------------------------------

describe('hatsu-sekku (初節句)', () => {
  it('girl born 2026-02-20 → within 30d of 3/3 → 2027-03-03', () => {
    const m = find('2026-02-20', 'hatsu-sekku', 'girl')
    expect(m?.date).toBe('2027-03-03')
  })

  it('boy born 2026-01-10 → 2026-05-05 (not within 30 days)', () => {
    const m = find('2026-01-10', 'hatsu-sekku', 'boy')
    expect(m?.date).toBe('2026-05-05')
  })

  it('girl born 2026-03-01 → within 30d of 3/3 → 2027-03-03', () => {
    const m = find('2026-03-01', 'hatsu-sekku', 'girl')
    expect(m?.date).toBe('2027-03-03')
  })

  it('boy born 2026-04-10 → within 30d of 5/5 → 2027-05-05', () => {
    const m = find('2026-04-10', 'hatsu-sekku', 'boy')
    expect(m?.date).toBe('2027-05-05')
  })

  it('no gender → hatsu-sekku not generated', () => {
    const m = find('2026-01-10', 'hatsu-sekku')
    expect(m).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 七五三 (shichigosan)
// ---------------------------------------------------------------------------

describe('shichigosan (七五三)', () => {
  // Born 2026-07-11 (today in prompt) — girl
  // Full age 3 on Nov 15 2029: year=2029, 2029-2026=3, born July so no correction → age 3
  // Full age 7 on Nov 15 2033: year=2033, 2033-2026=7 → age 7
  it('girl born 2026-07-11 → shichigosan at Nov 15 2029 (age 3)', () => {
    const milestones = getMilestones('2026-07-11', 'girl')
    const sg3 = milestones.find(m => m.id === 'shichigosan-2029')
    expect(sg3?.date).toBe('2029-11-15')
  })

  it('girl born 2026-07-11 → shichigosan at Nov 15 2033 (age 7)', () => {
    const milestones = getMilestones('2026-07-11', 'girl')
    const sg7 = milestones.find(m => m.id === 'shichigosan-2033')
    expect(sg7?.date).toBe('2033-11-15')
  })

  it('boy gets shichigosan at age 3 and 5, not 7', () => {
    const milestones = getMilestones('2026-07-11', 'boy')
    const ids = milestones.filter(m => m.id.startsWith('shichigosan')).map(m => m.id)
    // age 3 = 2029, age 5 = 2031
    expect(ids).toContain('shichigosan-2029')
    expect(ids).toContain('shichigosan-2031')
    expect(ids).not.toContain('shichigosan-2033')
  })

  it('no gender → only age 3 shichigosan', () => {
    const milestones = getMilestones('2026-07-11')
    const ids = milestones.filter(m => m.id.startsWith('shichigosan')).map(m => m.id)
    expect(ids).toContain('shichigosan-2029')
    // age 5/7 not generated without gender
    expect(ids).not.toContain('shichigosan-2031')
    expect(ids).not.toContain('shichigosan-2033')
  })
})

// ---------------------------------------------------------------------------
// yearly-birthday
// ---------------------------------------------------------------------------

describe('yearly-birthday', () => {
  it('generates years 2–10 for 2026-01-01', () => {
    const milestones = getMilestones('2026-01-01')
    for (let yr = 2; yr <= 10; yr++) {
      const m = milestones.find(m => m.id === `yearly-birthday-${yr}`)
      expect(m).toBeDefined()
      expect(m?.date).toBe(`${2026 + yr}-01-01`)
    }
  })
})

// ---------------------------------------------------------------------------
// getUpcoming — window edge cases
// ---------------------------------------------------------------------------

describe('getUpcoming', () => {
  const birthdate = '2026-01-01'

  it('today=event date → included (D-0)', () => {
    const milestones = getMilestones(birthdate)
    // 2026-01-07 is oshichiya (birth+6 days)
    const upcoming = getUpcoming(milestones, '2026-01-07', 7)
    const found = upcoming.find(m => m.id === 'oshichiya')
    expect(found).toBeDefined()
    expect(found?.daysUntil).toBe(0)
  })

  it('event 8 days away → NOT included when withinDays=7', () => {
    const milestones = getMilestones(birthdate)
    // oshichiya is on 2026-01-07; from 2025-12-30 that's 8 days away
    const upcoming = getUpcoming(milestones, '2025-12-30', 7)
    const found = upcoming.find(m => m.id === 'oshichiya')
    expect(found).toBeUndefined()
  })

  it('event 7 days away → included when withinDays=7', () => {
    const milestones = getMilestones(birthdate)
    // oshichiya is on 2026-01-07; from 2025-12-31 that's 7 days away
    const upcoming = getUpcoming(milestones, '2025-12-31', 7)
    const found = upcoming.find(m => m.id === 'oshichiya')
    expect(found).toBeDefined()
    expect(found?.daysUntil).toBe(7)
  })

  it('past events excluded', () => {
    const milestones = getMilestones(birthdate)
    // looking 7 days ahead from 2026-01-10: oshichiya was 2026-01-07 (past)
    const upcoming = getUpcoming(milestones, '2026-01-10', 7)
    const found = upcoming.find(m => m.id === 'oshichiya')
    expect(found).toBeUndefined()
  })

  it('returns sorted by daysUntil', () => {
    const milestones = getMilestones(birthdate)
    const upcoming = getUpcoming(milestones, '2025-12-27', 30)
    if (upcoming.length >= 2) {
      for (let i = 1; i < upcoming.length; i++) {
        expect(upcoming[i].daysUntil).toBeGreaterThanOrEqual(upcoming[i - 1].daysUntil)
      }
    }
  })

  it('empty milestones → empty result', () => {
    expect(getUpcoming([], '2026-01-01', 7)).toEqual([])
  })

  it('no birthdate → getMilestones returns empty → getUpcoming empty', () => {
    const milestones = getMilestones('')
    expect(getUpcoming(milestones, '2026-01-01', 7)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// General shape checks
// ---------------------------------------------------------------------------

describe('getMilestones general', () => {
  it('returns empty for empty birthdate', () => {
    expect(getMilestones('')).toEqual([])
  })

  it('results are sorted by date', () => {
    const milestones = getMilestones('2026-01-01', 'girl')
    for (let i = 1; i < milestones.length; i++) {
      expect(milestones[i].date >= milestones[i - 1].date).toBe(true)
    }
  })

  it('all milestones have required fields', () => {
    const milestones = getMilestones('2026-06-15', 'boy')
    for (const m of milestones) {
      expect(m.id).toBeTruthy()
      expect(m.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(m.nameKo).toBeTruthy()
      expect(m.nameJa).toBeTruthy()
      expect(m.descKo).toBeTruthy()
      expect(m.descJa).toBeTruthy()
      expect(['ko', 'ja', 'both']).toContain(m.culture)
    }
  })

  it('no gender: omits hatsu-sekku', () => {
    const milestones = getMilestones('2026-01-01')
    expect(milestones.find(m => m.id === 'hatsu-sekku')).toBeUndefined()
  })

  it('includes baekil, oshichiya, samchil-il regardless of gender', () => {
    for (const g of [undefined, 'girl', 'boy'] as const) {
      const milestones = getMilestones('2026-03-01', g)
      expect(milestones.find(m => m.id === 'baekil')).toBeDefined()
      expect(milestones.find(m => m.id === 'oshichiya')).toBeDefined()
      expect(milestones.find(m => m.id === 'samchil-il')).toBeDefined()
    }
  })
})
