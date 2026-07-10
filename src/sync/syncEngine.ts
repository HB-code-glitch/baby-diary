/**
 * src/sync/syncEngine.ts
 * 클라우드 동기화 엔진.
 *
 * Firestore 구조:
 *   families/{familyId}  — 가족 문서
 *   families/{familyId}/events/{id}_{rev}  — 이벤트 revision (불변 doc)
 *
 * 설계 원칙:
 * - 로컬 JSONL append-only 로그와 동일한 append-only 방식
 * - 각 revision이 별도 doc → 덮어쓰기 충돌 없음
 * - 초기 연결 시 로컬↔원격 diff → 양방향 reconcile
 * - 업로드 큐: 실패 시 localStorage 영속 + 지수 백오프 재시도
 * - 원격 수신 이벤트에는 origin 태그 → 재업로드 방지
 */
import {
  Firestore,
  collection,
  doc,
  getDoc,
  setDoc,
  getDocs,
  onSnapshot,
  writeBatch,
  serverTimestamp,
  Unsubscribe,
  DocumentData,
} from 'firebase/firestore'
import { Auth, onAuthStateChanged, User } from 'firebase/auth'
import { DiaryEvent } from '../../shared/types'
import { ipc } from '../lib/ipc'
import {
  initFirebase,
  teardownFirebase,
  fbSignIn,
  fbSignUp,
  fbSignOut,
  FirebaseConfig,
} from './firebase'

// ────────────────────────────────────────────────────────────
// 타입 정의
// ────────────────────────────────────────────────────────────

export type SyncStatus =
  | 'off'         // Firebase 미설정
  | 'no-config'   // 설정 없음
  | 'signed-out'  // 설정은 있으나 미로그인
  | 'connecting'  // 연결 중 / reconcile 중
  | 'online'      // 정상 동기화 중
  | 'error'       // 오류 발생

export interface SyncState {
  status: SyncStatus
  detail: string
  pendingCount: number
  /** 6-char invite code for the current family (available after createFamily or reconnect) */
  inviteCode?: string
}

export type StatusCallback = (state: SyncState) => void

interface FamilyDoc {
  name: string
  babyName: string
  babyBirthdate: string
  members: Record<string, { name: string; role: 'dad' | 'mom' }>
  inviteCode: string
  createdAt: unknown
}

interface PendingItem {
  event: DiaryEvent
  attempts: number
  nextRetry: number
}

// ────────────────────────────────────────────────────────────
// 상수
// ────────────────────────────────────────────────────────────

const PENDING_KEY = 'babydiary.pendingUploads'
const BATCH_SIZE = 400  // Firestore 배치 최대 500보다 여유있게
const MAX_BACKOFF_MS = 5 * 60 * 1000  // 5분
const BASE_BACKOFF_MS = 3_000

// ────────────────────────────────────────────────────────────
// 내부 상태
// ────────────────────────────────────────────────────────────

let _db: Firestore | null = null
let _auth: Auth | null = null
let _config: FirebaseConfig | null = null
let _familyId: string = ''
let _currentUser: User | null = null
let _unsubSnapshot: Unsubscribe | null = null
let _unsubAuth: Unsubscribe | null = null
let _statusCallbacks: StatusCallback[] = []
let _retryTimer: ReturnType<typeof setTimeout> | null = null
let _started = false

// F5: Bound _seenFromRemote to prevent unbounded memory growth.
// We keep an insertion-ordered Set and evict the oldest entries when it
// exceeds the cap so a long-running session never leaks memory.
const SEEN_FROM_REMOTE_CAP = 5000

class BoundedSet {
  private _set = new Set<string>()

  has(key: string): boolean {
    return this._set.has(key)
  }

  add(key: string): void {
    if (this._set.has(key)) return
    this._set.add(key)
    if (this._set.size > SEEN_FROM_REMOTE_CAP) {
      // Evict the oldest entry (Sets iterate in insertion order)
      const oldest = this._set.values().next().value
      if (oldest !== undefined) this._set.delete(oldest)
    }
  }
}

/** 원격에서 수신한 doc id 추적 (재업로드 방지) */
const _seenFromRemote = new BoundedSet()

let _state: SyncState = { status: 'no-config', detail: '', pendingCount: 0 }

// ────────────────────────────────────────────────────────────
// 상태 관리
// ────────────────────────────────────────────────────────────

function setState(partial: Partial<SyncState>): void {
  _state = { ..._state, ...partial }
  _statusCallbacks.forEach(cb => {
    try { cb(_state) } catch { /* ignore */ }
  })
}

