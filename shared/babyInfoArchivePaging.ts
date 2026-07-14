import type { BabyInfoUnlinkedArchive } from './types'
import { validateBabyInfoUnlinkedArchive } from './babyInfoResolver'

export const BABY_INFO_ARCHIVE_PAGE_MAX = 50
const CURSOR_PREFIX = 'baby-info-archive-page-v1.'
const ARCHIVE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface BabyInfoArchivePageRequest {
  limit: number
  cursor?: string
}

export interface BabyInfoArchivePage {
  items: BabyInfoUnlinkedArchive[]
  nextCursor?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed)
  return Object.keys(value).every(key => allowedSet.has(key))
}

export function makeBabyInfoArchiveCursor(archiveId: string): string {
  if (!ARCHIVE_ID_PATTERN.test(archiveId)) throw new Error('baby info archive cursor identity is invalid')
  return `${CURSOR_PREFIX}${archiveId}`
}

export function getBabyInfoArchiveIdFromCursor(cursor: string): string {
  if (typeof cursor !== 'string' || !cursor.startsWith(CURSOR_PREFIX)) {
    throw new Error('baby info archive cursor is invalid')
  }
  const archiveId = cursor.slice(CURSOR_PREFIX.length)
  if (!ARCHIVE_ID_PATTERN.test(archiveId)) throw new Error('baby info archive cursor is invalid')
  return archiveId
}

export function parseBabyInfoArchivePageRequest(value: unknown): BabyInfoArchivePageRequest {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['limit', 'cursor'])
    || !Number.isInteger(value.limit)
    || (value.limit as number) < 1
    || (value.limit as number) > BABY_INFO_ARCHIVE_PAGE_MAX
    || (value.cursor !== undefined
      && (typeof value.cursor !== 'string'
        || (() => {
          try { getBabyInfoArchiveIdFromCursor(value.cursor as string); return false } catch { return true }
        })()))) {
    throw new Error('baby info archive page request is invalid')
  }
  return {
    limit: value.limit as number,
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }),
  }
}

export function parseBabyInfoArchivePage(value: unknown): BabyInfoArchivePage {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['items', 'nextCursor'])
    || !Array.isArray(value.items)
    || value.items.length > BABY_INFO_ARCHIVE_PAGE_MAX
    || value.items.some(item => !validateBabyInfoUnlinkedArchive(item))) {
    throw new Error('baby info archive page response is invalid')
  }
  if (value.nextCursor !== undefined) {
    try {
      getBabyInfoArchiveIdFromCursor(value.nextCursor as string)
    } catch {
      throw new Error('baby info archive page response is invalid')
    }
  }
  if (value.nextCursor !== undefined && typeof value.nextCursor !== 'string') {
    throw new Error('baby info archive page response is invalid')
  }
  return {
    items: value.items.map(item => ({ ...(item as BabyInfoUnlinkedArchive) })),
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor as string }),
  }
}
