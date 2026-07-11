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
