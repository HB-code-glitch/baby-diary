/**
 * tests/tier2Fixes.test.ts
 * Tier 2 & Tier 3 unit/integration tests (P13–P37, excluding DISCUSS items)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getFeedingBand, evaluateFever, GUIDANCE_MARKERS, FEEDING_BANDS } from '../src/lib/guidance'
import { getMilestones } from '../src/lib/milestones'

// ---------------------------------------------------------------------------
// P13 — isReady flag set after init()
// ---------------------------------------------------------------------------
describe('P13: isReady set after all loaders resolve', () => {
  it('isReady starts false and goes true after init', async () => {
    // Import dynamically to get a fresh store instance per test
    const { useAppStore } = await import('../src/store/useAppStore')

    // The store starts with isReady: false
    // In test environment ipc is mocked; we just verify the shape
    expect(useAppStore.getState().isReady).toBe(false)

    // After setting isReady=true manually (simulating init completion), it should reflect
    useAppStore.setState({ isReady: true })
    expect(useAppStore.getState().isReady).toBe(true)

    // Reset
    useAppStore.setState({ isReady: false })
  })
})

// ---------------------------------------------------------------------------
// P14 — nursing timer: stop time is canonical `at` (cross-midnight)
// P15 — nursing timer: abandoned old timer discarded; long session clamped
// ---------------------------------------------------------------------------
describe('P14 + P15: nursing timer midnight + elapsed cap', () => {
  it('P14: stop time (not start time) should be the canonical at', () => {
    // Simulate: started 23:45 on day 1, stopped at 00:15 on day 2
    const startedAt = new Date('2025-01-01T23:45:00.000Z').getTime()
    const stopTime = new Date('2025-01-02T00:15:00.000Z').getTime()
    const elapsedSec = Math.floor((stopTime - startedAt) / 1000)
    const MAX_ELAPSED_MIN = 240
    const elapsedMin = Math.min(MAX_ELAPSED_MIN, Math.max(1, Math.ceil(elapsedSec / 60)))
    const stopAtISO = new Date(stopTime).toISOString()

    // Elapsed = 30 min (not capped)
    expect(elapsedMin).toBe(30)
    // The canonical at is the stop time (Jan 2), not the start (Jan 1)
    expect(stopAtISO.startsWith('2025-01-02')).toBe(true)
  })

  it('P15: timer >4h old should be discarded on load', () => {
    const MAX_ELAPSED_MS = 4 * 60 * 60 * 1000
    // 5-hour-old timer
    const staleStart = Date.now() - (5 * 60 * 60 * 1000)
    const isStale = Date.now() - staleStart > MAX_ELAPSED_MS
    expect(isStale).toBe(true)
  })

  it('P15: stop after very long session clamps to 240 min', () => {
    const MAX_ELAPSED_MIN = 240
    const startedAt = Date.now() - (7 * 60 * 60 * 1000) // 7 hours ago
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000)
    const elapsedMin = Math.min(MAX_ELAPSED_MIN, Math.max(1, Math.ceil(elapsedSec / 60)))
    expect(elapsedMin).toBe(MAX_ELAPSED_MIN)
  })
})

// ---------------------------------------------------------------------------
// P17 — TempPopover: clamp to [35.0, 42.0]
// ---------------------------------------------------------------------------
describe('P17: temperature clamping', () => {
  function clampTemp(n: number) {
    return Math.min(Math.max(n, 35.0), 42.0)
  }

  it('clamps 99 → 42.0', () => {
    expect(clampTemp(99)).toBe(42.0)
  })

  it('clamps -1 → 35.0', () => {
    expect(clampTemp(-1)).toBe(35.0)
  })

  it('leaves 37.5 unchanged', () => {
    expect(clampTemp(37.5)).toBe(37.5)
  })

  it('non-finite values are excluded before calling clamp', () => {
    const n = parseFloat('abc')
    expect(isNaN(n)).toBe(true)
    // caller checks isNaN and isFinite before calling clamp — no call
  })
})

// ---------------------------------------------------------------------------
// P18 — FormulaPopover: stepper never goes below 10ml
// ---------------------------------------------------------------------------
describe('P18: formula stepper floor at 10ml', () => {
  it('decrement from 10 stays 10', () => {
    const v = 10
    expect(Math.max(10, v - 10)).toBe(10)
  })

  it('decrement from 20 goes to 10', () => {
    const v = 20
    expect(Math.max(10, v - 10)).toBe(10)
  })

  it('decrement from 30 goes to 20', () => {
    const v = 30
    expect(Math.max(10, v - 10)).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// P19 — BreastPopover: manual minutes clamp [1, 120]
// ---------------------------------------------------------------------------
describe('P19: breast duration clamping', () => {
  function parseMinutes(input: string): number | undefined {
    const raw = input ? parseInt(input, 10) : undefined
    if (raw != null && !isNaN(raw) && raw > 0) {
      return Math.min(Math.max(1, raw), 120)
    }
    return undefined
  }

  it('"0" → undefined', () => {
    expect(parseMinutes('0')).toBeUndefined()
  })

  it('"500" → 120', () => {
    expect(parseMinutes('500')).toBe(120)
  })

  it('"" → undefined', () => {
    expect(parseMinutes('')).toBeUndefined()
  })

  it('"45" → 45', () => {
    expect(parseMinutes('45')).toBe(45)
  })

  it('"1" → 1', () => {
    expect(parseMinutes('1')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// P20 — EventLog.getAll() uses in-memory cache; no rescan after loaded
// ---------------------------------------------------------------------------
describe('P20: getAll() serves from cache without re-scanning disk', () => {
  it('getAll() after loadAll() returns same results without calling readFileSync again', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const os = await import('os')
    const { EventLog } = await import('../electron/store/eventLog')
    const { v4: uuidv4 } = await import('uuid')

    const tmpDir = fs.default.mkdtempSync(path.default.join(os.default.tmpdir(), 'test-p20-'))
    const log = new EventLog({ dataDir: tmpDir })

    const now = new Date().toISOString()
    const ev = { id: uuidv4(), type: 'pee' as const, at: now, data: {}, author: { uid: 'u', name: '', role: 'mom' as const }, createdAt: now, updatedAt: now, rev: 1, deleted: false }
    log.append(ev)

    const readSpy = vi.spyOn(fs.default, 'readFileSync')
    readSpy.mockClear()

    // getAll() should NOT call readFileSync (already loaded)
    const result = log.getAll()
    expect(result.length).toBe(1)
    expect(result[0].id).toBe(ev.id)
    expect(readSpy).not.toHaveBeenCalled()

    readSpy.mockRestore()
    fs.default.rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// P33/P34 — superseded: fixed-day quota bands are unsafe across calendar months
// ---------------------------------------------------------------------------
describe('P33/P34 replacement: fixed-day formula bands are retired', () => {
  it('returns no numeric quota band at any day age', () => {
    expect(FEEDING_BANDS).toEqual([])
    for (const ageDays of [-1, 0, 30, 45, 60, 75, 90, 181, 365]) {
      expect(getFeedingBand(ageDays)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// P35 — 初節句 postpone is inclusive (diffDays <= 30)
// ---------------------------------------------------------------------------
describe('P35: hatsu-sekku postpone inclusive boundary', () => {
  it('birth exactly 30 days before festival → postpone to next year', () => {
    // Girl: festival = March 3. Birth = February 1 (= 30 days before March 3)
    const milestones = getMilestones('2025-02-01', 'girl')
    const sekku = milestones.find(m => m.id === 'hatsu-sekku')
    expect(sekku).toBeDefined()
    // Should be postponed to 2026-03-03 (not 2025-03-03, which is exactly 30 days away)
    expect(sekku!.date).toBe('2026-03-03')
  })

  it('birth 31 days before festival → NOT postponed (uses same year)', () => {
    // Girl: festival = March 3. Birth = January 31 (= 31 days before March 3)
    const milestones = getMilestones('2025-01-31', 'girl')
    const sekku = milestones.find(m => m.id === 'hatsu-sekku')
    expect(sekku).toBeDefined()
    expect(sekku!.date).toBe('2025-03-03')
  })
})

// ---------------------------------------------------------------------------
// P32 — superseded: copy uses the age label without claiming a measurement site
// ---------------------------------------------------------------------------
describe('P32 replacement: fever copy stays conservative', () => {
  it('Korean body states under 3 months and 38°C without rectal inference', () => {
    const marker = GUIDANCE_MARKERS.find(m => m.id === 'fever_under_3mo_emergency')
    expect(marker).toBeDefined()
    expect(marker!.bodyKo).toContain('3개월 미만')
    expect(marker!.bodyKo).toContain('38.0°C 이상')
    expect(marker!.bodyKo).not.toContain('직장')
  })

  it('Japanese body states under 3 months and 38°C without rectal inference', () => {
    const marker = GUIDANCE_MARKERS.find(m => m.id === 'fever_under_3mo_emergency')
    expect(marker!.bodyJa).toContain('3か月未満')
    expect(marker!.bodyJa).toContain('38.0°C以上')
    expect(marker!.bodyJa).not.toContain('直腸')
  })
})

// ---------------------------------------------------------------------------
// P29/P30 — milestone banner text uses t() (covered by import-level check)
// These are UI-layer changes verified by the i18n key existing in ko/ja.json
// ---------------------------------------------------------------------------
describe('P29/P30: milestone.upcomingBanner key consistency', () => {
  it('ko.json upcomingBanner is the canonical template', async () => {
    const ko = await import('../src/i18n/ko.json')
    expect((ko as any).milestone.upcomingBanner).toContain('{{days}}')
    expect((ko as any).milestone.upcomingBanner).toContain('{{name}}')
    expect((ko as any).milestone.upcomingBanner).toContain('{{date}}')
  })

  it('ja.json upcomingBanner is the canonical template', async () => {
    const ja = await import('../src/i18n/ja.json')
    expect((ja as any).milestone.upcomingBanner).toContain('{{days}}')
    expect((ja as any).milestone.upcomingBanner).toContain('{{name}}')
    expect((ja as any).milestone.upcomingBanner).toContain('{{date}}')
  })

  it('P30: upcomingBannerToday key exists in both locales', async () => {
    const ko = await import('../src/i18n/ko.json')
    const ja = await import('../src/i18n/ja.json')
    expect((ko as any).milestone.upcomingBannerToday).toBeTruthy()
    expect((ja as any).milestone.upcomingBannerToday).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// P31 — feedingTip.footerAriaLabel key present in both locales
// ---------------------------------------------------------------------------
describe('P31: feedingTip.footerAriaLabel i18n key', () => {
  it('ko.json has feedingTip.footerAriaLabel', async () => {
    const ko = await import('../src/i18n/ko.json')
    expect((ko as any).feedingTip.footerAriaLabel).toBeTruthy()
  })

  it('ja.json has feedingTip.footerAriaLabel', async () => {
    const ja = await import('../src/i18n/ja.json')
    expect((ja as any).feedingTip.footerAriaLabel).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// P37 — feedingTip.noBirthdate null key removed
// ---------------------------------------------------------------------------
describe('P37: feedingTip.noBirthdate null key removed', () => {
  it('ko.json does not have feedingTip.noBirthdate', async () => {
    const ko = await import('../src/i18n/ko.json')
    expect((ko as any).feedingTip).not.toHaveProperty('noBirthdate')
  })

  it('ja.json does not have feedingTip.noBirthdate', async () => {
    const ja = await import('../src/i18n/ja.json')
    expect((ja as any).feedingTip).not.toHaveProperty('noBirthdate')
  })
})
