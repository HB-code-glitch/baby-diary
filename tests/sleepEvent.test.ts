import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventLog } from '../electron/store/eventLog'
import { DiaryEvent, SleepData } from '../shared/types'
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { formatEventValue } from '../src/store/useAppStore'
import i18n from '../src/i18n'

// --------------- EventLog sleep validation ---------------

function makeSleepEvent(overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  const now = new Date().toISOString()
  return {
    id: uuidv4(),
    type: 'sleep',
    at: now,
    data: { minutes: 90 } as SleepData,
    author: { uid: 'test', name: 'Test', role: 'mom' },
    createdAt: now,
    updatedAt: now,
    rev: 1,
    deleted: false,
    ...overrides,
  }
}

describe('sleep event — EventLog validation', () => {
  let tmpDir: string
  let log: EventLog

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-sleep-test-'))
    log = new EventLog({ dataDir: tmpDir })
  })

  it('accepts sleep event with valid data', () => {
    const e = makeSleepEvent()
    const result = log.append(e)
    expect(result).toBe('ok')
  })

  it('sleep type IS valid after Task 1 — event round-trips correctly', () => {
    const e = makeSleepEvent()
    log.append(e)
    const loaded = log.loadAll()
    expect(loaded.some(ev => ev.type === 'sleep')).toBe(true)
  })

  it('sleep event persists and reloads with correct minutes', () => {
    const e = makeSleepEvent({ data: { minutes: 125 } as SleepData })
    log.append(e)
    const log2 = new EventLog({ dataDir: tmpDir })
    const loaded = log2.loadAll()
    const found = loaded.find(ev => ev.id === e.id)
    expect(found).toBeDefined()
    expect((found!.data as SleepData).minutes).toBe(125)
  })
})

// --------------- formatEventValue for sleep ---------------

describe('formatEventValue sleep — Korean', () => {
  beforeEach(() => {
    vi.spyOn(i18n, 'language', 'get').mockReturnValue('ko')
  })

  function makeSleepForFormat(minutes: number): DiaryEvent {
    const now = new Date().toISOString()
    return {
      id: uuidv4(),
      type: 'sleep',
      at: now,
      data: { minutes } as SleepData,
      author: { uid: 't', name: 'T', role: 'mom' },
      createdAt: now,
      updatedAt: now,
      rev: 1,
      deleted: false,
    }
  }

  it('formats 45min as "45분"', () => {
    const result = formatEventValue(makeSleepForFormat(45))
    expect(result).toBe('45분')
  })

  it('formats 120min as "2시간"', () => {
    const result = formatEventValue(makeSleepForFormat(120))
    expect(result).toBe('2시간')
  })

  it('formats 125min as "2시간 5분"', () => {
    const result = formatEventValue(makeSleepForFormat(125))
    expect(result).toBe('2시간 5분')
  })

  it('formats 60min as "1시간"', () => {
    const result = formatEventValue(makeSleepForFormat(60))
    expect(result).toBe('1시간')
  })
})

describe('formatEventValue sleep — Japanese', () => {
  beforeEach(() => {
    vi.spyOn(i18n, 'language', 'get').mockReturnValue('ja')
  })

  function makeSleepForFormat(minutes: number): DiaryEvent {
    const now = new Date().toISOString()
    return {
      id: uuidv4(),
      type: 'sleep',
      at: now,
      data: { minutes } as SleepData,
      author: { uid: 't', name: 'T', role: 'mom' },
      createdAt: now,
      updatedAt: now,
      rev: 1,
      deleted: false,
    }
  }

  it('formats 45min as "45分"', () => {
    const result = formatEventValue(makeSleepForFormat(45))
    expect(result).toBe('45分')
  })

  it('formats 125min as "2時間5分"', () => {
    const result = formatEventValue(makeSleepForFormat(125))
    expect(result).toBe('2時間5分')
  })

  it('formats 120min as "2時間"', () => {
    const result = formatEventValue(makeSleepForFormat(120))
    expect(result).toBe('2時間')
  })
})

// --------------- MF-03: Sleep stop-after-midnight time reconstruction ---------------

