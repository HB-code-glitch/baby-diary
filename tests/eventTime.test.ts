import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiaryEvent, EventType } from '../shared/types'

interface EventTimeModule {
  eventTimestampMs?: (at: string) => number | null
  sortEventsNewestFirst?: <T extends { id: string; at: string }>(events: readonly T[]) => T[]
  sortValidEventsNewestFirst?: <T extends { id: string; at: string }>(events: readonly T[]) => T[]
  isEventAtOrBefore?: (eventAt: string, cutoff: string | number | Date) => boolean
}

function makeEvent(id: string, at: string, type: EventType = 'formula'): DiaryEvent {
  return {
    id,
    type,
    at,
    data: type === 'formula' ? { ml: 120 } : type === 'breast' ? { side: 'L' } : {},
    author: { uid: 'test', name: 'Tester', role: 'mom' },
    createdAt: at,
    updatedAt: at,
    rev: 1,
    deleted: false,
  } as DiaryEvent
}

async function loadEventTimeModule(): Promise<EventTimeModule> {
  return vi.importActual<EventTimeModule>('../src/lib/eventTime')
    .catch(() => ({}))
}

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(name => {
    const absolute = join(directory, name)
    return statSync(absolute).isDirectory()
      ? collectSourceFiles(absolute)
      : /\.(?:ts|tsx)$/.test(name) ? [relative(process.cwd(), absolute).replaceAll('\\', '/')] : []
  })
}

describe('event timestamp epoch ordering', () => {
  afterEach(async () => {
    vi.useRealTimers()
    const { useAppStore } = await import('../src/store/useAppStore')
    useAppStore.setState({ events: [] })
  })

  it('orders mixed ISO offsets by numeric epoch without mutating input', async () => {
    const { sortEventsNewestFirst } = await loadEventTimeModule()
    expect(sortEventsNewestFirst).toBeTypeOf('function')
    if (!sortEventsNewestFirst) return

    const earlier = makeEvent('earlier-01z', '2026-07-13T10:00:00+09:00')
    const later = makeEvent('later-02z', '2026-07-13T02:00:00Z')
    const input = [earlier, later]
    const originalOrder = input.map(event => event.id)

    expect(sortEventsNewestFirst(input).map(event => event.id)).toEqual(['later-02z', 'earlier-01z'])
    expect(input.map(event => event.id)).toEqual(originalOrder)
  })

  it('puts invalid timestamps last, excludes them when requested, and breaks epoch ties by id', async () => {
    const { sortEventsNewestFirst, sortValidEventsNewestFirst } = await loadEventTimeModule()
    expect(sortEventsNewestFirst).toBeTypeOf('function')
    expect(sortValidEventsNewestFirst).toBeTypeOf('function')
    if (!sortEventsNewestFirst || !sortValidEventsNewestFirst) return

    const input = [
      makeEvent('invalid-z', 'not-a-date'),
      makeEvent('tie-b', '2026-07-13T11:00:00+09:00'),
      makeEvent('invalid-a', 'also-not-a-date'),
      makeEvent('tie-a', '2026-07-13T02:00:00Z'),
    ]
    const originalOrder = input.map(event => event.id)

    expect(sortEventsNewestFirst(input).map(event => event.id)).toEqual([
      'tie-a', 'tie-b', 'invalid-a', 'invalid-z',
    ])
    expect(sortValidEventsNewestFirst(input).map(event => event.id)).toEqual(['tie-a', 'tie-b'])
    expect(input.map(event => event.id)).toEqual(originalOrder)
  })

  it('rejects ISO timestamps whose calendar date does not exist', async () => {
    const { eventTimestampMs, sortValidEventsNewestFirst } = await loadEventTimeModule()
    expect(eventTimestampMs).toBeTypeOf('function')
    expect(sortValidEventsNewestFirst).toBeTypeOf('function')
    if (!eventTimestampMs || !sortValidEventsNewestFirst) return

    const impossible = makeEvent('impossible-date', '2026-02-30T10:00:00+09:00')

    expect(eventTimestampMs(impossible.at)).toBeNull()
    expect(sortValidEventsNewestFirst([impossible])).toEqual([])
  })

  it('includes the same instant in an offset form and excludes a lexically earlier future instant', async () => {
    const { isEventAtOrBefore } = await loadEventTimeModule()
    expect(isEventAtOrBefore).toBeTypeOf('function')
    if (!isEventAtOrBefore) return

    const now = '2026-07-13T02:00:00Z'
    expect(isEventAtOrBefore('2026-07-13T11:00:00+09:00', now)).toBe(true)
    expect(isEventAtOrBefore('2026-07-12T21:30:00-05:00', now)).toBe(false)
    expect(isEventAtOrBefore('not-a-date', now)).toBe(false)
  })

  it('uses epoch order in store selectors and excludes future feedings across offsets', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-13T02:00:00Z'))
    const { useAppStore } = await import('../src/store/useAppStore')
    const events = [
      makeEvent('older-01z', '2026-07-13T10:00:00+09:00'),
      makeEvent('current-02z', '2026-07-13T11:00:00+09:00'),
      makeEvent('future-0230z', '2026-07-12T21:30:00-05:00', 'breast'),
    ]
    const originalOrder = events.map(event => event.id)
    useAppStore.setState({ events })

    expect(useAppStore.getState().lastFeeding()?.id).toBe('current-02z')
    expect(useAppStore.getState().todayEvents().map(event => event.id)).toEqual([
      'future-0230z', 'current-02z', 'older-01z',
    ])
    expect(useAppStore.getState().eventsForDay(new Date('2026-07-13T12:00:00+09:00')).map(event => event.id))
      .toEqual(['future-0230z', 'current-02z', 'older-01z'])
    expect(events.map(event => event.id)).toEqual(originalOrder)
  })

  it('prevents event.at lexical time ordering from returning to source and E2E expectations', () => {
    const offenders = collectSourceFiles('src').flatMap(path => {
      const source = readFileSync(path, 'utf8')
      return [
        source.match(/\.at\.localeCompare\s*\(/) ? `${path}: .at.localeCompare` : null,
        source.match(/\.at\s*(?:<=|>=|<|>)/) ? `${path}: relational event.at comparison` : null,
        source.match(/\bat\s*<=\s*nowIso\b/) ? `${path}: at <= nowIso` : null,
      ].filter((value): value is string => value !== null)
    })
    const e2eSource = readFileSync('scripts/mac-e2e.mjs', 'utf8')
    if (/\.at\.localeCompare\s*\(/.test(e2eSource)) offenders.push('scripts/mac-e2e.mjs: .at.localeCompare')

    expect(offenders).toEqual([])
  })
})