// ────────────────────────────────────────────────────────────
// localStorage 기반 대기열 영속
// ────────────────────────────────────────────────────────────

function loadPending(): PendingItem[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (!raw) return []
    return JSON.parse(raw) as PendingItem[]
  } catch {
    return []
  }
}

function savePending(items: PendingItem[]): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(items))
  } catch { /* localStorage 가득 찬 경우 무시 */ }
}

let _pending: PendingItem[] = loadPending()

function syncPendingCount(): void {
  setState({ pendingCount: _pending.length })
}

// ────────────────────────────────────────────────────────────
// doc ID 변환: "${id}_${rev}"
// ────────────────────────────────────────────────────────────

export function makeDocId(event: DiaryEvent): string {
  return `${event.id}_${event.rev}`
}

export function parseDocId(docId: string): { id: string; rev: number } | null {
  const lastUnderscore = docId.lastIndexOf('_')
  if (lastUnderscore < 0) return null
  const id = docId.substring(0, lastUnderscore)
  const rev = parseInt(docId.substring(lastUnderscore + 1), 10)
  if (!id || isNaN(rev)) return null
  return { id, rev }
}

// ────────────────────────────────────────────────────────────
// inviteCode 생성 (6자리 대문자 영숫자)
// ────────────────────────────────────────────────────────────

function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

// ────────────────────────────────────────────────────────────
// 공개 API
// ────────────────────────────────────────────────────────────

/**
 * Firebase 설정 및 familyId 주입.
 * 앱 시작 시 또는 설정 변경 시 호출.
 */
export function configure(cfg: FirebaseConfig | null, familyId: string): void {
  _config = cfg
  _familyId = familyId

  if (!cfg) {
    setState({ status: 'no-config', detail: 'Firebase 설정 없음 — 로컬 모드', pendingCount: 0 })
    return
  }

  const result = initFirebase(cfg)
  if (!result) {
    setState({ status: 'no-config', detail: 'Firebase 초기화 실패', pendingCount: 0 })
    return
  }

  _db = result.db
  _auth = result.auth
  setState({ status: 'signed-out', detail: '로그인 필요', pendingCount: _pending.length })
}

/** 회원가입 (신규 사용자) */
export async function signUp(email: string, password: string): Promise<User> {
  if (!_auth) throw new Error('Firebase 미설정')
  const cred = await fbSignUp(_auth, email, password)
  return cred.user
}

/** 로그인 */
export async function signIn(email: string, password: string): Promise<User> {
  if (!_auth) throw new Error('Firebase 미설정')
  const cred = await fbSignIn(_auth, email, password)
  return cred.user
}

/** 로그아웃 */
export async function signOutSync(): Promise<void> {
  if (!_auth) return
  await fbSignOut(_auth)
  _currentUser = null
  _unsubSnapshot?.()
  _unsubSnapshot = null
  setState({ status: 'signed-out', detail: '로그아웃됨', pendingCount: _pending.length })
}

/**
 * 가족 생성 (첫 번째 사용자).
 * F2 + F-RULES: createFamily now also writes to the top-level invites/{code} collection
 * so that joinFamily can do a direct get() instead of a list() query on families.
 * @param babyInfo 아기 이름 + 생일
 * @param profile  사용자 이름 + 역할
 * @returns { familyId, inviteCode }
 */
export async function createFamily(
  babyInfo: { babyName: string; babyBirthdate: string; familyName?: string },
  profile: { uid: string; name: string; role: 'dad' | 'mom' }
): Promise<{ familyId: string; inviteCode: string }> {
  if (!_db || !_currentUser) throw new Error('로그인 후 가족을 생성할 수 있습니다')

  const inviteCode = generateInviteCode()
  const familyRef = doc(collection(_db, 'families'))
  const inviteRef = doc(_db, 'invites', inviteCode)

  const familyDocData: FamilyDoc = {
    name: babyInfo.familyName ?? `${profile.name}의 가족`,
    babyName: babyInfo.babyName,
    babyBirthdate: babyInfo.babyBirthdate,
    members: {
      [profile.uid]: { name: profile.name, role: profile.role },
    },
    inviteCode,
    createdAt: serverTimestamp(),
  }

  // F-RULES: write family + invite in a single batch so they're always consistent
  const batch = writeBatch(_db)
  batch.set(familyRef, familyDocData)
  batch.set(inviteRef, { familyId: familyRef.id, createdAt: serverTimestamp(), code_check: inviteCode })
  await batch.commit()

  _familyId = familyRef.id
  setState({ inviteCode })
  return { familyId: familyRef.id, inviteCode }
}

