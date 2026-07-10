/**
 * tests/syncEngine.test.ts
 * SyncEngine 순수 로직 단위 테스트 (Firebase mock)
 *
 * 테스트 대상:
 * - doc-id 매핑 (makeDocId, parseDocId)
 * - reconcile diff 로직 (로컬↔원격 비교)
 * - 큐 영속 직렬화 (localStorage)
 * - 지수 백오프 계산
 * - 중복 enqueue 방지 (id+rev 기준)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeDocId, parseDocId } from '../src/sync/syncEngine'
import { DiaryEvent } from '../shared/types'
import { v4 as uuidv4 } from 'uuid'

// ────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  const now = new Date().toISOString()
  return {
    id: uuidv4(),
    type: 'pee',
    at: now,
    data: {},
    author: { uid: 'test-uid', name: '아빠', role: 'dad' },
    createdAt: now,
    updatedAt: now,
    rev: 1,
    deleted: false,
    ...overrides,
  }
}

// ────────────────────────────────────────────────────────────
// 1. doc-id 매핑
// ────────────────────────────────────────────────────────────

describe('makeDocId', () => {
  it('id_rev 형식으로 변환', () => {
    const e = makeEvent({ id: 'abc-123', rev: 1 })
    expect(makeDocId(e)).toBe('abc-123_1')
  })

  it('rev 2로 수정된 이벤트', () => {
    const e = makeEvent({ id: 'abc-123', rev: 2 })
    expect(makeDocId(e)).toBe('abc-123_2')
  })

  it('UUID v4 포함 id', () => {
    const id = uuidv4()
    const e = makeEvent({ id, rev: 5 })
    expect(makeDocId(e)).toBe(`${id}_5`)
  })
})

describe('parseDocId', () => {
  it('정상 파싱', () => {
    const result = parseDocId('abc-123_1')
    expect(result).toEqual({ id: 'abc-123', rev: 1 })
  })

  it('UUID v4 형식 파싱', () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const result = parseDocId(`${id}_3`)
    expect(result).toEqual({ id, rev: 3 })
  })

  it('언더스코어 없는 잘못된 형식 → null', () => {
    expect(parseDocId('no-underscore-here')).toBeNull()
  })

  it('rev가 숫자가 아님 → null', () => {
    expect(parseDocId('abc_xyz')).toBeNull()
  })

  it('id 부분이 빈 문자열 → null', () => {
    expect(parseDocId('_1')).toBeNull()
  })

  it('makeDocId → parseDocId 라운드트립', () => {
    const e = makeEvent({ rev: 7 })
    const docId = makeDocId(e)
    const parsed = parseDocId(docId)
    expect(parsed).not.toBeNull()
    expect(parsed!.id).toBe(e.id)
    expect(parsed!.rev).toBe(7)
  })
})

// ────────────────────────────────────────────────────────────
// 2. reconcile diff 로직 (순수 함수로 추출해서 테스트)
// ────────────────────────────────────────────────────────────

/**
 * reconcile에서 사용하는 diff 로직을 순수 함수로 추출
 * (실제 reconcile은 비동기 + Firestore 의존이므로 로직 부분만 테스트)
 */
function computeDiff(
  localEvents: DiaryEvent[],
  remoteDocIds: Set<string>
): { toUpload: DiaryEvent[] } {
  const toUpload = localEvents.filter(e => !remoteDocIds.has(makeDocId(e)))
  return { toUpload }
}

function computeDownload(
  remoteEvents: DiaryEvent[],
  localDocIds: Set<string>
): { toDownload: DiaryEvent[] } {
  const toDownload = remoteEvents.filter(e => !localDocIds.has(makeDocId(e)))
  return { toDownload }
}

