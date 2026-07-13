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
import { getBabyInfoMutationKey, makeBabyInfoUnlinkedArchive } from '../shared/babyInfoResolver'
import {
  makeBabyInfoArchiveCursor,
  type BabyInfoArchivePage,
  type BabyInfoArchivePageRequest,
} from '../shared/babyInfoArchivePaging'
import {
  BABY_INFO_JOURNAL_FILE,
  BabyInfoJournal,
  MAX_BABY_INFO_JOURNAL_RECORD_BYTES,
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

  it('applies the same single-record bound to normal and chunked replay', () => {
    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const oversized = Buffer.alloc(MAX_BABY_INFO_JOURNAL_RECORD_BYTES + 1, 0x20)
    fs.writeFileSync(journalPath, oversized)
    expect(() => new BabyInfoJournal(tmpDir)).toThrow(/record exceeds its size bound/i)

    const replay = BabyInfoJournal.createChunkReplay({ allowTornFinal: true })
    replay.push(oversized.subarray(0, MAX_BABY_INFO_JOURNAL_RECORD_BYTES))
    expect(() => replay.push(oversized.subarray(MAX_BABY_INFO_JOURNAL_RECORD_BYTES)))
      .toThrow(/record exceeds its size bound/i)
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

  it('pages 10,025 archives newest-first without gaps, duplicates, full sorting, or cloud pending work', () => {
    const total = 10_025
    const base = Date.parse('2026-01-01T00:00:00.000Z')
    const archives = Array.from({ length: total }, (_, index) => makeBabyInfoUnlinkedArchive(
      `legacy-${index}`,
      '2025-01-02',
      new Date(base + index).toISOString(),
    )!)
    fs.writeFileSync(
      path.join(tmpDir, BABY_INFO_JOURNAL_FILE),
      `${archives.map(archive => JSON.stringify({
        version: 1,
        type: 'unlinked-archive',
        archive,
      })).join('\n')}\n`,
    )
    const journal = new BabyInfoJournal(tmpDir) as BabyInfoJournal & {
      listUnlinkedArchivePage: (request: BabyInfoArchivePageRequest) => BabyInfoArchivePage
    }

    const seen: string[] = []
    let cursor: string | undefined
    for (;;) {
      const page = journal.listUnlinkedArchivePage({ limit: 50, ...(cursor ? { cursor } : {}) })
      seen.push(...page.items.map(item => item.archiveId))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }

    expect(seen).toHaveLength(total)
    expect(new Set(seen).size).toBe(total)
    expect(seen[0]).toBe(archives.at(-1)!.archiveId)
    expect(seen.at(-1)).toBe(archives[0].archiveId)
    expect(journal.getTotalPendingCount()).toBe(0)
    expect(() => journal.listUnlinkedArchivePage({
      limit: 10,
      cursor: makeBabyInfoArchiveCursor('00000000-0000-4000-8000-000000000001'),
    })).toThrow(/cursor|unknown/i)

    const replayed = new BabyInfoJournal('', {
      sourceBuffer: fs.readFileSync(path.join(tmpDir, BABY_INFO_JOURNAL_FILE)),
    }) as BabyInfoJournal & {
      listUnlinkedArchivePage: (request: BabyInfoArchivePageRequest) => BabyInfoArchivePage
    }
    expect(replayed.listUnlinkedArchivePage({ limit: 3 }).items.map(item => item.archiveId))
      .toEqual(archives.slice(-3).reverse().map(item => item.archiveId))
    expect(replayed.getTotalPendingCount()).toBe(0)
  }, 20_000)

  it('rolls a partial append back and keeps memory on the last confirmed prefix', () => {
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
      mutationCount: 0,
      pendingCount: 0,
      winner: undefined,
    })
    journal.ingest('family-prefix', [first, second], [])
    expect(new BabyInfoJournal(tmpDir).getSummary('family-prefix')).toMatchObject({
      mutationCount: 2,
      pendingCount: 2,
      winner: second,
    })
  })

  it('becomes storage-uncertain and blocks mutation/cloud pages without ingesting a complete failed suffix', () => {
    const realOpen = fs.openSync.bind(fs)
    const targets = new Map<number, string>()
    let injectFailure = false
    let appendFsyncFailed = false
    let closeFailedAfterRollback = false
    const durableFs: DurableFileOps = {
      ...fs,
      openSync(target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
        const fd = realOpen(target, flags, mode)
        targets.set(fd, String(target))
        return fd
      },
      fsyncSync(fd) {
        if (injectFailure
          && targets.get(fd)?.endsWith(BABY_INFO_JOURNAL_FILE)
          && !appendFsyncFailed) {
          appendFsyncFailed = true
          throw new Error('injected complete append fsync failure')
        }
        fs.fsyncSync(fd)
      },
      ftruncateSync(fd, length) {
        if (injectFailure && targets.get(fd)?.endsWith(BABY_INFO_JOURNAL_FILE)) {
          throw new Error('injected rollback failure')
        }
        fs.ftruncateSync(fd, length)
      },
      closeSync(fd) {
        const target = targets.get(fd)
        targets.delete(fd)
        fs.closeSync(fd)
        if (injectFailure
          && appendFsyncFailed
          && !closeFailedAfterRollback
          && target?.endsWith(BABY_INFO_JOURNAL_FILE)) {
          closeFailedAfterRollback = true
          throw new Error('injected close failure after uncertain rollback')
        }
      },
    }
    const journal = new (BabyInfoJournal as unknown as new (
      root: string,
      options: { durableFs: DurableFileOps },
    ) => BabyInfoJournal)(tmpDir, { durableFs })
    const item = mutation(70_003, 'family-uncertain')

    injectFailure = true
    let caught: unknown
    try { journal.ingest('family-uncertain', [item], []) } catch (error) { caught = error }

    expect(caught).toMatchObject({ code: 'DURABLE_APPEND_UNCERTAIN' })
    expect(closeFailedAfterRollback).toBe(true)
    expect(journal.getSummary('family-uncertain')).toMatchObject({
      mutationCount: 0,
      pendingCount: 0,
    })
    expect(() => journal.listPending('family-uncertain', { limit: 10 }))
      .toThrow(expect.objectContaining({ code: 'BABY_INFO_STORAGE_UNCERTAIN' }))
    expect(() => journal.ingest('family-uncertain', [item], []))
      .toThrow(expect.objectContaining({ code: 'BABY_INFO_STORAGE_UNCERTAIN' }))

    // A fresh process may validate the complete physical suffix; only the
    // failed process is forbidden from treating it as confirmed.
    expect(new BabyInfoJournal(tmpDir).getSummary('family-uncertain')).toMatchObject({
      mutationCount: 1,
      pendingCount: 1,
      winner: item,
    })
  })

  it('fails closed after torn-tail truncation succeeds but its fsync cannot confirm durability', () => {
    const confirmed = mutation(70_004, 'family-torn')
    const candidate = mutation(70_005, 'family-torn')
    new BabyInfoJournal(tmpDir).ingest('family-torn', [confirmed], [])

    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    fs.appendFileSync(journalPath, '{"version":1,"type":"mutation"')

    const realOpen = fs.openSync.bind(fs)
    const targets = new Map<number, string>()
    let truncationCompleted = false
    let injectTruncateFsyncFailure = true
    let journalWrites = 0
    const durableFs: DurableFileOps = {
      ...fs,
      openSync(target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
        const fd = realOpen(target, flags, mode)
        targets.set(fd, String(target))
        return fd
      },
      writeSync(fd, buffer, offset, length, position) {
        if (targets.get(fd)?.endsWith(BABY_INFO_JOURNAL_FILE)) journalWrites += 1
        return fs.writeSync(fd, buffer, offset, length, position)
      },
      ftruncateSync(fd, length) {
        fs.ftruncateSync(fd, length)
        if (targets.get(fd)?.endsWith(BABY_INFO_JOURNAL_FILE)) truncationCompleted = true
      },
      fsyncSync(fd) {
        if (injectTruncateFsyncFailure
          && truncationCompleted
          && targets.get(fd)?.endsWith(BABY_INFO_JOURNAL_FILE)) {
          injectTruncateFsyncFailure = false
          throw new Error('injected torn-tail fsync failure')
        }
        fs.fsyncSync(fd)
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

    let caught: unknown
    try { journal.ingest('family-torn', [candidate], []) } catch (error) { caught = error }

    expect(caught).toMatchObject({ code: 'DURABLE_TRUNCATE_UNCERTAIN' })
    expect(journalWrites).toBe(0)
    expect(journal.getSummary('family-torn')).toMatchObject({
      mutationCount: 1,
      pendingCount: 1,
      winner: confirmed,
    })
    expect(() => journal.listPending('family-torn', { limit: 10 }))
      .toThrow(expect.objectContaining({ code: 'BABY_INFO_STORAGE_UNCERTAIN' }))
    expect(() => journal.ingest('family-torn', [candidate], []))
      .toThrow(expect.objectContaining({ code: 'BABY_INFO_STORAGE_UNCERTAIN' }))
    expect(journalWrites).toBe(0)

    const restarted = new BabyInfoJournal(tmpDir)
    expect(restarted.getSummary('family-torn')).toMatchObject({
      mutationCount: 1,
      pendingCount: 1,
      winner: confirmed,
    })
    restarted.ingest('family-torn', [candidate], [])
    expect(restarted.getSummary('family-torn')).toMatchObject({
      mutationCount: 2,
      pendingCount: 2,
      winner: candidate,
    })
  })

  it('latches read-only after torn-tail truncation commits but its file close fails', () => {
    const confirmed = mutation(70_009, 'family-truncate-close')
    const candidate = mutation(70_010, 'family-truncate-close')
    new BabyInfoJournal(tmpDir).ingest('family-truncate-close', [confirmed], [])

    const journalPath = path.join(tmpDir, BABY_INFO_JOURNAL_FILE)
    const confirmedBytes = fs.readFileSync(journalPath)
    fs.appendFileSync(journalPath, '{"version":1,"type":"mutation"')

    const realOpen = fs.openSync.bind(fs)
    const targets = new Map<number, string>()
    let truncationCompleted = false
    let truncateFileSynced = false
    let closeFailed = false
    let journalWrites = 0
    const durableFs: DurableFileOps = {
      ...fs,
      openSync(target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
        const fd = realOpen(target, flags, mode)
        targets.set(fd, String(target))
        return fd
      },
      writeSync(fd, buffer, offset, length, position) {
        if (targets.get(fd)?.endsWith(BABY_INFO_JOURNAL_FILE)) journalWrites += 1
        return fs.writeSync(fd, buffer, offset, length, position)
      },
      ftruncateSync(fd, length) {
        fs.ftruncateSync(fd, length)
        if (targets.get(fd)?.endsWith(BABY_INFO_JOURNAL_FILE)) truncationCompleted = true
      },
      fsyncSync(fd) {
        fs.fsyncSync(fd)
        if (truncationCompleted && targets.get(fd)?.endsWith(BABY_INFO_JOURNAL_FILE)) {
          truncateFileSynced = true
        }
      },
      closeSync(fd) {
        const target = targets.get(fd)
        targets.delete(fd)
        fs.closeSync(fd)
        if (!closeFailed
          && truncationCompleted
          && truncateFileSynced
          && target?.endsWith(BABY_INFO_JOURNAL_FILE)) {
          closeFailed = true
          throw new Error('injected committed truncate close failure')
        }
      },
    }
    const journal = new (BabyInfoJournal as unknown as new (
      root: string,
      options: { durableFs: DurableFileOps },
    ) => BabyInfoJournal)(tmpDir, { durableFs })

    let caught: unknown
    try { journal.ingest('family-truncate-close', [candidate], []) } catch (error) { caught = error }

    expect(caught).toMatchObject({
      code: 'DURABLE_TRUNCATE_COMMITTED_WITH_ERROR',
      committed: true,
      fileSynced: true,
      truncatedLength: confirmedBytes.byteLength,
    })
    expect(closeFailed).toBe(true)
    expect(journalWrites).toBe(0)
    expect(fs.readFileSync(journalPath)).toEqual(confirmedBytes)
    expect(journal.getSummary('family-truncate-close')).toMatchObject({
      mutationCount: 1,
      pendingCount: 1,
      winner: confirmed,
    })
    expect(() => journal.listPending('family-truncate-close', { limit: 10 }))
      .toThrow(expect.objectContaining({ code: 'BABY_INFO_STORAGE_UNCERTAIN' }))
    expect(() => journal.ingest('family-truncate-close', [candidate], []))
      .toThrow(expect.objectContaining({ code: 'BABY_INFO_STORAGE_UNCERTAIN' }))
    expect(journalWrites).toBe(0)

    const restarted = new BabyInfoJournal(tmpDir)
    expect(restarted.getSummary('family-truncate-close')).toMatchObject({
      mutationCount: 1,
      pendingCount: 1,
      winner: confirmed,
    })
    restarted.ingest('family-truncate-close', [candidate], [])
    expect(restarted.getSummary('family-truncate-close')).toMatchObject({
      mutationCount: 2,
      pendingCount: 2,
      winner: candidate,
    })
  })

  it('fails closed when an append is durable but its handle close reports an error', () => {
    const confirmed = mutation(70_006, 'family-close')
    const committed = mutation(70_007, 'family-close')
    const later = mutation(70_008, 'family-close')
    new BabyInfoJournal(tmpDir).ingest('family-close', [confirmed], [])

    const realOpen = fs.openSync.bind(fs)
    const targets = new Map<number, string>()
    let appendFsyncCompleted = false
    let injectCloseFailure = true
    let journalWrites = 0
    const durableFs: DurableFileOps = {
      ...fs,
      openSync(target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) {
        const fd = realOpen(target, flags, mode)
        targets.set(fd, String(target))
        return fd
      },
      writeSync(fd, buffer, offset, length, position) {
        if (targets.get(fd)?.endsWith(BABY_INFO_JOURNAL_FILE)) journalWrites += 1
        return fs.writeSync(fd, buffer, offset, length, position)
      },
      fsyncSync(fd) {
        fs.fsyncSync(fd)
        if (targets.get(fd)?.endsWith(BABY_INFO_JOURNAL_FILE) && journalWrites > 0) {
          appendFsyncCompleted = true
        }
      },
      closeSync(fd) {
        const target = targets.get(fd)
        targets.delete(fd)
        fs.closeSync(fd)
        if (injectCloseFailure
          && appendFsyncCompleted
          && target?.endsWith(BABY_INFO_JOURNAL_FILE)) {
          injectCloseFailure = false
          throw new Error('injected post-fsync close failure')
        }
      },
    }
    const journal = new (BabyInfoJournal as unknown as new (
      root: string,
      options: { durableFs: DurableFileOps },
    ) => BabyInfoJournal)(tmpDir, { durableFs })

    let caught: unknown
    try { journal.ingest('family-close', [committed], []) } catch (error) { caught = error }

    expect(caught).toMatchObject({
      code: 'DURABLE_APPEND_COMMITTED_WITH_ERROR',
      committed: true,
    })
    expect(journal.getSummary('family-close')).toMatchObject({
      mutationCount: 1,
      pendingCount: 1,
      winner: confirmed,
    })
    expect(() => journal.listPending('family-close', { limit: 10 }))
      .toThrow(expect.objectContaining({ code: 'BABY_INFO_STORAGE_UNCERTAIN' }))

    journalWrites = 0
    expect(() => journal.ingest('family-close', [later], []))
      .toThrow(expect.objectContaining({ code: 'BABY_INFO_STORAGE_UNCERTAIN' }))
    expect(journalWrites).toBe(0)

    const restarted = new BabyInfoJournal(tmpDir)
    expect(restarted.getSummary('family-close')).toMatchObject({
      mutationCount: 2,
      pendingCount: 2,
      winner: committed,
    })
    restarted.ingest('family-close', [later], [])
    expect(restarted.getSummary('family-close')).toMatchObject({
      mutationCount: 3,
      pendingCount: 3,
      winner: later,
    })
  })
})