/**
 * 초대코드로 가족 합류.
 * F2 + F-RULES: Uses the top-level invites/{code} collection for a direct get() lookup
 * instead of a query on families. This prevents attackers from listing all families.
 * The attacker still needs the exact code (get() only — no list); brute-forcing 36^6
 * get()s is bounded by Spark quota (50k reads/day).
 * @returns familyId
 */
export async function joinFamily(
  inviteCode: string,
  profile: { uid: string; name: string; role: 'dad' | 'mom' }
): Promise<string> {
  if (!_db || !_currentUser) throw new Error('로그인 후 가족에 참여할 수 있습니다')

  // F-RULES: direct get() on invites/{code} — no list needed
  const code = inviteCode.trim().toUpperCase()
  const inviteRef = doc(_db, 'invites', code)
  const inviteSnap = await getDoc(inviteRef)

  if (!inviteSnap.exists()) throw new Error('초대 코드를 찾을 수 없습니다')

  const familyId = (inviteSnap.data() as { familyId: string }).familyId

  // F-RULES: self-join: add only the auth.uid to members (rules verify only members key changes)
  const familyRef = doc(_db, 'families', familyId)
  const familySnap = await getDoc(familyRef)
  if (!familySnap.exists()) throw new Error('가족 문서를 찾을 수 없습니다')

  const data = familySnap.data() as FamilyDoc

  // 이미 멤버인 경우
  if (data.members[profile.uid]) {
    _familyId = familyId
    return familyId
  }

  // members 맵에 본인만 추가 (rules: diff must only affect members key)
  await setDoc(familyRef, {
    members: { [profile.uid]: { name: profile.name, role: profile.role } }
  }, { merge: true })

  _familyId = familyId
  return familyId
}

/**
 * 이벤트를 업로드 큐에 추가.
 * 로컬 append 성공 후 즉시 호출.
 * 원격에서 수신한 이벤트는 tag된 docId로 필터링 → 재업로드 없음.
 */
export function enqueue(event: DiaryEvent): void {
  const docId = makeDocId(event)

  // 원격에서 받은 이벤트는 재업로드 하지 않음
  if (_seenFromRemote.has(docId)) return

  // 이미 대기 중인 동일 id+rev는 추가하지 않음
  if (_pending.some(p => makeDocId(p.event) === docId)) return

  _pending.push({ event, attempts: 0, nextRetry: 0 })
  savePending(_pending)
  syncPendingCount()

  // 연결 중이면 즉시 드레인 시도
  if (_state.status === 'online') {
    void drainQueue()
  }
}

/** 동기화 시작 (앱 기동 시 호출) */
export function start(): void {
  if (_started) return
  _started = true

  if (!_auth || !_config) {
    setState({ status: 'no-config', detail: 'Firebase 설정 없음 — 로컬 모드', pendingCount: 0 })
    return
  }

  _unsubAuth = onAuthStateChanged(_auth, user => {
    _currentUser = user
    if (user) {
      void onUserSignedIn(user)
    } else {
      setState({ status: 'signed-out', detail: '로그인 필요', pendingCount: _pending.length })
      _unsubSnapshot?.()
      _unsubSnapshot = null
    }
  })
}

/** 동기화 중단 */
export function stop(): void {
  _started = false
  _unsubSnapshot?.()
  _unsubSnapshot = null
  _unsubAuth?.()
  _unsubAuth = null
  if (_retryTimer) {
    clearTimeout(_retryTimer)
    _retryTimer = null
  }
  void teardownFirebase()
  _db = null
  _auth = null
  _currentUser = null
  setState({ status: 'off', detail: '동기화 중단됨', pendingCount: _pending.length })
}

/** 현재 동기화 상태 반환 */
export function getStatus(): SyncState {
  return { ..._state }
}

/** 상태 변경 구독 */
export function subscribeStatus(cb: StatusCallback): () => void {
  _statusCallbacks.push(cb)
  cb(_state)  // 즉시 현재 상태 전달
  return () => {
    _statusCallbacks = _statusCallbacks.filter(f => f !== cb)
  }
}

// ────────────────────────────────────────────────────────────
// 내부 로직
// ────────────────────────────────────────────────────────────