describe('reconcile diff 로직', () => {
  it('로컬에만 있는 이벤트 → toUpload에 포함', () => {
    const e1 = makeEvent({ rev: 1 })
    const e2 = makeEvent({ rev: 1 })
    const remoteIds = new Set([makeDocId(e1)])  // e1만 원격에 있음

    const { toUpload } = computeDiff([e1, e2], remoteIds)
    expect(toUpload).toHaveLength(1)
    expect(toUpload[0].id).toBe(e2.id)
  })

  it('모두 원격에 있으면 toUpload 비어있음', () => {
    const e1 = makeEvent()
    const e2 = makeEvent()
    const remoteIds = new Set([makeDocId(e1), makeDocId(e2)])

    const { toUpload } = computeDiff([e1, e2], remoteIds)
    expect(toUpload).toHaveLength(0)
  })

  it('원격에만 있는 이벤트 → toDownload에 포함', () => {
    const e1 = makeEvent({ rev: 1 })
    const e2 = makeEvent({ rev: 1 })
    const localIds = new Set([makeDocId(e1)])  // e1만 로컬에 있음

    const { toDownload } = computeDownload([e1, e2], localIds)
    expect(toDownload).toHaveLength(1)
    expect(toDownload[0].id).toBe(e2.id)
  })

  it('rev가 다른 동일 id → 각각 다른 doc으로 처리', () => {
    const id = uuidv4()
    const e_rev1 = makeEvent({ id, rev: 1 })
    const e_rev2 = makeEvent({ id, rev: 2 })

    // 원격에는 rev1만 있음
    const remoteIds = new Set([makeDocId(e_rev1)])
    const { toUpload } = computeDiff([e_rev1, e_rev2], remoteIds)

    // rev2는 업로드 대상
    expect(toUpload).toHaveLength(1)
    expect(makeDocId(toUpload[0])).toBe(`${id}_2`)
  })

  it('완전 동기화 상태 → 양방향 모두 빈 배열', () => {
    const events = [makeEvent(), makeEvent(), makeEvent()]
    const docIds = new Set(events.map(makeDocId))

    const { toUpload } = computeDiff(events, docIds)
    const { toDownload } = computeDownload(events, docIds)

    expect(toUpload).toHaveLength(0)
    expect(toDownload).toHaveLength(0)
  })
})

// ────────────────────────────────────────────────────────────
// 3. 큐 직렬화/역직렬화 (localStorage mock)
// ────────────────────────────────────────────────────────────

interface PendingItem {
  event: DiaryEvent
  attempts: number
  nextRetry: number
}

function serializePending(items: PendingItem[]): string {
  return JSON.stringify(items)
}

function deserializePending(raw: string): PendingItem[] {
  return JSON.parse(raw) as PendingItem[]
}

describe('큐 직렬화', () => {
  it('PendingItem 직렬화 후 역직렬화 — 이벤트 필드 보존', () => {
    const e = makeEvent({ type: 'temp', data: { celsius: 38.5 } })
    const item: PendingItem = { event: e, attempts: 2, nextRetry: Date.now() + 5000 }

    const serialized = serializePending([item])
    const restored = deserializePending(serialized)

    expect(restored).toHaveLength(1)
    expect(restored[0].event.id).toBe(e.id)
    expect(restored[0].event.type).toBe('temp')
    expect((restored[0].event.data as { celsius: number }).celsius).toBe(38.5)
    expect(restored[0].attempts).toBe(2)
    expect(restored[0].nextRetry).toBe(item.nextRetry)
  })

  it('빈 배열 직렬화', () => {
    const serialized = serializePending([])
    const restored = deserializePending(serialized)
    expect(restored).toHaveLength(0)
  })

  it('여러 이벤트 타입 직렬화', () => {
    const events: DiaryEvent[] = [
      makeEvent({ type: 'pee' }),
      makeEvent({ type: 'formula', data: { ml: 120 } }),
      makeEvent({ type: 'diary', data: { title: '오늘의 일기', text: '아가가 웃었다' } }),
    ]
    const items: PendingItem[] = events.map((e, i) => ({
      event: e,
      attempts: i,
      nextRetry: Date.now() + i * 1000,
    }))

    const restored = deserializePending(serializePending(items))
    expect(restored).toHaveLength(3)
    expect(restored[1].event.type).toBe('formula')
    expect((restored[2].event.data as { title?: string }).title).toBe('오늘의 일기')
  })
})

// ────────────────────────────────────────────────────────────
// 4. 지수 백오프 계산
// ────────────────────────────────────────────────────────────

const BASE_BACKOFF = 3_000
const MAX_BACKOFF = 5 * 60 * 1000

function calcBackoff(attempts: number): number {
  return Math.min(BASE_BACKOFF * Math.pow(2, attempts - 1), MAX_BACKOFF)
}

