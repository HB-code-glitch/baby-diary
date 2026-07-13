import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { EventLog } from '../electron/store/eventLog'
import { DiaryEvent } from '../shared/types'
import { v4 as uuidv4 } from 'uuid'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'baby-diary-test-'))
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

describe('EventLog', () => {
  let tmpDir: string
  let log: EventLog

  beforeEach(() => {
    tmpDir = makeTempDir()
    log = new EventLog({ dataDir: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('append then loadAll roundtrip', () => {
    const e = makeEvent()
    log.append(e)

    const log2 = new EventLog({ dataDir: tmpDir })
    const events = log2.loadAll()
    expect(events).toHaveLength(1)
    expect(events[0].id).toBe(e.id)
  })

  it('rev resolution: higher rev wins (edit)', () => {
    const id = uuidv4()
    const e1 = makeEvent({ id, rev: 1 })
    const e2 = makeEvent({ id, rev: 2, updatedAt: new Date(Date.now() + 1000).toISOString() })

    log.append(e1)
    log.append(e2)

    const events = log.loadAll()
    const found = events.find(e => e.id === id)
    expect(found?.rev).toBe(2)
  })

  it('rev resolution: delete tombstone wins', () => {
    const id = uuidv4()
    const e1 = makeEvent({ id, rev: 1, deleted: false })
    const e2 = makeEvent({ id, rev: 2, deleted: true, updatedAt: new Date(Date.now() + 1000).toISOString() })

    log.append(e1)
    log.append(e2)

    const events = log.loadAll()
    const found = events.find(e => e.id === id)
    expect(found?.deleted).toBe(true)
  })

  it('truncated final line recovery: loadAll succeeds with remaining events', () => {
    const e = makeEvent()
    log.append(e)

    const files = fs.readdirSync(tmpDir)
    expect(files).toHaveLength(1)
    const filePath = path.join(tmpDir, files[0])

    fs.appendFileSync(filePath, '{"id":"partial","type":"pe')

    const log2 = new EventLog({ dataDir: tmpDir })
    const events = log2.loadAll()
    expect(events.some(ev => ev.id === e.id)).toBe(true)
  })

  it('duplicate id+rev append is no-op', () => {
    const e = makeEvent()
    const r1 = log.append(e)
    const r2 = log.append(e)

    expect(r1).toBe('ok')
    expect(r2).toBe('duplicate')

    const events = log.loadAll()
    expect(events).toHaveLength(1)
  })

  it('preserves distinct mutations at the same id+rev and deduplicates only the same mutation', () => {
    const id = uuidv4()
    const first = makeEvent({
      id,
      mutationId: '11111111-1111-4111-8111-111111111111',
      rev: 2,
      at: '2026-07-13T07:00:00.000Z',
      updatedAt: '2026-07-13T08:00:00.000Z',
    })
    const second = makeEvent({
      id,
      mutationId: '22222222-2222-4222-8222-222222222222',
      rev: 2,
      at: '2026-07-13T09:00:00.000Z',
      updatedAt: '2026-07-13T08:00:00.000Z',
    })

    expect(log.append(first)).toBe('ok')
    expect(log.append(second)).toBe('ok')
    expect(log.append(first)).toBe('duplicate')
    expect(log.getAllMutations()).toEqual(expect.arrayContaining([first, second]))
    expect(log.getAllMutations()).toHaveLength(2)
    expect(log.getAll().find(event => event.id === id)).toEqual(second)

    const filePath = path.join(tmpDir, fs.readdirSync(tmpDir)[0])
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
  })

  it('physically preserves payload collisions that reuse the same mutation identity', () => {
    const id = uuidv4()
    const first = makeEvent({
      id,
      mutationId: '11111111-1111-4111-8111-111111111111',
      rev: 2,
      data: { note: 'first payload' },
    })
    const second = makeEvent({
      ...first,
      data: { note: 'second payload' },
    })

    expect(log.append(first)).toBe('ok')
    expect(log.append(second)).toBe('ok')
    expect(log.append({ ...first, data: { note: 'first payload' } })).toBe('duplicate')
    expect(log.getAllMutations()).toHaveLength(2)
  })

  it('resolves same-revision mutations identically after reverse append order and reload', () => {
    const id = uuidv4()
    const live = makeEvent({
      id,
      mutationId: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      rev: 4,
      deleted: false,
      updatedAt: '2026-07-13T10:00:00.000Z',
    })
    const tombstone = makeEvent({
      id,
      mutationId: '11111111-1111-4111-8111-111111111111',
      rev: 4,
      deleted: true,
      updatedAt: '2026-07-13T06:00:00.000Z',
    })

    expect(log.append(live)).toBe('ok')
    expect(log.append(tombstone)).toBe('ok')
    expect(log.getAll().find(event => event.id === id)).toEqual(tombstone)

    const reloaded = new EventLog({ dataDir: tmpDir })
    expect(reloaded.loadAll().find(event => event.id === id)).toEqual(tombstone)

    const reverseDir = makeTempDir()
    try {
      const reverse = new EventLog({ dataDir: reverseDir })
      expect(reverse.append(tombstone)).toBe('ok')
      expect(reverse.append(live)).toBe('ok')
      expect(reverse.getAll().find(event => event.id === id)).toEqual(tombstone)
    } finally {
      fs.rmSync(reverseDir, { recursive: true, force: true })
    }
  })

  it('preserves distinct legacy same-revision payloads without rewriting them', () => {
    const id = uuidv4()
    const first = makeEvent({
      id,
      mutationId: undefined,
      rev: 2,
      data: { note: 'first legacy payload' },
      updatedAt: '2026-07-13T08:00:00.000Z',
    })
    const second = makeEvent({
      id,
      mutationId: undefined,
      rev: 2,
      data: { note: 'second legacy payload' },
      updatedAt: '2026-07-13T08:00:01.000Z',
    })
    const tombstone = makeEvent({
      id,
      mutationId: undefined,
      rev: 2,
      deleted: true,
      updatedAt: '2026-07-13T07:00:00.000Z',
    })

    expect(log.append(first)).toBe('ok')
    expect(log.append(second)).toBe('ok')
    expect(log.append(tombstone)).toBe('ok')
    expect(log.getAllMutations()).toHaveLength(3)
    expect(log.getAll().find(event => event.id === id)).toEqual(tombstone)
  })

  it('month file routing by event.at', () => {
    const e1 = makeEvent({ at: '2024-01-15T10:00:00.000Z' })
    const e2 = makeEvent({ at: '2024-02-20T10:00:00.000Z' })
    log.append(e1)
    log.append(e2)

    const files = fs.readdirSync(tmpDir).sort()
    expect(files).toHaveLength(2)
    expect(files[0]).toMatch(/events-2024-01\.jsonl/)
    expect(files[1]).toMatch(/events-2024-02\.jsonl/)
  })

  it('pads early years on write and recovers pre-existing unpadded year files', () => {
    const early = makeEvent({ id: 'early-year', at: '0001-01-15T00:00:00.000Z' })
    expect(log.append(early)).toBe('ok')
    expect(fs.existsSync(path.join(tmpDir, 'events-0001-01.jsonl'))).toBe(true)

    const legacy = makeEvent({ id: 'legacy-unpadded', at: '0001-02-15T00:00:00.000Z' })
    fs.writeFileSync(path.join(tmpDir, 'events-1-02.jsonl'), `${JSON.stringify(legacy)}\n`)

    const reloaded = new EventLog({ dataDir: tmpDir })
    expect(reloaded.loadAll()).toEqual(expect.arrayContaining([early, legacy]))
  })

  // ── F1 regression: torn final line (no trailing newline) fuses prevention ──

  it('F1: file ends without trailing newline — new append does NOT fuse with prior line', () => {
    // Write e1 directly without a trailing newline (simulates crash after write but before
    // the newline was flushed — the exact scenario F1 prevents).
    const e1 = makeEvent()
    const files_before = fs.readdirSync(tmpDir)
    // First do a normal append so the month file exists
    log.append(e1)

    const files = fs.readdirSync(tmpDir)
    expect(files).toHaveLength(1)
    const filePath = path.join(tmpDir, files[0])

    // Simulate the "no trailing newline" crash: strip the final \n
    const raw = fs.readFileSync(filePath)
    expect(raw[raw.length - 1]).toBe(0x0a)  // confirm normal append ends with \n
    fs.writeFileSync(filePath, raw.slice(0, raw.length - 1))  // remove trailing \n

    // Now append a second valid event via real append path
    const e2 = makeEvent()
    const log2 = new EventLog({ dataDir: tmpDir })
    const result = log2.append(e2)
    expect(result).toBe('ok')

    // Reload fresh — both events must survive (F1 inserted a \n before e2)
    const log3 = new EventLog({ dataDir: tmpDir })
    const events = log3.loadAll()
    expect(events.some(ev => ev.id === e1.id)).toBe(true)
    expect(events.some(ev => ev.id === e2.id)).toBe(true)
  })

  it('F1: torn partial JSON final line — new event survives, partial skipped', () => {
    // Write a COMPLETE event first (with newline), then append a PARTIAL line
    // WITHOUT a preceding newline — like a crash mid-write of a second event.
    // Before F1: next append fuses with partial → new event gone on reload.
    // After F1:  F1 inserts \n before the partial (separating it), and then the
    //            new event on its own line. On reload: partial is skipped (malformed),
    //            new event survives.
    //
    // NOTE: the partial fragment appended here simulates a byte-torn write where
    // the newline BETWEEN events was lost (not the newline AFTER the fragment).
    // To isolate just the F1 scenario we:
    //   1. write e1 + \n  (complete, via normal append)
    //   2. manually write a partial line WITHOUT a preceding \n
    //      (simulates: newline separator got dropped in a crash)
    //   3. call append(e2) via the real code path
    //   4. expect e2 to be in loadAll() output; partial to be absent

    const e1 = makeEvent()
    log.append(e1)

    const files = fs.readdirSync(tmpDir)
    const filePath = path.join(tmpDir, files[0])

    // The file currently ends with \n (e1 complete). Now write a partial second
    // entry directly (simulates a partial write that left no preceding \n).
    // We strip the trailing \n from e1's line first, then add partial bytes:
    //   file: <e1-json><partial-bytes>   (no \n anywhere after e1)
    const rawE1 = fs.readFileSync(filePath)
    const partial = Buffer.from('{"id":"bad","type":"pe')  // intentionally truncated
    fs.writeFileSync(filePath, Buffer.concat([rawE1.slice(0, rawE1.length - 1), partial]))

    // Now append e2 via real code path — F1 must insert \n before e2 to not fuse
    const e2 = makeEvent()
    const log2 = new EventLog({ dataDir: tmpDir })
    const appended = log2.append(e2)
    expect(appended).toBe('ok')

    // Reload and verify
    const log3 = new EventLog({ dataDir: tmpDir })
    const events = log3.loadAll()

    // e2 must survive (was on its own properly separated line after F1 fix)
    expect(events.some(ev => ev.id === e2.id)).toBe(true)
    // The partial fragment must NOT appear as a valid event
    expect(events.some(ev => ev.id === 'bad')).toBe(false)
  })

  it('F1: append to file missing trailing newline inserts newline first', () => {
    const e = makeEvent()
    log.append(e)

    const files = fs.readdirSync(tmpDir)
    const filePath = path.join(tmpDir, files[0])

    // Manually strip trailing newline to simulate crash
    const raw = fs.readFileSync(filePath)
    fs.writeFileSync(filePath, raw.slice(0, raw.length - 1))

    // Append second event — must not corrupt first event
    const e2 = makeEvent()
    log.append(e2)

    const log2 = new EventLog({ dataDir: tmpDir })
    const events = log2.loadAll()
    expect(events).toHaveLength(2)
    expect(events.some(ev => ev.id === e.id)).toBe(true)
    expect(events.some(ev => ev.id === e2.id)).toBe(true)
  })

  // ── F4 regression: IPC payload validation ──

  it('F4: rejects event with empty id', () => {
    const e = makeEvent({ id: '' })
    const result = log.append(e)
    expect(result).toBe('error')
    expect(log.loadAll()).toHaveLength(0)
  })

  it('F4: rejects event with non-positive rev', () => {
    const e = makeEvent({ rev: 0 })
    const result = log.append(e)
    expect(result).toBe('error')
  })

  it('F4: rejects event with invalid at date', () => {
    const e = makeEvent({ at: 'not-a-date' })
    const result = log.append(e)
    expect(result).toBe('error')
  })

  it('F4: rejects event with invalid type', () => {
    const e = makeEvent({ type: 'unknown' as never })
    const result = log.append(e)
    expect(result).toBe('error')
  })

  it('F4: rejects event with non-boolean deleted', () => {
    const e = { ...makeEvent(), deleted: 'yes' }
    const result = log.append(e as never)
    expect(result).toBe('error')
  })

  it('F4: rejects event with invalid createdAt', () => {
    const e = makeEvent({ createdAt: 'bad-date' })
    const result = log.append(e)
    expect(result).toBe('error')
  })

  it('F4: rejects event with invalid updatedAt', () => {
    const e = makeEvent({ updatedAt: 'bad-date' })
    const result = log.append(e)
    expect(result).toBe('error')
  })

  it('F4: accepts a fully valid event', () => {
    const e = makeEvent()
    const result = log.append(e)
    expect(result).toBe('ok')
  })

  // ── Tri-state return tests ──

  it('tri-state: append returns ok for new event', () => {
    const e = makeEvent()
    expect(log.append(e)).toBe('ok')
  })

  it('tri-state: append returns duplicate for same id+rev', () => {
    const e = makeEvent()
    log.append(e)
    expect(log.append(e)).toBe('duplicate')
  })

  it('tri-state: append returns error for invalid event (validation failure)', () => {
    const e = makeEvent({ id: '' })
    expect(log.append(e)).toBe('error')
  })

  it('tri-state: duplicate does not add extra line to file', () => {
    const e = makeEvent()
    log.append(e)
    log.append(e)  // duplicate

    const files = fs.readdirSync(tmpDir)
    const filePath = path.join(tmpDir, files[0])
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim())
    expect(lines).toHaveLength(1)
  })

  // ── MF-07: seenIdRevs prevents re-appending already-present old revisions ──

  it('MF-07: appending an already-present old revision returns duplicate (no re-append)', () => {
    const id = uuidv4()
    const now = new Date().toISOString()
    // Write revisions 1, 2, 3 — index will hold rev=3 as max
    const e1 = makeEvent({ id, rev: 1, at: now })
    const e2 = makeEvent({ id, rev: 2, at: now })
    const e3 = makeEvent({ id, rev: 3, at: now })
    expect(log.append(e1)).toBe('ok')
    expect(log.append(e2)).toBe('ok')
    expect(log.append(e3)).toBe('ok')

    // Now simulate reconcile re-downloading rev=1 and rev=2 (they're missing from index)
    // These are already on disk — must return 'duplicate', not 'ok'
    expect(log.append(e1)).toBe('duplicate')
    expect(log.append(e2)).toBe('duplicate')
  })

  it('MF-07: re-appending old revisions does not add new lines to JSONL', () => {
    const id = uuidv4()
    const now = new Date().toISOString()
    const e1 = makeEvent({ id, rev: 1, at: now })
    const e2 = makeEvent({ id, rev: 2, at: now })
    const e3 = makeEvent({ id, rev: 3, at: now })
    log.append(e1)
    log.append(e2)
    log.append(e3)

    const files = fs.readdirSync(tmpDir)
    const filePath = path.join(tmpDir, files[0])
    const linesBefore = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim()).length

    // Simulate reconcile re-appending old revisions
    log.append(e1)
    log.append(e2)

    const linesAfter = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim()).length
    expect(linesAfter).toBe(linesBefore)  // no new lines written
  })

  it('MF-07: seenIdRevs persists across reload — new EventLog instance also rejects old revs', () => {
    const id = uuidv4()
    const now = new Date().toISOString()
    const e1 = makeEvent({ id, rev: 1, at: now })
    const e2 = makeEvent({ id, rev: 2, at: now })
    log.append(e1)
    log.append(e2)

    // New instance after reload must also reject old revisions
    const log2 = new EventLog({ dataDir: tmpDir })
    log2.loadAll()  // warm the index and seenIdRevs
    expect(log2.append(e1)).toBe('duplicate')
  })
})
