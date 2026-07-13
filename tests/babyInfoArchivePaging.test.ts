import { describe, expect, it } from 'vitest'
import { makeBabyInfoUnlinkedArchive } from '../shared/babyInfoResolver'
import {
  BABY_INFO_ARCHIVE_PAGE_MAX,
  getBabyInfoArchiveIdFromCursor,
  makeBabyInfoArchiveCursor,
  parseBabyInfoArchivePage,
  parseBabyInfoArchivePageRequest,
} from '../shared/babyInfoArchivePaging'

describe('baby-info unlinked archive paging contract', () => {
  const archive = makeBabyInfoUnlinkedArchive(
    'Legacy baby',
    '2025-03-04',
    '2026-07-14T00:00:00.000Z',
  )!

  it('accepts only exact bounded requests and opaque deterministic cursors', () => {
    const cursor = makeBabyInfoArchiveCursor(archive.archiveId)

    expect(BABY_INFO_ARCHIVE_PAGE_MAX).toBe(50)
    expect(parseBabyInfoArchivePageRequest({ limit: 10 })).toEqual({ limit: 10 })
    expect(parseBabyInfoArchivePageRequest({ limit: 50, cursor })).toEqual({ limit: 50, cursor })
    expect(makeBabyInfoArchiveCursor(archive.archiveId)).toBe(cursor)
    expect(getBabyInfoArchiveIdFromCursor(cursor)).toBe(archive.archiveId)

    for (const invalid of [
      null,
      {},
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { limit: 10, cursor: '' },
      { limit: 10, cursor: archive.archiveId },
      { limit: 10, extra: true },
    ]) {
      expect(() => parseBabyInfoArchivePageRequest(invalid)).toThrow(/archive page request/i)
    }
  })

  it('strictly validates bounded response pages and clones their items', () => {
    const cursor = makeBabyInfoArchiveCursor(archive.archiveId)
    const raw = { items: [archive], nextCursor: cursor }
    const parsed = parseBabyInfoArchivePage(raw)

    expect(parsed).toEqual(raw)
    expect(parsed).not.toBe(raw)
    expect(parsed.items[0]).not.toBe(archive)

    for (const invalid of [
      null,
      { items: 'nope' },
      { items: [archive], nextCursor: '' },
      { items: [archive], extra: true },
      { items: Array.from({ length: 51 }, () => archive) },
      { items: [{ ...archive, archiveId: 'not-an-id' }] },
    ]) {
      expect(() => parseBabyInfoArchivePage(invalid)).toThrow(/archive page response/i)
    }
  })
})