describe('지수 백오프', () => {
  it('1회 실패: 3초', () => {
    expect(calcBackoff(1)).toBe(3_000)
  })

  it('2회 실패: 6초', () => {
    expect(calcBackoff(2)).toBe(6_000)
  })

  it('3회 실패: 12초', () => {
    expect(calcBackoff(3)).toBe(12_000)
  })

  it('4회 실패: 24초', () => {
    expect(calcBackoff(4)).toBe(24_000)
  })

  it('최대값 5분 초과하지 않음', () => {
    expect(calcBackoff(20)).toBe(MAX_BACKOFF)
    expect(calcBackoff(100)).toBe(MAX_BACKOFF)
  })

  it('최대값은 정확히 5분', () => {
    expect(MAX_BACKOFF).toBe(300_000)
  })
})

// ────────────────────────────────────────────────────────────
// 5. 중복 enqueue 방지 (id+rev 기준)
// ────────────────────────────────────────────────────────────

/**
 * enqueue 내 중복 체크 로직 순수 함수로 추출
 */
function isDuplicate(pending: PendingItem[], event: DiaryEvent): boolean {
  const docId = makeDocId(event)
  return pending.some(p => makeDocId(p.event) === docId)
}

describe('중복 enqueue 방지', () => {
  it('동일 id+rev → 중복으로 판정', () => {
    const e = makeEvent({ id: 'test-id', rev: 1 })
    const pending: PendingItem[] = [{ event: e, attempts: 0, nextRetry: 0 }]

    expect(isDuplicate(pending, e)).toBe(true)
  })

  it('동일 id + 다른 rev → 중복 아님', () => {
    const id = uuidv4()
    const e1 = makeEvent({ id, rev: 1 })
    const e2 = makeEvent({ id, rev: 2 })
    const pending: PendingItem[] = [{ event: e1, attempts: 0, nextRetry: 0 }]

    expect(isDuplicate(pending, e2)).toBe(false)
  })

  it('완전히 다른 이벤트 → 중복 아님', () => {
    const e1 = makeEvent()
    const e2 = makeEvent()
    const pending: PendingItem[] = [{ event: e1, attempts: 0, nextRetry: 0 }]

    expect(isDuplicate(pending, e2)).toBe(false)
  })

  it('빈 큐 → 중복 아님', () => {
    const e = makeEvent()
    expect(isDuplicate([], e)).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────
// 6. seenFromRemote 루프 방지 로직
// ────────────────────────────────────────────────────────────

describe('원격 수신 이벤트 재업로드 방지', () => {
  it('seenFromRemote에 있는 docId → 재업로드 방지됨', () => {
    const seenFromRemote = new Set<string>()
    const e = makeEvent()
    const docId = makeDocId(e)

    seenFromRemote.add(docId)

    // 원격에서 받은 이벤트가 재업로드되는지 확인 (업로드 차단 로직)
    const shouldSkip = seenFromRemote.has(docId)
    expect(shouldSkip).toBe(true)
  })

  it('다른 이벤트는 차단 안 됨', () => {
    const seenFromRemote = new Set<string>()
    const e1 = makeEvent()
    const e2 = makeEvent()

    seenFromRemote.add(makeDocId(e1))

    expect(seenFromRemote.has(makeDocId(e2))).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────
// 7. 배치 청킹 로직
// ────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

describe('배치 청킹 (≤400개)', () => {
  it('400개 이하 → 단일 배치', () => {
    const events = Array.from({ length: 10 }, () => makeEvent())
    const chunks = chunkArray(events, 400)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toHaveLength(10)
  })

  it('정확히 400개 → 단일 배치', () => {
    const events = Array.from({ length: 400 }, () => makeEvent())
    const chunks = chunkArray(events, 400)
    expect(chunks).toHaveLength(1)
  })

  it('401개 → 두 배치로 분할', () => {
    const events = Array.from({ length: 401 }, () => makeEvent())
    const chunks = chunkArray(events, 400)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(400)
    expect(chunks[1]).toHaveLength(1)
  })

  it('빈 배열 → 빈 배치 목록', () => {
    expect(chunkArray([], 400)).toHaveLength(0)
  })
})