describe('MF-03: SleepConfirmPopover handleConfirm anchors HH:MM to startedAt date', () => {
  /**
   * The fix: instead of `new Date()`, use `new Date(startedAt)` so HH:MM edits
   * are anchored to the sleep-start date (not the stop date when tapped after midnight).
   */
  function reconstructStartISO(startedAt: number, startValue: string): string {
    const [hh, mm] = startValue.split(':').map(Number)
    const d = new Date(startedAt)  // MF-03 fix: anchor to startedAt
    d.setHours(hh, mm, 0, 0)
    return d.toISOString()
  }

  it('stop tapped at 00:30 next day: result date-part is the sleep-start day', () => {
    // Sleep started at 23:50 on day D
    const dayD = new Date(2026, 5, 20, 23, 50, 0, 0)  // local 2026-06-20 23:50
    const startedAt = dayD.getTime()
    const startValue = '23:50'  // user keeps the original start time

    const result = reconstructStartISO(startedAt, startValue)
    const resultDate = new Date(result)

    // The date-part of the result should be June 20, not June 21
    expect(resultDate.getFullYear()).toBe(2026)
    expect(resultDate.getMonth()).toBe(5)  // 0-indexed June
    expect(resultDate.getDate()).toBe(20)
    expect(resultDate.getHours()).toBe(23)
    expect(resultDate.getMinutes()).toBe(50)
  })

  it('stop tapped after midnight with edited start 23:50: result is still startedAt day', () => {
    // Sleep started at 2026-06-20 23:50
    const startedAt = new Date(2026, 5, 20, 23, 50, 0, 0).getTime()
    // User edits start to 23:45 (stays same day)
    const startValue = '23:45'

    const result = reconstructStartISO(startedAt, startValue)
    const resultDate = new Date(result)

    expect(resultDate.getDate()).toBe(20)  // still June 20
    expect(resultDate.getHours()).toBe(23)
    expect(resultDate.getMinutes()).toBe(45)
  })

  it('normal same-day stop: result date-part matches expected day', () => {
    const startedAt = new Date(2026, 5, 20, 14, 30, 0, 0).getTime()
    const startValue = '14:30'

    const result = reconstructStartISO(startedAt, startValue)
    const resultDate = new Date(result)

    expect(resultDate.getDate()).toBe(20)
    expect(resultDate.getHours()).toBe(14)
    expect(resultDate.getMinutes()).toBe(30)
  })
})

// --------------- Open-sleep localStorage rehydrate/discard logic ---------------

const SLEEP_START_KEY = 'babydiary.sleepStart'
const MAX_SLEEP_MS = 16 * 60 * 60 * 1000

interface SleepStartState {
  startedAt: number
}

function loadSleepStart(): SleepStartState | null {
  try {
    const raw = localStorage.getItem(SLEEP_START_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SleepStartState
    if (Date.now() - parsed.startedAt > MAX_SLEEP_MS) {
      localStorage.removeItem(SLEEP_START_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

describe('open-sleep rehydrate logic', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      _store: {} as Record<string, string>,
      getItem(k: string) { return this._store[k] ?? null },
      setItem(k: string, v: string) { this._store[k] = v },
      removeItem(k: string) { delete this._store[k] },
    })
  })

  it('returns null when no state stored', () => {
    expect(loadSleepStart()).toBeNull()
  })

  it('returns state when stored within 16h', () => {
    const state: SleepStartState = { startedAt: Date.now() - 30 * 60 * 1000 }
    localStorage.setItem(SLEEP_START_KEY, JSON.stringify(state))
    const loaded = loadSleepStart()
    expect(loaded).not.toBeNull()
    expect(loaded!.startedAt).toBe(state.startedAt)
  })

  it('discards and returns null when older than 16h', () => {
    const state: SleepStartState = { startedAt: Date.now() - 17 * 60 * 60 * 1000 }
    localStorage.setItem(SLEEP_START_KEY, JSON.stringify(state))
    const loaded = loadSleepStart()
    expect(loaded).toBeNull()
    // Also clears localStorage
    expect(localStorage.getItem(SLEEP_START_KEY)).toBeNull()
  })
})
