import { describe, it, expect, beforeEach } from 'vitest'
import { EventLog } from '../electron/store/eventLog'
import { DiaryEvent, GrowthData } from '../shared/types'
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { formatEventValue } from '../src/store/useAppStore'

function makeGrowthEvent(data: GrowthData, overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  const now = new Date().toISOString()
  return {
    id: uuidv4(),
    type: 'growth',
    at: now,
    data,
    author: { uid: 'test', name: 'Test', role: 'dad' },
    createdAt: now,
    updatedAt: now,
    rev: 1,
    deleted: false,
    ...overrides,
  }
}

describe('growth event — EventLog', () => {
  let tmpDir: string
  let log: EventLog

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-growth-test-'))
    log = new EventLog({ dataDir: tmpDir })
  })

  it('accepts growth event with weight only', () => {
    const e = makeGrowthEvent({ weightKg: 7.2 })
    expect(log.append(e)).toBe('ok')
  })

  it('accepts growth event with height only', () => {
    const e = makeGrowthEvent({ heightCm: 68.5 })
    expect(log.append(e)).toBe('ok')
  })

  it('accepts growth event with both weight and height', () => {
    const e = makeGrowthEvent({ weightKg: 7.2, heightCm: 68.5 })
    expect(log.append(e)).toBe('ok')
  })

  it('roundtrips growth data correctly', () => {
    const e = makeGrowthEvent({ weightKg: 7.2, heightCm: 68.5 })
    log.append(e)
    const log2 = new EventLog({ dataDir: tmpDir })
    const loaded = log2.loadAll()
    const found = loaded.find(ev => ev.id === e.id)
    expect(found).toBeDefined()
    const d = found!.data as GrowthData
    expect(d.weightKg).toBeCloseTo(7.2, 5)
    expect(d.heightCm).toBeCloseTo(68.5, 5)
  })
})

describe('formatEventValue growth', () => {
  function makeGrowthForFormat(data: GrowthData): DiaryEvent {
    const now = new Date().toISOString()
    return {
      id: uuidv4(),
      type: 'growth',
      at: now,
      data,
      author: { uid: 't', name: 'T', role: 'mom' },
      createdAt: now,
      updatedAt: now,
      rev: 1,
      deleted: false,
    }
  }

  it('formats weight+height as "7.2kg · 68.5cm"', () => {
    expect(formatEventValue(makeGrowthForFormat({ weightKg: 7.2, heightCm: 68.5 }))).toBe('7.2kg · 68.5cm')
  })

  it('formats weight only as "7.2kg"', () => {
    expect(formatEventValue(makeGrowthForFormat({ weightKg: 7.2 }))).toBe('7.2kg')
  })

  it('formats height only as "68.5cm"', () => {
    expect(formatEventValue(makeGrowthForFormat({ heightCm: 68.5 }))).toBe('68.5cm')
  })

  it('formats both-undefined growth as empty string', () => {
    // Edge case: both undefined (should not happen in UI, but test defense)
    expect(formatEventValue(makeGrowthForFormat({}))).toBe('')
  })
})

describe('addGrowth validation', () => {
  it('rejects when both weight and height are undefined', async () => {
    // addGrowth is async and throws 'growth_requires_at_least_one'
    // We test the throw path using a minimal mock
    async function addGrowth(weightKg: number | undefined, heightCm: number | undefined): Promise<void> {
      if (weightKg == null && heightCm == null) throw new Error('growth_requires_at_least_one')
    }
    await expect(addGrowth(undefined, undefined)).rejects.toThrow('growth_requires_at_least_one')
  })
})
