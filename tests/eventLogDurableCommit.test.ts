import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import { EventLog } from '../electron/store/eventLog'
import { DiaryEvent } from '../shared/types'
import type { DurableFileOps } from '../electron/store/durableFs'

// These tests cover two review findings about how EventLog.append() reacts to
// appendDurableFileSync throwing DurableAppendCommittedError: the bytes are
// already on disk and fsynced (fileSynced === true) when a *later* step (fd
// close, or parent-directory fsync for a newly created month file) fails.
//
//   Finding 1 (Important): a committed error on the main record append must
//   still be reported as 'ok' and must update the in-memory index/mutations,
//   otherwise the event is durably on disk but invisible until process
//   restart and the caller is told the write failed.
//
//   Finding 2 (Minor): a committed error on the torn-newline repair append
//   (line inserted before the real record when the file's last byte isn't
//   '\n') must not escape append() as an uncaught throw — it must be treated
//   as success and the record append must proceed. A non-committed failure
//   on that same repair append must return 'error', not throw, to preserve
//   the 'ok' | 'duplicate' | 'error' contract.

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

describe('EventLog durably-committed append handling', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('Finding 1: a committed-with-error main record append is reported as ok and updates the in-memory index', () => {
    // closeSync succeeds physically (bytes + fsync land on disk) but throws
    // afterwards, exactly like durableFs.appendDurableFileSync's own tests
    // model a post-commit close failure.
    let closeCalls = 0
    const fileOps: DurableFileOps = {
      ...fs,
      closeSync(fd) {
        closeCalls += 1
        fs.closeSync(fd)
        if (closeCalls === 1) throw new Error('injected close failure after commit')
      },
    }

    const log = new EventLog({ dataDir: tmpDir, fileOps })
    const event = makeEvent()

    const result = log.append(event)
    expect(result).toBe('ok')
    expect(closeCalls).toBe(1)

    // The record must be physically durable on disk.
    const files = fs.readdirSync(tmpDir)
    expect(files).toHaveLength(1)
    const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf-8')
    expect(content).toBe(`${JSON.stringify(event)}\n`)

    // The in-memory index/mutations must be updated without needing a reload,
    // otherwise getAll()/getCount() would omit a physically-durable event
    // until the process restarts and re-runs loadAll().
    expect(log.getAll().some(e => e.id === event.id)).toBe(true)
    expect(log.getAllMutations().some(e => e.id === event.id)).toBe(true)
    expect(log.getCount()).toBe(1)

    // A duplicate append of the same mutation must now be recognized without
    // a reload, proving the mutations map was actually updated in memory.
    expect(log.append(event)).toBe('duplicate')
  })

  it('Finding 2a: a committed-with-error torn-newline repair append is treated as durable and the record append proceeds', () => {
    // First, a normal append creates the month file.
    const plainLog = new EventLog({ dataDir: tmpDir })
    const e1 = makeEvent()
    expect(plainLog.append(e1)).toBe('ok')

    const files = fs.readdirSync(tmpDir)
    expect(files).toHaveLength(1)
    const filePath = path.join(tmpDir, files[0])

    // Simulate a crash that lost the trailing newline after e1.
    const raw = fs.readFileSync(filePath)
    expect(raw[raw.length - 1]).toBe(0x0a)
    fs.writeFileSync(filePath, raw.slice(0, raw.length - 1))

    // closeSync fails only on the FIRST call, which corresponds to the
    // torn-newline repair append (the month file already exists, so no
    // parent-directory sync is attempted for either append in this test).
    let closeCalls = 0
    const fileOps: DurableFileOps = {
      ...fs,
      closeSync(fd) {
        closeCalls += 1
        fs.closeSync(fd)
        if (closeCalls === 1) throw new Error('injected repair close failure after commit')
      },
    }

    const log2 = new EventLog({ dataDir: tmpDir, fileOps })
    const e2 = makeEvent()

    let result: 'ok' | 'duplicate' | 'error' | undefined
    expect(() => { result = log2.append(e2) }).not.toThrow()
    expect(result).toBe('ok')
    expect(closeCalls).toBe(2)

    // Both events must survive on disk, properly separated by the repaired
    // newline, and be visible to a completely fresh instance.
    const log3 = new EventLog({ dataDir: tmpDir })
    const events = log3.loadAll()
    expect(events.some(ev => ev.id === e1.id)).toBe(true)
    expect(events.some(ev => ev.id === e2.id)).toBe(true)
  })

  it('Finding 2b: a non-committed failure during the torn-newline repair append returns \'error\' without throwing', () => {
    const plainLog = new EventLog({ dataDir: tmpDir })
    const e1 = makeEvent()
    expect(plainLog.append(e1)).toBe('ok')

    const files = fs.readdirSync(tmpDir)
    const filePath = path.join(tmpDir, files[0])

    const raw = fs.readFileSync(filePath)
    fs.writeFileSync(filePath, raw.slice(0, raw.length - 1))

    // fsyncSync fails on the first call (before any bytes are committed),
    // rollback succeeds, and the original (non-committed) error is
    // re-thrown by appendDurableFileSync — this must surface as 'error',
    // not as an uncaught exception out of append().
    let fsyncCalls = 0
    const fileOps: DurableFileOps = {
      ...fs,
      fsyncSync(fd) {
        fsyncCalls += 1
        if (fsyncCalls === 1) throw new Error('injected repair fsync failure')
        fs.fsyncSync(fd)
      },
    }

    const log2 = new EventLog({ dataDir: tmpDir, fileOps })
    const e2 = makeEvent()

    let result: 'ok' | 'duplicate' | 'error' | undefined
    expect(() => { result = log2.append(e2) }).not.toThrow()
    expect(result).toBe('error')

    // The rejected append must not have been recorded as a durable mutation.
    expect(log2.getAllMutations().some(ev => ev.id === e2.id)).toBe(false)
  })
})
