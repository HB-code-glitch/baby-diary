import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BabyInfoMutation, BabyInfoSyncState } from '../shared/types'
import { getBabyInfoMutationKey } from '../shared/babyInfoResolver'
import {
  BABY_INFO_JOURNAL_FILE,
  BabyInfoJournal,
} from '../electron/store/babyInfoJournal'

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
  }, 20_000)
})
