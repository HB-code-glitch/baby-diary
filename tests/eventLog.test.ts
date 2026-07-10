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

    expect(r1).toBe(true)
    expect(r2).toBe(false)

    const events = log.loadAll()
    expect(events).toHaveLength(1)
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
})
