import { describe, expect, it } from 'vitest'
import type { EventType } from '../shared/types'
import {
  EVENT_DATA_LIMITS,
  validateDiaryEventData,
} from '../shared/eventDataValidator'
import { validateDiaryEvent } from '../shared/eventResolver'

function expectValid(type: EventType, data: unknown, deleted = false): void {
  expect(validateDiaryEventData(type, data, { deleted })).toBeNull()
}

function expectInvalid(type: EventType, data: unknown, deleted = false): void {
  expect(validateDiaryEventData(type, data, { deleted })).not.toBeNull()
}

describe('DiaryEvent data trust-boundary validator', () => {
  it.each([
    ['pee', {}],
    ['pee', { note: '젖은 기저귀' }],
    ['poop', {}],
    ['temp', { celsius: 35 }],
    ['temp', { celsius: 42, note: '' }],
    ['breast', { side: 'L' }],
    ['breast', { side: 'R', minutes: 120 }],
    ['breast', { side: 'both', minutes: 240, note: '타이머 기록' }],
    ['formula', { ml: 10 }],
    ['formula', { ml: 2000, note: '' }],
    ['sleep', { minutes: 1 }],
    ['sleep', { minutes: 960, note: '밤잠' }],
    ['growth', { weightKg: 0.5 }],
    ['growth', { heightCm: 120 }],
    ['growth', { weightKg: 30, heightCm: 30, note: '' }],
    ['diary', { title: '', text: '오늘의 기록' }],
    ['diary', { text: '제목 없는 기록' }],
    ['message', { text: '사랑해' }],
  ] as const)('accepts legal %s UI payload %#', (type, data) => {
    expectValid(type, data)
  })

  it('uses exact type-specific keys and required fields', () => {
    expectInvalid('pee', { amount: 1 })
    expectInvalid('temp', {})
    expectInvalid('temp', { celsius: 37, unit: 'C' })
    expectInvalid('breast', { side: 'left' })
    expectInvalid('formula', { ml: 120, side: 'L' })
    expectInvalid('growth', {})
    expectInvalid('diary', { title: 'empty' })
    expectInvalid('message', { text: 'ok', extra: true })
  })

  it('rejects non-finite, non-integer and physically impossible numbers before UI formatting', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '38.5']) {
      expectInvalid('temp', { celsius: value })
    }
    expectInvalid('temp', { celsius: 34.9 })
    expectInvalid('temp', { celsius: 42.1 })
    expectInvalid('breast', { side: 'L', minutes: 1.5 })
    expectInvalid('breast', { side: 'L', minutes: 241 })
    expectInvalid('formula', { ml: 0 })
    expectInvalid('formula', { ml: 2001 })
    expectInvalid('sleep', { minutes: 0 })
    expectInvalid('sleep', { minutes: 961 })
    expectInvalid('growth', { weightKg: 0.49 })
    expectInvalid('growth', { heightCm: 120.1 })
  })

  it('rejects non-plain, cyclic, sparse, accessor and undefined JSON values', () => {
    const inherited = Object.create({ celsius: 37 })
    expectInvalid('temp', inherited)

    const cyclic: Record<string, unknown> = { text: 'x' }
    cyclic.self = cyclic
    expectInvalid('message', cyclic)

    const sparse: unknown[] = []
    sparse.length = 2
    expectInvalid('message', { text: 'x', sparse })

    const accessor = Object.create(null) as Record<string, unknown>
    Object.defineProperty(accessor, 'text', { enumerable: true, get: () => 'x' })
    expectInvalid('message', accessor)
    expectInvalid('pee', { note: undefined })
    expectInvalid('pee', { note: Symbol('not-json') })
  })

  it('bounds every free-text field and the encoded payload', () => {
    expectValid('pee', { note: 'n'.repeat(EVENT_DATA_LIMITS.noteCharacters) })
    expectInvalid('pee', { note: 'n'.repeat(EVENT_DATA_LIMITS.noteCharacters + 1) })
    expectValid('diary', {
      title: 't'.repeat(EVENT_DATA_LIMITS.titleCharacters),
      text: 'x'.repeat(EVENT_DATA_LIMITS.longTextCharacters),
    })
    expectInvalid('diary', { text: 'x'.repeat(EVENT_DATA_LIMITS.longTextCharacters + 1) })
    expectInvalid('message', { text: '가'.repeat(EVENT_DATA_LIMITS.maxPayloadBytes) })
  })

  it('requires meaningful diary/message text', () => {
    expectInvalid('diary', { text: '' })
    expectInvalid('diary', { text: '   ' })
    expectInvalid('message', { text: '\n\t' })
  })

  it('keeps tombstones immutable and schema-valid instead of accepting arbitrary deletion payloads', () => {
    expectValid('formula', { ml: 120 }, true)
    expectInvalid('formula', {}, true)
    expectInvalid('temp', { celsius: 'deleted' }, true)
  })

  it('is enforced by the real shared event boundary for all local append/upload paths', () => {
    const base = {
      id: 'event-1',
      mutationId: '11111111-1111-4111-8111-111111111111',
      type: 'temp' as const,
      at: '2026-07-13T10:00:00.000Z',
      data: { celsius: 38.5 },
      author: { uid: 'writer', name: 'Parent', role: 'mom' as const },
      createdAt: '2026-07-13T10:00:00.000Z',
      updatedAt: '2026-07-13T10:00:00.000Z',
      rev: 1,
      deleted: false,
    }

    expect(validateDiaryEvent(base)).toBeNull()
    expect(validateDiaryEvent({ ...base, data: { celsius: '38.5' } })).toMatch(/data|celsius/i)
    expect(validateDiaryEvent({ ...base, extra: true })).toMatch(/field|key|shape/i)
    expect(validateDiaryEvent({
      ...base,
      author: { ...base.author, admin: true },
    })).toMatch(/author/i)
  })
})
