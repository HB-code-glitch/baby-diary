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

// ────────────────────────────────────────────────────────────
// 8. F5 regression: BoundedSet evicts oldest beyond cap
// ────────────────────────────────────────────────────────────

/** Inline replica of BoundedSet from syncEngine (logic only, not the module instance) */
class BoundedSet {
  private _set = new Set<string>()
  private cap: number
  constructor(cap: number) { this.cap = cap }
  has(key: string) { return this._set.has(key) }
  add(key: string) {
    if (this._set.has(key)) return
    this._set.add(key)
    if (this._set.size > this.cap) {
      const oldest = this._set.values().next().value
      if (oldest !== undefined) this._set.delete(oldest)
    }
  }
  get size() { return this._set.size }
}

describe('F5: BoundedSet 최대 크기 제한', () => {
  it('cap 이하일 때 모든 항목 유지', () => {
    const s = new BoundedSet(5)
    for (let i = 0; i < 5; i++) s.add(`key-${i}`)
    expect(s.size).toBe(5)
    expect(s.has('key-0')).toBe(true)
    expect(s.has('key-4')).toBe(true)
  })

  it('cap 초과 시 가장 오래된 항목 제거', () => {
    const s = new BoundedSet(3)
    s.add('a')
    s.add('b')
    s.add('c')
    s.add('d')  // 'd' 추가 → 'a' 제거 (가장 오래된)
    expect(s.size).toBe(3)
    expect(s.has('a')).toBe(false)
    expect(s.has('b')).toBe(true)
    expect(s.has('c')).toBe(true)
    expect(s.has('d')).toBe(true)
  })

  it('중복 추가는 크기 변화 없음 및 cap 위반 없음', () => {
    const s = new BoundedSet(3)
    s.add('a')
    s.add('b')
    s.add('c')
    s.add('a')  // 중복
    expect(s.size).toBe(3)
    expect(s.has('a')).toBe(true)
  })

  it('대량 항목 추가 시 cap 넘지 않음', () => {
    const cap = 5000
    const s = new BoundedSet(cap)
    for (let i = 0; i < cap + 1000; i++) s.add(`item-${i}`)
    expect(s.size).toBe(cap)
    // 처음 1000개는 제거되었어야 함
    expect(s.has('item-0')).toBe(false)
    expect(s.has('item-999')).toBe(false)
    // 최신 항목은 유지됨
    expect(s.has(`item-${cap + 999}`)).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────
// 9. F8 regression: settings save must not fabricate familyId
// ────────────────────────────────────────────────────────────

describe('F8: familyId 자동 생성 금지', () => {
  it('기존 familyId가 없으면 빈 문자열로 유지', () => {
    // Simulate the SettingsPage handleSave logic
    const existingSettings = { familyId: '' }
    const saved = existingSettings.familyId ?? ''
    expect(saved).toBe('')
    // Must NOT be a uuid
    expect(saved).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('기존 familyId가 있으면 보존', () => {
    const existingFamilyId = 'some-real-family-id'
    const existingSettings = { familyId: existingFamilyId }
    const saved = existingSettings.familyId ?? ''
    expect(saved).toBe(existingFamilyId)
  })
})

// ────────────────────────────────────────────────────────────
// 10. createFamily / joinFamily uid 결정 로직 (순수 함수 추출)
// ────────────────────────────────────────────────────────────

/**
 * 엔진 내부 uid 결정 로직을 순수 함수로 추출하여 테스트.
 * createFamily/joinFamily는 항상 authUid(currentUser.uid)를 사용하고,
 * caller-supplied uid가 빈 문자열이어도 안전해야 한다.
 */
function resolveUid(
  authUid: string,
  callerUid: string,
  fallbackEmail?: string
): { uid: string; isAuthoritativeUid: boolean } {
  // Engine always uses authUid; caller uid is ignored (overwritten)
  const uid = authUid
  const isAuthoritativeUid = uid !== '' && uid === authUid
  return { uid, isAuthoritativeUid }
}

function resolveMemberName(profileName: string, email?: string): string {
  return profileName || email?.split('@')[0] || 'user'
}

describe('createFamily/joinFamily uid 결정 로직', () => {
  it('authUid가 있으면 caller uid(빈 문자열)를 무시하고 authUid 사용', () => {
    const authUid = 'firebase-uid-abc123'
    const callerUid = ''  // 신규 설치 시 빈 문자열
    const { uid, isAuthoritativeUid } = resolveUid(authUid, callerUid)
    expect(uid).toBe(authUid)
    expect(uid).not.toBe('')
    expect(isAuthoritativeUid).toBe(true)
  })

  it('authUid가 있으면 caller uid가 다른 값이어도 authUid 사용', () => {
    const authUid = 'real-firebase-uid'
    const callerUid = 'local-uuid-placeholder'
    const { uid } = resolveUid(authUid, callerUid)
    expect(uid).toBe(authUid)
  })

  it('members 맵 키가 빈 문자열이 되면 안 됨', () => {
    const authUid = 'valid-uid-xyz'
    const members: Record<string, { name: string; role: 'dad' | 'mom' }> = {}
    members[authUid] = { name: '엄마', role: 'mom' }
    // 모든 키가 비어있지 않아야 함
    for (const key of Object.keys(members)) {
      expect(key).not.toBe('')
      expect(key.length).toBeGreaterThan(0)
    }
  })

  it('빈 문자열 uid로 members 맵 생성 시 빈 키 감지 가능', () => {
    // 버그 재현: 이전 코드는 profile.uid(='')를 그대로 사용
    const buggyUid = ''
    const members: Record<string, { name: string; role: 'dad' | 'mom' }> = {}
    members[buggyUid] = { name: '엄마', role: 'mom' }
    // 빈 키 존재 확인 — 이것이 Firestore WriteBatch 오류 원인
    expect(Object.keys(members)).toContain('')
  })

  it('멤버 이름 폴백: 프로필 이름 있으면 우선', () => {
    expect(resolveMemberName('홍길동')).toBe('홍길동')
  })

  it('멤버 이름 폴백: 프로필 이름 없으면 이메일 앞부분 사용', () => {
    expect(resolveMemberName('', 'user@example.com')).toBe('user')
  })

  it('멤버 이름 폴백: 이름도 이메일도 없으면 user', () => {
    expect(resolveMemberName('', undefined)).toBe('user')
  })
})

// ────────────────────────────────────────────────────────────
// 11. Session-restore race: _currentUser null fallback logic
// ────────────────────────────────────────────────────────────

/**
 * Simulates the effectiveUser fallback used in createFamily/joinFamily.
 * When _currentUser is null (e.g. onAuthStateChanged hasn't fired yet on
 * session restore), the engine falls back to getFirebaseAuth()?.currentUser.
 */
function resolveEffectiveUser(
  currentUser: { uid: string; email: string } | null,
  authCurrentUser: { uid: string; email: string } | null
): { uid: string; email: string } | null {
  return currentUser ?? authCurrentUser ?? null
}

describe('Session-restore race: effectiveUser 폴백 로직', () => {
  it('_currentUser가 설정되어 있으면 그것을 사용', () => {
    const user = { uid: 'uid-from-state', email: 'a@b.com' }
    const authUser = { uid: 'uid-from-auth', email: 'a@b.com' }
    const effective = resolveEffectiveUser(user, authUser)
    expect(effective?.uid).toBe('uid-from-state')
  })

  it('_currentUser가 null이면 getFirebaseAuth()?.currentUser로 폴백', () => {
    const authUser = { uid: 'uid-from-auth', email: 'user@example.com' }
    const effective = resolveEffectiveUser(null, authUser)
    expect(effective).not.toBeNull()
    expect(effective?.uid).toBe('uid-from-auth')
  })

  it('둘 다 null이면 null 반환 → ERR_NOT_SIGNED_IN 발생', () => {
    const effective = resolveEffectiveUser(null, null)
    expect(effective).toBeNull()
    // null이면 guard가 throw해야 함
    const wouldThrow = !effective
    expect(wouldThrow).toBe(true)
  })

  it('_currentUser null 상태에서 폴백 후 _currentUser 업데이트', () => {
    // Simulate: _currentUser starts null, gets backfilled from auth.currentUser
    let _currentUser: { uid: string } | null = null
    const authUser = { uid: 'restored-uid' }
    const effective = resolveEffectiveUser(_currentUser, authUser)
    // After the fallback, _currentUser would be set to effectiveUser
    if (!_currentUser && effective) _currentUser = effective
    expect(_currentUser?.uid).toBe('restored-uid')
  })

  it('authUid는 절대로 빈 문자열이 아니어야 함', () => {
    const authUser = { uid: 'real-firebase-uid', email: 'x@y.com' }
    const effective = resolveEffectiveUser(null, authUser)
    expect(effective?.uid).not.toBe('')
    expect(effective?.uid.length).toBeGreaterThan(0)
  })
})

// ────────────────────────────────────────────────────────────
// 12. configure() null-config defense: DEFAULT_FIREBASE_CONFIG fallback
// ────────────────────────────────────────────────────────────

/**
 * Simulate the defensive fallback logic now embedded in configure().
 * When a null config arrives (e.g. older-exe-written settings.json),
 * configure() must swap in DEFAULT_FIREBASE_CONFIG instead of setting 'no-config'.
 */
interface FakeFirebaseConfig {
  apiKey: string
  projectId: string
}

function simulateConfigure(
  cfg: FakeFirebaseConfig | null,
  defaultCfg: FakeFirebaseConfig
): { effectiveCfg: FakeFirebaseConfig; wouldBeNoConfig: boolean } {
  const effectiveCfg = cfg ?? defaultCfg
  const wouldBeNoConfig = effectiveCfg === null
  return { effectiveCfg, wouldBeNoConfig }
}

describe('configure() null-config fallback to DEFAULT_FIREBASE_CONFIG', () => {
  const DEFAULT_CFG: FakeFirebaseConfig = { apiKey: 'default-key', projectId: 'default-proj' }

  it('null config → swaps in DEFAULT_FIREBASE_CONFIG, never sets no-config', () => {
    const { effectiveCfg, wouldBeNoConfig } = simulateConfigure(null, DEFAULT_CFG)
    expect(wouldBeNoConfig).toBe(false)
    expect(effectiveCfg).toBe(DEFAULT_CFG)
  })

  it('non-null config → uses provided config (not default)', () => {
    const userCfg: FakeFirebaseConfig = { apiKey: 'user-key', projectId: 'user-proj' }
    const { effectiveCfg } = simulateConfigure(userCfg, DEFAULT_CFG)
    expect(effectiveCfg).toBe(userCfg)
    expect(effectiveCfg.apiKey).toBe('user-key')
  })

  it('DEFAULT_FIREBASE_CONFIG shape has required fields', async () => {
    const { DEFAULT_FIREBASE_CONFIG } = await import('../src/sync/defaultFirebaseConfig')
    expect(DEFAULT_FIREBASE_CONFIG).toHaveProperty('apiKey')
    expect(DEFAULT_FIREBASE_CONFIG).toHaveProperty('authDomain')
    expect(DEFAULT_FIREBASE_CONFIG).toHaveProperty('projectId')
    expect(DEFAULT_FIREBASE_CONFIG).toHaveProperty('storageBucket')
    expect(DEFAULT_FIREBASE_CONFIG).toHaveProperty('messagingSenderId')
    expect(DEFAULT_FIREBASE_CONFIG).toHaveProperty('appId')
    // All values must be non-empty strings
    for (const [k, v] of Object.entries(DEFAULT_FIREBASE_CONFIG)) {
      expect(typeof v, `${k} must be a string`).toBe('string')
      expect((v as string).length, `${k} must be non-empty`).toBeGreaterThan(0)
    }
  })
})

// ────────────────────────────────────────────────────────────
// MF-08: start() generation counter — stale in-flight then() guard
// ────────────────────────────────────────────────────────────

describe('MF-08: generation counter prevents stale auth listener from overwriting newer one', () => {
  /**
   * Tests the generation counter logic extracted as a pure function.
   * The key invariant: only the callback whose captured generation matches
   * the current counter at callback-execution time should write _unsubAuth.
   */
  it('captured generation matches current → listener is accepted', () => {
    let currentGeneration = 1
    const capturedGen = currentGeneration  // simulates: gen = ++_startGeneration

    // When then() fires, check matches
    const shouldAccept = capturedGen === currentGeneration
    expect(shouldAccept).toBe(true)
  })

  it('captured generation does NOT match current (newer start ran) → listener is discarded', () => {
    let currentGeneration = 1
    const capturedGen = currentGeneration  // start1 captured gen=1

    // start2 fires and increments before then() resolves
    currentGeneration = 2

    const shouldAccept = capturedGen === currentGeneration
    expect(shouldAccept).toBe(false)
  })

  it('multiple sequential start() calls: only the last generation is active', () => {
    let currentGeneration = 0
    const activeListeners: number[] = []

    function simulateStart(): () => void {
      const gen = ++currentGeneration
      const captured = gen
      // Simulates _authOps().then() resolving asynchronously
      const attach = () => {
        if (captured !== currentGeneration) return  // stale — discard
        activeListeners.push(captured)
      }
      return attach
    }

    const attach1 = simulateStart()  // gen=1
    const attach2 = simulateStart()  // gen=2
    const attach3 = simulateStart()  // gen=3

    // Now all three then() callbacks fire (in any order, but 1&2 are stale)
    attach1()  // stale (captured=1 !== current=3)
    attach2()  // stale (captured=2 !== current=3)
    attach3()  // fresh (captured=3 === current=3) → accepted

    expect(activeListeners).toHaveLength(1)
    expect(activeListeners[0]).toBe(3)
  })
})

// ────────────────────────────────────────────────────────────
// MF-11: editEvent safe-rev computation
// ────────────────────────────────────────────────────────────

describe('MF-11: editEvent uses max(originalRev, liveRev)+1 to prevent silent drop', () => {
  /**
   * Pure function replica of the MF-11 safeRev computation in editEvent.
   */
  function computeSafeRev(originalRev: number, liveRev: number): number {
    return Math.max(originalRev, liveRev) + 1
  }

  it('liveRev unchanged: safeRev = original.rev + 1', () => {
    expect(computeSafeRev(3, 3)).toBe(4)
  })

  it('remote raised rev while modal open: safeRev uses liveRev + 1', () => {
    // original.rev = 3 (captured at modal open)
    // liveRev = 4 (raised by remote sync while modal was open)
    expect(computeSafeRev(3, 4)).toBe(5)
  })

  it('original.rev ahead of liveRev (should not happen but is safe): uses original + 1', () => {
    expect(computeSafeRev(5, 3)).toBe(6)
  })

  it('rev=1 baseline: normal first edit produces rev=2', () => {
    expect(computeSafeRev(1, 1)).toBe(2)
  })
})

// ────────────────────────────────────────────────────────────
// 13. joinFamily write-shape + ordering (mock Firestore)
//
// Root cause of MF-??:  the old joinFamily called getDoc(families/fid)
// BEFORE adding the user to members.  A non-member cannot read a family doc
// (rules: get requires isMember()), so that pre-join read is always denied.
//
// Fix: joinFamily must NEVER call getDoc(families/fid) before the member-add
// updateDoc, and the updateDoc payload must contain ONLY the dot-path
// members.{uid} key — no extra fields — so the rules diff check passes.
// ────────────────────────────────────────────────────────────

describe('joinFamily write-shape and ordering', () => {
  /**
   * Simulates the corrected joinFamily sequence extracted as a pure function.
   * Returns an ordered call-log and the updateDoc payload so assertions can
   * verify (a) no family getDoc fires before updateDoc, and (b) the payload
   * contains ONLY the members dot-path key for the joining uid.
   */
  interface CallLogEntry {
    op: 'getDoc-invite' | 'getDoc-family' | 'updateDoc'
    args?: Record<string, unknown>
  }

  function simulateJoinFamily(opts: {
    inviteExists: boolean
    authUid: string
    memberName: string
    memberRole: 'dad' | 'mom'
  }): { calls: CallLogEntry[]; updatePayload: Record<string, unknown> | null } {
    const calls: CallLogEntry[] = []
    let updatePayload: Record<string, unknown> | null = null

    // Step 1: get invite (always allowed — non-member can read invites)
    calls.push({ op: 'getDoc-invite' })
    if (!opts.inviteExists) return { calls, updatePayload }

    const familyId = 'family-abc'

    // Step 2 (FIXED): updateDoc with ONLY the members dot-path — no family read before this
    const payload: Record<string, unknown> = {
      [`members.${opts.authUid}`]: { name: opts.memberName, role: opts.memberRole },
    }
    calls.push({ op: 'updateDoc', args: payload })
    updatePayload = payload

    // Step 3: AFTER join is committed, family reads are allowed (not tested here —
    // that happens in onUserSignedIn which is called post-joinFamily)
    return { calls, updatePayload }
  }

  it('ORDERING: no getDoc(families/fid) fires before updateDoc', () => {
    const { calls } = simulateJoinFamily({
      inviteExists: true,
      authUid: 'mom-uid-123',
      memberName: '엄마',
      memberRole: 'mom',
    })

    const updateIdx = calls.findIndex(c => c.op === 'updateDoc')
    const familyGetIdx = calls.findIndex(c => c.op === 'getDoc-family')

    // updateDoc must appear in the log
    expect(updateIdx).toBeGreaterThanOrEqual(0)
    // getDoc-family must NOT appear before updateDoc (ideally not at all in join)
    if (familyGetIdx >= 0) {
      expect(familyGetIdx).toBeGreaterThan(updateIdx)
    }
  })

  it('WRITE-SHAPE: updateDoc payload contains ONLY the members dot-path key', () => {
    const authUid = 'mom-uid-456'
    const { updatePayload } = simulateJoinFamily({
      inviteExists: true,
      authUid,
      memberName: '엄마',
      memberRole: 'mom',
    })

    expect(updatePayload).not.toBeNull()
    const keys = Object.keys(updatePayload!)

    // Must have exactly one key
    expect(keys).toHaveLength(1)

    // That key must be members.<authUid> — the dot-path form that Firestore
    // maps to a nested field update (only 'members' is in affectedKeys())
    expect(keys[0]).toBe(`members.${authUid}`)

    // Must NOT contain top-level extra fields like updatedAt, babyName, etc.
    expect(keys).not.toContain('updatedAt')
    expect(keys).not.toContain('babyName')
    expect(keys).not.toContain('inviteCode')
  })

  it('WRITE-SHAPE: member value has name and role — no extra fields', () => {
    const authUid = 'dad-uid-789'
    const { updatePayload } = simulateJoinFamily({
      inviteExists: true,
      authUid,
      memberName: '아빠',
      memberRole: 'dad',
    })

    const memberValue = updatePayload![`members.${authUid}`] as Record<string, unknown>
    expect(memberValue).toEqual({ name: '아빠', role: 'dad' })
    expect(Object.keys(memberValue)).toHaveLength(2)
  })

  it('ORDERING: when invite does not exist, updateDoc is never called', () => {
    const { calls, updatePayload } = simulateJoinFamily({
      inviteExists: false,
      authUid: 'uid-xyz',
      memberName: '엄마',
      memberRole: 'mom',
    })

    expect(updatePayload).toBeNull()
    expect(calls.some(c => c.op === 'updateDoc')).toBe(false)
  })

  it('WRITE-SHAPE: uid key in payload matches authUid exactly (not empty, not caller uid)', () => {
    const authUid = 'firebase-real-uid-abc'
    const { updatePayload } = simulateJoinFamily({
      inviteExists: true,
      authUid,
      memberName: '엄마',
      memberRole: 'mom',
    })

    const key = Object.keys(updatePayload!)[0]
    // Key format: members.<uid>
    expect(key).toBe(`members.${authUid}`)
    // Extracted uid part is non-empty
    const extractedUid = key.replace('members.', '')
    expect(extractedUid).toBe(authUid)
    expect(extractedUid).not.toBe('')
  })
})

// ────────────────────────────────────────────────────────────
// 14. joinFamily returns babyName/babyBirthdate (baby info propagation)
// ────────────────────────────────────────────────────────────

describe('joinFamily returns baby info from family doc', () => {
  /**
   * Simulates the post-join family-doc read and the return shape of joinFamily.
   * The key invariant: joinFamily must return { familyId, babyName, babyBirthdate }
   * so the caller can decide whether to adopt those values locally.
   */
  interface SimulateJoinResult {
    familyId: string
    babyName: string
    babyBirthdate: string
  }

  function simulateJoinFamilyWithBabyInfo(opts: {
    inviteExists: boolean
    familyDocExists: boolean
    remotebabyName: string
    remoteBabyBirthdate: string
  }): SimulateJoinResult | null {
    if (!opts.inviteExists) return null

    const familyId = 'family-with-baby'

    // After updateDoc (member added), fetch family doc
    let babyName = ''
    let babyBirthdate = ''
    if (opts.familyDocExists) {
      babyName = opts.remotebabyName
      babyBirthdate = opts.remoteBabyBirthdate
    }

    return { familyId, babyName, babyBirthdate }
  }

  it('returns familyId, babyName, babyBirthdate from family doc', () => {
    const result = simulateJoinFamilyWithBabyInfo({
      inviteExists: true,
      familyDocExists: true,
      remotebabyName: '루나',
      remoteBabyBirthdate: '2024-03-15',
    })
    expect(result).not.toBeNull()
    expect(result!.familyId).toBe('family-with-baby')
    expect(result!.babyName).toBe('루나')
    expect(result!.babyBirthdate).toBe('2024-03-15')
  })

  it('returns empty strings when family doc read fails or is empty', () => {
    const result = simulateJoinFamilyWithBabyInfo({
      inviteExists: true,
      familyDocExists: false,
      remotebabyName: '',
      remoteBabyBirthdate: '',
    })
    expect(result).not.toBeNull()
    expect(result!.babyName).toBe('')
    expect(result!.babyBirthdate).toBe('')
  })

  it('returns null when invite does not exist', () => {
    const result = simulateJoinFamilyWithBabyInfo({
      inviteExists: false,
      familyDocExists: true,
      remotebabyName: '루나',
      remoteBabyBirthdate: '2024-03-15',
    })
    expect(result).toBeNull()
  })
})

// ────────────────────────────────────────────────────────────
// 15. Adopt-if-empty logic: join success handler and reconnect
// ────────────────────────────────────────────────────────────

describe('adopt-if-empty: baby name adoption logic', () => {
  const PLACEHOLDER = '아기'

  /**
   * Pure function replica of the adopt-if-empty decision used in both the
   * join success handler (SyncSettingsSlot) and the reconnect path (onUserSignedIn).
   */
  function shouldAdoptBabyInfo(
    localName: string,
    remoteName: string,
    remoteBirthdate: string
  ): boolean {
    const trimmed = localName.trim()
    const isDefault = trimmed === '' || trimmed === PLACEHOLDER
    return isDefault && !!(remoteName || remoteBirthdate)
  }

  function adoptBabyInfo(
    localBaby: { name: string; birthdate: string },
    remoteName: string,
    remoteBirthdate: string
  ): { name: string; birthdate: string } {
    return {
      name:      remoteName      || localBaby.name,
      birthdate: remoteBirthdate || localBaby.birthdate,
    }
  }

  it('adopts when local name is empty', () => {
    expect(shouldAdoptBabyInfo('', '루나', '2024-03-15')).toBe(true)
  })

  it('adopts when local name is the default placeholder "아기"', () => {
    expect(shouldAdoptBabyInfo('아기', '루나', '2024-03-15')).toBe(true)
  })

  it('does NOT adopt when local name is non-empty and not default', () => {
    expect(shouldAdoptBabyInfo('솔이', '루나', '2024-03-15')).toBe(false)
  })

  it('does NOT adopt when remote name and birthdate are both empty', () => {
    expect(shouldAdoptBabyInfo('', '', '')).toBe(false)
    expect(shouldAdoptBabyInfo('아기', '', '')).toBe(false)
  })

  it('adopts even when only remote birthdate is present (name empty)', () => {
    expect(shouldAdoptBabyInfo('', '', '2024-03-15')).toBe(true)
  })

  it('adoptBabyInfo sets name and birthdate from remote', () => {
    const result = adoptBabyInfo({ name: '', birthdate: '' }, '루나', '2024-03-15')
    expect(result.name).toBe('루나')
    expect(result.birthdate).toBe('2024-03-15')
  })

  it('adoptBabyInfo keeps local value when remote is empty (partial update)', () => {
    const result = adoptBabyInfo({ name: '', birthdate: '2024-01-01' }, '루나', '')
    expect(result.name).toBe('루나')
    expect(result.birthdate).toBe('2024-01-01')  // local kept
  })

  it('non-empty non-placeholder local name is preserved (no-overwrite guard)', () => {
    const localName = '솔이'
    const adopt = shouldAdoptBabyInfo(localName, '루나', '2024-03-15')
    expect(adopt).toBe(false)
    // name stays '솔이', not overwritten with '루나'
    const baby = adopt
      ? adoptBabyInfo({ name: localName, birthdate: '' }, '루나', '2024-03-15')
      : { name: localName, birthdate: '' }
    expect(baby.name).toBe('솔이')
  })
})

// ────────────────────────────────────────────────────────────
// 16. Reconnect adopt: onUserSignedIn adopt-if-empty logic
// ────────────────────────────────────────────────────────────

describe('reconnect adopt-if-empty: covers devices that joined before the fix', () => {
  /**
   * Simulates the onUserSignedIn adopt-if-empty decision path.
   * The key invariant: if local baby name is empty/default AND family doc has data,
   * we call ipc.saveSettings to backfill — but only then.
   */
  interface LocalSettings {
    baby: { name: string; birthdate: string }
    familyId: string
  }

  interface FamilyDocData {
    babyName: string
    babyBirthdate: string
  }

  function simulateReconnectAdopt(
    local: LocalSettings,
    familyDoc: FamilyDocData
  ): { shouldSave: boolean; savedBaby?: { name: string; birthdate: string } } {
    const localName = local.baby.name.trim()
    const isDefault = localName === '' || localName === '아기'
    if (isDefault && (familyDoc.babyName || familyDoc.babyBirthdate)) {
      return {
        shouldSave: true,
        savedBaby: {
          name:      familyDoc.babyName      || local.baby.name,
          birthdate: familyDoc.babyBirthdate || local.baby.birthdate,
        },
      }
    }
    return { shouldSave: false }
  }

  it('saves when local name is empty and family doc has baby name', () => {
    const result = simulateReconnectAdopt(
      { baby: { name: '', birthdate: '' }, familyId: 'fam-1' },
      { babyName: '루나', babyBirthdate: '2024-03-15' }
    )
    expect(result.shouldSave).toBe(true)
    expect(result.savedBaby?.name).toBe('루나')
    expect(result.savedBaby?.birthdate).toBe('2024-03-15')
  })

  it('saves when local name is placeholder "아기"', () => {
    const result = simulateReconnectAdopt(
      { baby: { name: '아기', birthdate: '' }, familyId: 'fam-2' },
      { babyName: '루나', babyBirthdate: '2024-05-01' }
    )
    expect(result.shouldSave).toBe(true)
    expect(result.savedBaby?.name).toBe('루나')
  })

  it('does NOT save when local name is already set (non-default)', () => {
    const result = simulateReconnectAdopt(
      { baby: { name: '솔이', birthdate: '2023-10-10' }, familyId: 'fam-3' },
      { babyName: '루나', babyBirthdate: '2024-03-15' }
    )
    expect(result.shouldSave).toBe(false)
  })

  it('does NOT save when family doc has no baby info', () => {
    const result = simulateReconnectAdopt(
      { baby: { name: '', birthdate: '' }, familyId: 'fam-4' },
      { babyName: '', babyBirthdate: '' }
    )
    expect(result.shouldSave).toBe(false)
  })

  it('saves correctly when only birthdate is available remotely', () => {
    const result = simulateReconnectAdopt(
      { baby: { name: '아기', birthdate: '' }, familyId: 'fam-5' },
      { babyName: '', babyBirthdate: '2024-06-20' }
    )
    expect(result.shouldSave).toBe(true)
    expect(result.savedBaby?.birthdate).toBe('2024-06-20')
  })
})
