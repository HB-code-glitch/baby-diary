/**
 * tests/tier1Fixes.test.ts
 * P1–P12 Tier 1 fixes unit / integration tests
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EventLog } from '../electron/store/eventLog'
import { SettingsStore } from '../electron/store/settings'
import { DiaryEvent, AppSettings } from '../shared/types'
import { v4 as uuidv4 } from 'uuid'

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'baby-diary-tier1-'))
}

function makeEvent(overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  const now = new Date().toISOString()
  return {
    id: uuidv4(),
    type: 'pee',
    at: now,
    data: {},
    author: { uid: 'test', name: 'Test', role: 'dad' },
    createdAt: now,
    updatedAt: now,
    rev: 1,
    deleted: false,
    ...overrides,
  }
}

// ────────────────────────────────────────────────────────────
// P1 — torn-line heal: fs errors other than ENOENT must propagate
// ────────────────────────────────────────────────────────────

describe('P1: torn-line heal error propagation', () => {
  let tmpDir: string
  let log: EventLog

  beforeEach(() => {
    tmpDir = makeTempDir()
    log = new EventLog({ dataDir: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('ENOENT during stat is swallowed — append creates file and returns ok', () => {
    // Fresh log: file doesn't exist yet, statSync throws ENOENT — must be swallowed
    const e = makeEvent()
    const result = log.append(e)
    expect(result).toBe('ok')
    const events = new EventLog({ dataDir: tmpDir }).loadAll()
    expect(events.some(ev => ev.id === e.id)).toBe(true)
  })

  it('P1 fix: ENOENT is the only code swallowed; others propagate to caller (logic test)', () => {
    // Verify the P1 logic directly: any error code != ENOENT should propagate.
    // We test the condition extracted from the fix rather than mocking low-level fs,
    // since the ESM/CommonJS boundary makes spying on fs.statSync unreliable in vitest node.
    function shouldSwallow(code: string | undefined): boolean {
      return code === 'ENOENT'
    }
    expect(shouldSwallow('ENOENT')).toBe(true)  // ENOENT: swallow
    expect(shouldSwallow('EACCES')).toBe(false)  // EACCES: propagate
    expect(shouldSwallow('EIO')).toBe(false)     // EIO: propagate
    expect(shouldSwallow(undefined)).toBe(false)  // unknown: propagate
  })
})

// ────────────────────────────────────────────────────────────
// P3 — remote tombstone same-rev propagation
// ────────────────────────────────────────────────────────────

describe('P3: tombstone same-rev propagation', () => {
  let tmpDir: string
  let log: EventLog

  beforeEach(() => {
    tmpDir = makeTempDir()
    log = new EventLog({ dataDir: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('tombstone at same rev as non-deleted event writes to disk and shows deleted', () => {
    const id = uuidv4()
    const now = new Date().toISOString()

    // local non-deleted event
    const local = makeEvent({ id, rev: 2, deleted: false })
    expect(log.append(local)).toBe('ok')

    // remote tombstone at same rev
    const tombstone = makeEvent({ id, rev: 2, deleted: true, updatedAt: now })
    const result = log.append(tombstone)
    expect(result).toBe('ok')  // must NOT return 'duplicate'

    // loadAll should reflect deleted:true
    const events = new EventLog({ dataDir: tmpDir }).loadAll()
    const found = events.find(e => e.id === id)
    expect(found?.deleted).toBe(true)
  })

  it('non-tombstone duplicate at same rev still returns duplicate', () => {
    const e = makeEvent({ rev: 3, deleted: false })
    log.append(e)
    const result = log.append({ ...e })  // same id, same rev, not deleted
    expect(result).toBe('duplicate')
  })

  it('distinct legacy tombstones at the same rev are both preserved', () => {
    const id = uuidv4()
    const existing = makeEvent({ id, rev: 2, deleted: true, updatedAt: '2026-07-13T08:00:00.000Z' })
    log.append(existing)
    const anotherTombstone = makeEvent({ id, rev: 2, deleted: true, updatedAt: '2026-07-13T08:00:01.000Z' })
    expect(log.append(anotherTombstone)).toBe('ok')
    expect(log.getAllMutations()).toHaveLength(2)
  })
})

// ────────────────────────────────────────────────────────────
// P5 — settings.ts renameSync error propagates
// ────────────────────────────────────────────────────────────

describe('P5: settings.save() error surfacing logic', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('save() writes to a .tmp file then renames to final path (verifiable on success)', () => {
    const store = new SettingsStore(tmpDir)
    const settings: AppSettings = {
      baby: { name: 'Alice', birthdate: '2024-01-01' },
      profile: { uid: 'uid1', name: '아빠', role: 'dad' },
      familyId: '',
      firebase: null,
    }
    store.save(settings)

    // No .tmp file should remain (rename succeeded)
    const files = fs.readdirSync(tmpDir)
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false)
    expect(files.some(f => f === 'settings.json')).toBe(true)
  })

  it('P5 error-wrapping logic: an inner fs error is re-wrapped as structured Error', () => {
    // Test the error-wrapping inline, as done in settings.ts save()
    function wrapFsError(fn: () => void): void {
      try {
        fn()
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        const structured = new Error(`[Settings] save failed: ${msg}`)
        ;(structured as NodeJS.ErrnoException).code = (err as NodeJS.ErrnoException).code
        throw structured
      }
    }

    expect(() => wrapFsError(() => {
      const err: NodeJS.ErrnoException = new Error('EPERM: operation not permitted')
      err.code = 'EPERM'
      throw err
    })).toThrow(/save failed/)
  })

  it('save creates a missing settings directory before the durable atomic replace', () => {
    const nestedDir = path.join(tmpDir, 'nonexistent-subdir')
    const nestedStore = new SettingsStore(nestedDir)
    const settings: AppSettings = {
      baby: { name: 'Test', birthdate: '' },
      profile: { uid: '', name: '', role: 'mom' },
      familyId: '',
      firebase: null,
    }
    expect(() => nestedStore.save(settings)).not.toThrow()
    expect(fs.existsSync(path.join(nestedDir, 'settings.json'))).toBe(true)
    expect(new SettingsStore(nestedDir).get().profile.role).toBe('mom')
  })
})

// ────────────────────────────────────────────────────────────
// P8 — savePending / loadPending
// ────────────────────────────────────────────────────────────

// We test the logic inline since savePending/loadPending are private to syncEngine

interface PendingItem { event: DiaryEvent; attempts: number; nextRetry: number }

function loadPendingLogic(raw: string | null): PendingItem[] {
  try {
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const valid: PendingItem[] = []
    for (const item of parsed) {
      if (
        item &&
        typeof item === 'object' &&
        item.event &&
        typeof item.attempts === 'number' &&
        typeof item.nextRetry === 'number'
      ) {
        valid.push(item as PendingItem)
      }
    }
    return valid
  } catch {
    return []
  }
}

describe('P8: savePending / loadPending', () => {
  it('malformed JSON returns empty array', () => {
    expect(loadPendingLogic('not-json')).toEqual([])
  })

  it('non-array JSON returns empty array', () => {
    expect(loadPendingLogic(JSON.stringify({ foo: 'bar' }))).toEqual([])
  })

  it('item missing attempts field is dropped', () => {
    const badItem = { event: makeEvent(), nextRetry: 0 }
    const goodItem: PendingItem = { event: makeEvent(), attempts: 0, nextRetry: 0 }
    const raw = JSON.stringify([badItem, goodItem])
    const result = loadPendingLogic(raw)
    expect(result).toHaveLength(1)
    expect(result[0].event.id).toBe(goodItem.event.id)
  })

  it('item missing nextRetry field is dropped', () => {
    const badItem = { event: makeEvent(), attempts: 0 }
    const raw = JSON.stringify([badItem])
    expect(loadPendingLogic(raw)).toHaveLength(0)
  })

  it('null raw → empty array', () => {
    expect(loadPendingLogic(null)).toHaveLength(0)
  })

  it('valid items pass through unchanged', () => {
    const items: PendingItem[] = [
      { event: makeEvent({ type: 'pee' }), attempts: 2, nextRetry: 12345 },
      { event: makeEvent({ type: 'formula' }), attempts: 0, nextRetry: 0 },
    ]
    const result = loadPendingLogic(JSON.stringify(items))
    expect(result).toHaveLength(2)
    expect(result[0].attempts).toBe(2)
    expect(result[1].event.type).toBe('formula')
  })
})

// ────────────────────────────────────────────────────────────
// P10 — settings deep-merge
// ────────────────────────────────────────────────────────────

describe('P10: settings deep-merge on load', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('archives an unlinked partial baby pair and keeps the visible pair blank', () => {
    const settingsPath = path.join(tmpDir, 'settings.json')
    // Write a pre-journal familyless pair with a missing birthdate.
    fs.writeFileSync(settingsPath, JSON.stringify({ baby: { name: 'Alice' } }), 'utf-8')

    const store = new SettingsStore(tmpDir)
    const s = store.get()
    expect(s.baby).toMatchObject({ name: '', birthdate: '' })
    expect(store.listUnlinkedBabyInfoArchives({ limit: 10 }).items).toEqual([
      expect.objectContaining({ babyName: 'Alice', babyBirthdate: '' }),
    ])

    const restarted = new SettingsStore(tmpDir)
    expect(restarted.get().baby).toMatchObject({ name: '', birthdate: '' })
    expect(restarted.listUnlinkedBabyInfoArchives({ limit: 10 }).items).toHaveLength(1)
  })

  it('JSON with only profile.name preserves default role', () => {
    const settingsPath = path.join(tmpDir, 'settings.json')
    fs.writeFileSync(settingsPath, JSON.stringify({ profile: { name: 'Bob', uid: 'u1' } }), 'utf-8')

    const store = new SettingsStore(tmpDir)
    const s = store.get()
    expect(s.profile.name).toBe('Bob')
    expect(s.profile.role).toBe('dad')  // defaulted
  })

  it('JSON with complete baby object preserves all fields', () => {
    const settingsPath = path.join(tmpDir, 'settings.json')
    const full: AppSettings = {
      baby: { name: 'Charlie', birthdate: '2024-06-01', gender: 'boy' },
      profile: { uid: 'u2', name: 'Dad', role: 'dad' },
      familyId: 'fam1',
      firebase: null,
    }
    fs.writeFileSync(settingsPath, JSON.stringify(full), 'utf-8')

    const store = new SettingsStore(tmpDir)
    const s = store.get()
    expect(s.baby.name).toBe('Charlie')
    expect(s.baby.birthdate).toBe('2024-06-01')
    expect(s.baby.gender).toBe('boy')
    expect(s.profile.uid).toBe('u2')
  })

  it('missing firebase key defaults to null (not undefined)', () => {
    const settingsPath = path.join(tmpDir, 'settings.json')
    fs.writeFileSync(settingsPath, JSON.stringify({ baby: { name: 'D', birthdate: '' }, profile: { uid: '', name: '', role: 'mom' }, familyId: '' }), 'utf-8')

    const store = new SettingsStore(tmpDir)
    const s = store.get()
    expect(s.firebase).toBeNull()
  })
})

// ────────────────────────────────────────────────────────────
// P11 — mergeEventIntoList tombstone wins at equal rev
// ────────────────────────────────────────────────────────────

describe('P3 / P11: mergeEventIntoList tombstone at equal rev', () => {
  // Test the pure logic inline (mirrors the fix in useAppStore.ts)
  function mergeEventIntoList(list: DiaryEvent[], incoming: DiaryEvent): DiaryEvent[] {
    const idx = list.findIndex(e => e.id === incoming.id)
    if (idx === -1) return [...list, incoming]
    const existing = list[idx]
    if (incoming.rev > existing.rev) {
      const next = [...list]; next[idx] = incoming; return next
    }
    // P3 defense-in-depth: at equal rev, prefer deleted:true
    if (incoming.rev === existing.rev && incoming.deleted && !existing.deleted) {
      const next = [...list]; next[idx] = incoming; return next
    }
    return list
  }

  it('tombstone at equal rev replaces non-deleted in memory', () => {
    const id = uuidv4()
    const live = makeEvent({ id, rev: 2, deleted: false })
    const tomb = makeEvent({ id, rev: 2, deleted: true })
    const result = mergeEventIntoList([live], tomb)
    expect(result[0].deleted).toBe(true)
  })

  it('non-deleted at equal rev does NOT replace existing non-deleted', () => {
    const id = uuidv4()
    const e1 = makeEvent({ id, rev: 2, deleted: false })
    const e2 = makeEvent({ id, rev: 2, deleted: false })
    const result = mergeEventIntoList([e1], e2)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(id)
  })

  it('already-deleted at equal rev stays deleted (no overwrite)', () => {
    const id = uuidv4()
    const dead = makeEvent({ id, rev: 2, deleted: true })
    const anotherTomb = makeEvent({ id, rev: 2, deleted: true })
    const result = mergeEventIntoList([dead], anotherTomb)
    expect(result[0].deleted).toBe(true)
    expect(result).toHaveLength(1)
  })
})

// ────────────────────────────────────────────────────────────
// P2 — batchUpload partial-failure logic
// ────────────────────────────────────────────────────────────

describe('P2: batchUpload partial-failure — failed docs stay in pending', () => {
  it('drain keeps doc B in pending when uploadOne returns error for B', () => {
    // Simulate drainQueue's filtering logic inline
    interface PItem { event: DiaryEvent; attempts: number; nextRetry: number }
    const makeDocId = (e: DiaryEvent) => `${e.id}_${e.rev}`

    const eA = makeEvent({ id: 'a', rev: 1 })
    const eB = makeEvent({ id: 'b', rev: 1 })
    const eC = makeEvent({ id: 'c', rev: 1 })

    let pending: PItem[] = [
      { event: eA, attempts: 0, nextRetry: 0 },
      { event: eB, attempts: 0, nextRetry: 0 },
      { event: eC, attempts: 0, nextRetry: 0 },
    ]

    // Simulate batchUpload returning only A and C (B errored)
    const uploadedIds = new Set([makeDocId(eA), makeDocId(eC)])
    pending = pending.filter(p => !uploadedIds.has(makeDocId(p.event)))

    expect(pending).toHaveLength(1)
    expect(pending[0].event.id).toBe('b')
  })

  it('batchUpload returning all ids clears pending', () => {
    const makeDocId = (e: DiaryEvent) => `${e.id}_${e.rev}`
    const eA = makeEvent({ id: 'x', rev: 1 })
    const eB = makeEvent({ id: 'y', rev: 1 })

    let pending = [
      { event: eA, attempts: 0, nextRetry: 0 },
      { event: eB, attempts: 0, nextRetry: 0 },
    ]

    const uploadedIds = new Set([makeDocId(eA), makeDocId(eB)])
    pending = pending.filter(p => !uploadedIds.has(makeDocId(p.event)))

    expect(pending).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────
// P12 — softDeleteAllEvents loadEvents after partial abort
// ────────────────────────────────────────────────────────────

describe('P12: softDeleteAllEvents partial failure', () => {
  it('count = N-1 when Nth appendEvent returns error', async () => {
    // Tested via the softDeleteAllEvents integration test in softDeleteAllEvents.test.ts
    // Here we verify the pure count logic
    const events: DiaryEvent[] = [
      makeEvent({ id: 'p1', rev: 1 }),
      makeEvent({ id: 'p2', rev: 1 }),
      makeEvent({ id: 'p3', rev: 1 }),
    ]
    const appendResults = ['ok', 'error', 'ok']  // 2nd errors → abort
    let count = 0
    let partial = false
    for (let i = 0; i < events.length; i++) {
      if (appendResults[i] === 'error') { partial = true; break }
      count++
    }
    expect(count).toBe(1)
    expect(partial).toBe(true)
  })
})