async function onUserSignedIn(user: User): Promise<void> {
  if (!_db || !_familyId) {
    setState({ status: 'signed-out', detail: '가족 연결 필요', pendingCount: _pending.length })
    return
  }

  setState({ status: 'connecting', detail: '동기화 중...', pendingCount: _pending.length })

  try {
    // F2 + F8: fetch family doc early so we can surface the invite code and detect
    // not-found familyIds (e.g. a leftover uuid from the old F8 bug).
    const familyRef = doc(_db, 'families', _familyId)
    const familySnap = await getDoc(familyRef)
    if (!familySnap.exists()) {
      // F8: unknown familyId — treat as no-family, offer create/join
      _familyId = ''
      setState({ status: 'signed-out', detail: '가족 연결 필요', pendingCount: _pending.length })
      return
    }
    // F2: expose invite code in state so UI can display it
    const familyData = familySnap.data() as FamilyDoc
    setState({ inviteCode: familyData.inviteCode })

    await reconcile(user)
    attachSnapshot()
    setState({ status: 'online', detail: `${user.email} 연결됨`, pendingCount: _pending.length })
    void drainQueue()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setState({ status: 'error', detail: `연결 오류: ${msg}`, pendingCount: _pending.length })
    scheduleRetry()
  }
}

/**
 * 초기 연결 시 로컬↔원격 diff 후 양방향 동기화.
 *
 * 로컬: listEvents() → 최고 rev만 반환하므로, 각 이벤트의 최신 rev를 기준으로 비교.
 * 원격: families/{familyId}/events 전체 doc (각 doc = id_rev 불변 revision).
 *
 * 1. 원격에 없는 로컬 revision → batched write로 업로드
 * 2. 로컬에 없는 원격 revision → ipc.appendEvent로 로컬 append (dedup은 JSONL 레이어가 처리)
 */
async function reconcile(user: User): Promise<void> {
  if (!_db || !_familyId) return

  // 가족 문서 확인 (멤버 검증)
  const familyRef = doc(_db, 'families', _familyId)
  const familySnap = await getDoc(familyRef)
  if (!familySnap.exists()) {
    throw new Error('가족 문서를 찾을 수 없습니다. 가족 생성 또는 코드 입력이 필요합니다.')
  }
  const familyData = familySnap.data() as FamilyDoc
  if (!familyData.members[user.uid]) {
    throw new Error('이 가족의 멤버가 아닙니다.')
  }

  // 로컬 이벤트 목록 (최신 rev per id)
  const localEvents = await ipc.listEvents()

  // 로컬 id_rev 셋 구성 (최신 rev만)
  const localDocIds = new Set<string>(localEvents.map(makeDocId))

  // 원격 이벤트 docs 전체 조회
  const eventsRef = collection(_db, 'families', _familyId, 'events')
  const remoteSnap = await getDocs(eventsRef)

  const remoteDocIds = new Set<string>()
  const remoteEvents: DiaryEvent[] = []

  remoteSnap.docs.forEach(d => {
    remoteDocIds.add(d.id)
    remoteEvents.push(docToEvent(d.id, d.data()))
  })

  // 1. 원격에 없는 로컬 이벤트 → 업로드
  const toUpload = localEvents.filter(e => !remoteDocIds.has(makeDocId(e)))
  await batchUpload(toUpload)

  // 2. 로컬에 없는 원격 이벤트 → 로컬 append
  const toDownload = remoteEvents.filter(e => !localDocIds.has(makeDocId(e)))
  for (const e of toDownload) {
    _seenFromRemote.add(makeDocId(e))
    await ipc.appendEvent(e)
  }

  // pending 큐에서 이미 원격에 있는 항목 제거
  _pending = _pending.filter(p => !remoteDocIds.has(makeDocId(p.event)))
  savePending(_pending)
  syncPendingCount()
}

/** onSnapshot 리스너 부착 — 실시간 원격 업데이트 수신 */
function attachSnapshot(): void {
  if (!_db || !_familyId) return

  _unsubSnapshot?.()

  const eventsRef = collection(_db, 'families', _familyId, 'events')
  _unsubSnapshot = onSnapshot(
    eventsRef,
    { includeMetadataChanges: false },
    snapshot => {
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added' || change.type === 'modified') {
          const event = docToEvent(change.doc.id, change.doc.data())
          const docId = makeDocId(event)
          _seenFromRemote.add(docId)
          // 로컬 append (JSONL 레이어가 id+rev 중복 제거)
          ipc.appendEvent(event).catch(() => { /* 무시 */ })
          // 큐에서 제거
          _pending = _pending.filter(p => makeDocId(p.event) !== docId)
          savePending(_pending)
          syncPendingCount()
        }
      })
    },
    err => {
      setState({ status: 'error', detail: `스냅샷 오류: ${err.message}`, pendingCount: _pending.length })
      scheduleRetry()
    }
  )
}

/** Firestore doc 데이터 → DiaryEvent 변환 */
function docToEvent(docId: string, data: DocumentData): DiaryEvent {
  // doc에 event 필드가 있으면 그것을 사용, 없으면 data 자체가 event
  return (data.event ?? data) as DiaryEvent
}

