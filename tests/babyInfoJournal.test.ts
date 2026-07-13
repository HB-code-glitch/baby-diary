import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  BabyInfoJournalSummary,
  BabyInfoMutation,
  BabyInfoPendingPage,
  BabyInfoSyncState,
} from '../shared/types'
import { getBabyInfoMutationKey } from '../shared/babyInfoResolver'
import {
  BABY_INFO_JOURNAL_FILE,
  BabyInfoJournal,
} from '../electron/store/babyInfoJournal'
import type { DurableFileOps } from '../electron/store/durableFs'

function uuid(index: number): string {
  return `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
}

function mutation(index: number, familyId = 'family-A', payload = ''): BabyInfoMutation {
  return {
    mutationId: uuid(index),
    familyId,
    babyName: `baby-${index}-${payload}`,
    babyBirthdate: '2026-01-02',
    logicalClock: index + 1,
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
    authorId: 'user-1',
    origin: 'user',
  }
}

describe('main-process baby-info append-only journal', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-journal-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('persists immutable mutations and durable acknowledgements across restart', () => {
    const first = mutation(1)
    const second = mutation(2)
    const journal = new BabyInfoJournal(tmpDir)

    journal.ingest('family-A', [first, second], [getBabyInfoMutationKey(first)])

    const restarted = new BabyInfoJournal(tmpDir)
    expect(restarted.getSummary('family-A')).toMatchObject({
      mutationCount: 2,
      pendingCount: 1,
      winner: second,
    })
    expect(restarted.listPending('family-A', { limit: 10 }).items).toEqual([second])
  })

  it('deduplicates exact canonical records physically and rejects unknown acknowledgements', () => {
    const item = mutation(3)
    const journal = new BabyInfoJournal(tmpDir)
    journal.ingest('family-A', [item], [])
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const before = fs.readFileSync(journalPath, 'utf8')

    journal.ingest('family-A', [item], [])

    expect(fs.readFileSync(journalPath, 'utf8')).toBe(before)
    expect(() => journal.ingest('family-A', [], [getBabyInfoMutationKey(mutation(999))]))
      .toThrow(/unknown|known/i)
  })

  it('scopes every summary and pending page to the exact validated family id', () => {
    const familyA = mutation(4, 'family-A')
    const familyB = mutation(5, 'family-B')
    const journal = new BabyInfoJournal(tmpDir)
    journal.ingest('family-A', [familyA], [])
    journal.ingest('family-B', [familyB], [])

    expect(journal.listPending('family-A', { limit: 10 }).items).toEqual([familyA])
    expect(journal.listPending('family-B', { limit: 10 }).items).toEqual([familyB])
    expect(() => journal.listPending('../family-A', { limit: 10 })).toThrow(/familyId/i)
  })

  it('tolerates only a torn final record, truncates it before the next append, and recovers', () => {
    const first = mutation(6)
    const second = mutation(7)
    const journal = new BabyInfoJournal(tmpDir)
    journal.ingest('family-A', [first], [])
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    fs.appendFileSync(journalPath, '{"version":1,"type":"mutation"')

    const restarted = new BabyInfoJournal(tmpDir)
    expect(restarted.getSummary('family-A').mutationCount).toBe(1)
    restarted.ingest('family-A', [second], [])

    const twiceRestarted = new BabyInfoJournal(tmpDir)
    expect(twiceRestarted.getSummary('family-A')).toMatchObject({
      mutationCount: 2,
      pendingCount: 2,
      winner: second,
    })
  })

  it('durably inserts a separator after a complete final record whose newline was torn', () => {
    const first = mutation(70)
    const second = mutation(71)
    const journal = new BabyInfoJournal(tmpDir)
    journal.ingest('family-A', [first], [])
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const complete = fs.readFileSync(journalPath, 'utf8')
    expect(complete.endsWith('\n')).toBe(true)
    fs.writeFileSync(journalPath, complete.slice(0, -1), 'utf8')

    const restarted = new BabyInfoJournal(tmpDir)
    expect(restarted.getSummary('family-A').mutationCount).toBe(1)
    restarted.ingest('family-A', [second], [])

    const twiceRestarted = new BabyInfoJournal(tmpDir)
    expect(twiceRestarted.getSummary('family-A')).toMatchObject({
      mutationCount: 2,
      pendingCount: 2,
      winner: second,
    })
  })

  it('fails closed on a malformed terminated record or malformed interior record', () => {
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    fs.writeFileSync(journalPath, '{bad}\n', 'utf8')
    expect(() => new BabyInfoJournal(tmpDir)).toThrow(/corrupt|journal/i)

    fs.writeFileSync(journalPath, '{bad}\n{"version":1', 'utf8')
    expect(() => new BabyInfoJournal(tmpDir)).toThrow(/corrupt|journal/i)
  })

  it('imports legacy settings state once while retaining its pending/ack meaning', () => {
    const pending = mutation(8)
    const acknowledged = mutation(9)
    const state: BabyInfoSyncState = {
      version: 1,
      mutations: [pending, acknowledged],
      pendingMutationKeys: [getBabyInfoMutationKey(pending)],
    }
    const journal = new BabyInfoJournal(tmpDir)

    journal.importLegacyState('settings-revision-7', state)
    journal.importLegacyState('settings-revision-7', state)

    expect(journal.getSummary('family-A')).toMatchObject({ mutationCount: 2, pendingCount: 1 })
    expect(journal.listPending('family-A', { limit: 10 }).items).toEqual([pending])
    expect(journal.hasCompletedImport('settings-revision-7')).toBe(true)
  })

  it('keeps more than 10,000 mutations and over 2 MB restartable with bounded pages', () => {
    const journal = new BabyInfoJournal(tmpDir)
    const total = 10_025
    const payload = 'x'.repeat(220)
    for (let start = 0; start < total; start += 250) {
      const page = Array.from(
        { length: Math.min(250, total - start) },
        (_, offset) => mutation(start + offset + 10_000, 'family-large', payload),
      )
      journal.ingest('family-large', page, [])
    }

    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    expect(fs.statSync(journalPath).size).toBeGreaterThan(2_000_000)

    const restarted = new BabyInfoJournal(tmpDir)
    const firstPage = restarted.listPending('family-large', { limit: 128 })
    expect(restarted.getSummary('family-large')).toMatchObject({
      mutationCount: total,
      pendingCount: total,
      winner: expect.objectContaining({ logicalClock: total + 10_000 }),
    })
    expect(firstPage.items).toHaveLength(128)
    expect(JSON.stringify(firstPage).length).toBeLessThan(100_000)
    expect(firstPage.nextCursor).toBeTypeOf('string')

    // Summary and page reads must not fall back to whole-family Set scans.
    const iteratorDescriptor = Object.getOwnPropertyDescriptor(Set.prototype, Symbol.iterator)!
    let indexedSummary!: BabyInfoJournalSummary
    let indexedPage!: BabyInfoPendingPage
    Object.defineProperty(Set.prototype, Symbol.iterator, {
      ...iteratorDescriptor,
      value() { throw new Error('whole Set iteration is forbidden on the indexed read path') },
    })
    try {
      indexedSummary = restarted.getSummary('family-large')
      indexedPage = restarted.listPending('family-large', { limit: 10 })
    } finally {
      Object.defineProperty(Set.prototype, Symbol.iterator, iteratorDescriptor)
    }
    expect(indexedSummary.pendingCount).toBe(total)
    expect(indexedPage.items).toHaveLength(10)

    const seen = new Set<string>()
    let afterKey: string | undefined
    let remainingBudget = total
    let pageCalls = 0
    let insertedSmaller: BabyInfoMutation | undefined
    while (remainingBudget > 0) {
      const page = restarted.listPending('family-large', {
        limit: Math.min(500, remainingBudget),
        afterKey,
      })
      if (page.items.length === 0) break
      pageCalls += 1
      const keys = page.items.map(getBabyInfoMutationKey)
      for (const key of keys) {
        expect(seen.has(key)).toBe(false)
        seen.add(key)
      }
      restarted.ingest('family-large', [], keys)
      afterKey = keys.at(-1)
      remainingBudget -= keys.length
      if (pageCalls === 1) {
        insertedSmaller = {
          ...mutation(99_999, 'family-large', payload),
          mutationId: '00000000-0000-4000-8000-000000000001',
        }
        expect(getBabyInfoMutationKey(insertedSmaller) < afterKey!).toBe(true)
        restarted.ingest('family-large', [insertedSmaller], [])
      }
    }

    expect(pageCalls).toBe(Math.ceil(total / 500))
    expect(seen.size).toBe(total)
    expect(restarted.getSummary('family-large').pendingCount).toBe(1)
    expect(restarted.listPending('family-large', { limit: 10 }).items).toEqual([insertedSmaller])
    restarted.ingest('family-large', [], [getBabyInfoMutationKey(insertedSmaller!)])

    const drainedRestart = new BabyInfoJournal(tmpDir)
    expect(drainedRestart.getSummary('family-large')).toMatchObject({
      mutationCount: total + 1,
      pendingCount: 0,
      totalPendingCount: 0,
    })
  }, 20_000)

  it('drains 10,025 pending records in 500-record pages without iterating the full mutation Map per page', () => {
    const journal = new BabyInfoJournal(tmpDir)
    const total = 10_025
    const items = Array.from(
      { length: total },
      (_, index) => mutation(index + 40_000, 'family-linear', 'linear'),
    )
    journal.ingest('family-linear', items, [])

    const originalIterator = Map.prototype[Symbol.iterator]
    let mutationMapVisits = 0
    Object.defineProperty(Map.prototype, Symbol.iterator, {
      configurable: true,
      writable: true,
      value: function (this: Map<unknown, unknown>) {
        const iterator = originalIterator.call(this)
        return {
          next() {
            const result = iterator.next()
            if (!result.done
              && Array.isArray(result.value)
              && typeof result.value[0] === 'string'
              && result.value[0].startsWith('baby-info:')) {
              mutationMapVisits += 1
            }
            return result
          },
          [Symbol.iterator]() { return this },
        }
      },
    })
    try {
      let afterKey: string | undefined
      for (;;) {
        const page = journal.listPending('family-linear', { limit: 500, afterKey })
        if (page.items.length === 0) break
        const keys = page.items.map(getBabyInfoMutationKey)
        journal.ingest('family-linear', [], keys)
        afterKey = keys.at(-1)
      }
    } finally {
      Object.defineProperty(Map.prototype, Symbol.iterator, {
        configurable: true,
        writable: true,
        value: originalIterator,
      })
    }

    expect(journal.getSummary('family-linear').pendingCount).toBe(0)
    expect(mutationMapVisits).toBeLessThan(total * 2)
  }, 20_000)

  it('reloads and applies the exact complete durable prefix after a partial append failure', () => {
    const targets = new Map<number, string>()
    const realOpen = fs.openSync.bind(fs)
    let injectFailure = false
    let prefixWritten = false
    const durableFs: DurableFileOps = {
      ...fs,
      openSync(target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
        const fd = realOpen(target, flags, mode)
        targets.set(fd, String(target))
        return fd
      },
      writeSync(fd, buffer, offset, length, position) {
        if (injectFailure && targets.get(fd)?.endsWith(BABY_INFO_JOURNAL_FILE)) {
          if (prefixWritten) throw new Error('injected partial append failure')
          const newline = Buffer.from(buffer).indexOf(0x0a, offset)
          const prefixLength = newline - offset + 1
          prefixWritten = true
          return fs.writeSync(fd, buffer, offset, Math.min(length, prefixLength), position)
        }
        return fs.writeSync(fd, buffer, offset, length, position)
      },
      closeSync(fd) {
        targets.delete(fd)
        fs.closeSync(fd)
      },
    }
    const journal = new (BabyInfoJournal as unknown as new (
      root: string,
      options: { durableFs: DurableFileOps },
    ) => BabyInfoJournal)(tmpDir, { durableFs })
    const first = mutation(70_001, 'family-prefix')
    const second = mutation(70_002, 'family-prefix')

    injectFailure = true
    expect(() => journal.ingest('family-prefix', [first, second], []))
      .toThrow(/partial append failure/)
    injectFailure = false

    expect(journal.getSummary('family-prefix')).toMatchObject({
      mutationCount: 1,
      pendingCount: 1,
      winner: first,
    })
    journal.ingest('family-prefix', [first, second], [])
    expect(new BabyInfoJournal(tmpDir).getSummary('family-prefix')).toMatchObject({
      mutationCount: 2,
      pendingCount: 2,
      winner: second,
    })
  })
})