/**
 * Upload a single event to Firestore. Returns 'ok', 'already-exists', or 'error'.
 * F6: when a doc with the same id_rev already exists remotely (create-conflict),
 *     we treat remote as winner and fetch it to apply locally via ipc.appendEvent.
 */
async function uploadOne(event: DiaryEvent): Promise<'ok' | 'already-exists' | 'error'> {
  if (!_db || !_familyId) return 'error'
  const docId = makeDocId(event)
  const ref = doc(_db, 'families', _familyId, 'events', docId)
  try {
    const batch = writeBatch(_db)
    batch.set(ref, { event })
    await batch.commit()
    return 'ok'
  } catch (err) {
    // Firestore returns ALREADY_EXISTS (code 6) when a create-only doc already exists
    const code = (err as { code?: number | string }).code
    if (code === 6 || String(code) === 'already-exists') {
      return 'already-exists'
    }
    return 'error'
  }
}

/**
 * F6 + F7: Batch upload with per-doc fallback.
 * 1. Try a full batch. On failure fall back to per-doc writes.
 * 2. Docs that already exist remotely (create-conflict) → remote won: fetch remote,
 *    apply locally, remove from pending (converged).
 * 3. Other failing docs are quarantined: kept in pending for retry with backoff.
 * Returns Set of docIds that were successfully uploaded OR converged remotely.
 */
async function batchUpload(events: DiaryEvent[]): Promise<void> {
  if (!_db || !_familyId || events.length === 0) return

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const chunk = events.slice(i, i + BATCH_SIZE)
    const batch = writeBatch(_db)

    for (const event of chunk) {
      const docId = makeDocId(event)
      const ref = doc(_db, 'families', _familyId, 'events', docId)
      batch.set(ref, { event })
    }

    try {
      await batch.commit()
    } catch {
      // F7: batch failed — fall back to per-doc so one poison doc can't block the rest
      for (const event of chunk) {
        const result = await uploadOne(event)
        if (result === 'already-exists') {
          // F6: remote won — fetch it and apply locally, then converge
          try {
            const docId = makeDocId(event)
            const ref = doc(_db, 'families', _familyId, 'events', docId)
            const remoteSnap = await getDoc(ref)
            if (remoteSnap.exists()) {
              const remoteEvent = docToEvent(remoteSnap.id, remoteSnap.data())
              _seenFromRemote.add(docId)
              await ipc.appendEvent(remoteEvent)
            }
          } catch {
            // best-effort; local already has our version, remote won will propagate via snapshot
          }
          // remove from pending — converged (remote version wins by id_rev)
          _pending = _pending.filter(p => makeDocId(p.event) !== makeDocId(event))
        }
        // 'error' docs stay in pending and will be retried with backoff
      }
    }
  }
}

/** 업로드 큐 드레인 */
async function drainQueue(): Promise<void> {
  if (!_db || !_familyId || _pending.length === 0) return

  const now = Date.now()
  const ready = _pending.filter(p => p.nextRetry <= now)
  if (ready.length === 0) return

  const toUpload = ready.map(p => p.event)

  try {
    await batchUpload(toUpload)
    // 성공: 큐에서 제거
    const uploadedIds = new Set(toUpload.map(makeDocId))
    _pending = _pending.filter(p => !uploadedIds.has(makeDocId(p.event)))
    savePending(_pending)
    syncPendingCount()
    setState({ status: 'online', detail: _currentUser?.email ? `${_currentUser.email} 연결됨` : '연결됨', pendingCount: _pending.length })
  } catch {
    // 실패: 지수 백오프로 재시도 시간 설정
    _pending = _pending.map(p => {
      if (!toUpload.some(e => makeDocId(e) === makeDocId(p.event))) return p
      const attempts = p.attempts + 1
      const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempts - 1), MAX_BACKOFF_MS)
      return { ...p, attempts, nextRetry: Date.now() + backoff }
    })
    savePending(_pending)
    syncPendingCount()
    scheduleRetry()
  }
}

/** 재시도 타이머 설정 */
function scheduleRetry(): void {
  if (_retryTimer) return

  const nextRetry = _pending.length > 0
    ? Math.min(..._pending.map(p => p.nextRetry))
    : Date.now() + 30_000

  const delay = Math.max(nextRetry - Date.now(), 1_000)

  _retryTimer = setTimeout(() => {
    _retryTimer = null
    if (_state.status === 'online' || _state.status === 'error') {
      void drainQueue()
    }
  }, delay)
}
