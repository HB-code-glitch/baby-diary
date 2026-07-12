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
// PERF: Type-only imports — no runtime firebase code pulled into main bundle
import type {
  Firestore,
  Unsubscribe,
  DocumentData,
} from 'firebase/firestore'
import type { Auth, User } from 'firebase/auth'
import { DiaryEvent } from '../../shared/types'
import { ipc } from '../lib/ipc'
import {
  initFirebase,
  teardownFirebase,
  fbSignIn,
  fbSignUp,
  fbSignOut,
  getFirebaseAuth,
  FirebaseConfig,
} from './firebase'

// ────────────────────────────────────────────────────────────
// Lazy-loaded firebase/firestore helpers.
// Populated on first call to _firestoreOps() which runs only after
// initFirebase() has already fetched the firebase chunk.
// ────────────────────────────────────────────────────────────

type FirestoreOps = {
  collection: typeof import('firebase/firestore').collection
  doc: typeof import('firebase/firestore').doc
  getDoc: typeof import('firebase/firestore').getDoc
  setDoc: typeof import('firebase/firestore').setDoc
  updateDoc: typeof import('firebase/firestore').updateDoc
  getDocs: typeof import('firebase/firestore').getDocs
  onSnapshot: typeof import('firebase/firestore').onSnapshot
  writeBatch: typeof import('firebase/firestore').writeBatch
  serverTimestamp: typeof import('firebase/firestore').serverTimestamp
}

type AuthOps = {
  onAuthStateChanged: typeof import('firebase/auth').onAuthStateChanged
}

let _firestoreOpsCache: FirestoreOps | null = null
let _authOpsCache: AuthOps | null = null

async function _firestoreOps(): Promise<FirestoreOps> {
  if (!_firestoreOpsCache) {
    const m = await import('firebase/firestore')
    _firestoreOpsCache = {
      collection: m.collection,
      doc: m.doc,
      getDoc: m.getDoc,
      setDoc: m.setDoc,
      updateDoc: m.updateDoc,
      getDocs: m.getDocs,
      onSnapshot: m.onSnapshot,
      writeBatch: m.writeBatch,
      serverTimestamp: m.serverTimestamp,
    }
  }
  return _firestoreOpsCache
}

async function _authOps(): Promise<AuthOps> {
  if (!_authOpsCache) {
    const m = await import('firebase/auth')
    _authOpsCache = { onAuthStateChanged: m.onAuthStateChanged }
  }
  return _authOpsCache
}

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

/** Sentinel detail string emitted when signed-in but no family linked.
 *  SyncSettingsSlot checks this constant (not Korean text) to branch UI. */
export const DETAIL_FAMILY_NEEDED = 'FAMILY_NEEDED'

/** Thrown when the families/{familyId} doc is missing during joinFamily. */
export const DETAIL_FAMILY_NOT_FOUND = 'FAMILY_NOT_FOUND'

/** Thrown when createFamily/joinFamily is called while not signed in. */
export const ERR_NOT_SIGNED_IN = 'NOT_SIGNED_IN'

/** Firestore error code emitted when the security rules reject a request. */
export const ERR_PERMISSION_DENIED = 'permission-denied'

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

/**
 * Buffer for onAuthStateChanged events that arrive before configure() completes.
 * When start() fires onAuthStateChanged before the configure() promise resolves
 * (possible in session-restore fast-path), the user object is stored here and
 * replayed immediately after configure() sets up _auth/_db.
 */
let _pendingAuthUser: User | null | undefined = undefined  // undefined = not yet fired

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

/** MF-08: monotonically increasing counter; each start() call increments this.
 * The then()-callback captures the generation at call time and only writes
 * _unsubAuth if the current generation still matches — preventing a stale
 * in-flight then() from overwriting a newer auth listener. */
let _startGeneration = 0

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
    const parsed = JSON.parse(raw)
    // P8: validate shape — drop items that don't have the required structure
    if (!Array.isArray(parsed)) {
      console.error('[syncEngine] loadPending: expected array, got', typeof parsed, '— discarding')
      return []
    }
    const valid: PendingItem[] = []
    for (const item of parsed) {
      if (
        item &&
        typeof item === 'object' &&
        item.event &&
        typeof item.attempts === 'number' &&
        typeof item.nextRetry === 'number'
      ) {
        valid.push(item as PendingItem)
      } else {
        console.warn('[syncEngine] loadPending: dropping malformed item', item)
      }
    }
    return valid
  } catch (err) {
    console.error('[syncEngine] loadPending: parse error — discarding pending queue', err)
    return []
  }
}

function savePending(items: PendingItem[]): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(items))
  } catch (err) {
    // P8: log quota/serialization failures so operators can observe and diagnose.
    // In-memory _pending is still intact; reconcile rescues on restart via ipc.listEvents().
    console.error('[syncEngine] savePending failed — pending may be lost on restart:', err)
  }
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
 * initFirebase is now async (dynamic import), so configure returns a Promise.
 * Callers (useSyncLifecycle) already await ipc.getSettings() before calling
 * configure, so the async change is safe.
 *
 * Defense: if cfg is null/absent (e.g. older-exe-written settings with firebase:null),
 * import and use DEFAULT_FIREBASE_CONFIG so status never stalls at 'no-config'.
 * This mirrors the fallback already present in useSyncLifecycle but makes the engine
 * self-healing even when called directly with a null config.
 */
export async function configure(cfg: FirebaseConfig | null, familyId: string): Promise<void> {
  // Defensive fallback: a null config must never leave the engine at 'no-config'.
  // Dynamically import DEFAULT_FIREBASE_CONFIG to avoid a circular-module issue
  // (syncEngine ← useSync ← defaultFirebaseConfig is fine; direct import also OK here).
  let effectiveCfg = cfg
  if (!effectiveCfg) {
    try {
      const { DEFAULT_FIREBASE_CONFIG } = await import('./defaultFirebaseConfig')
      effectiveCfg = DEFAULT_FIREBASE_CONFIG
      console.warn('[syncEngine] configure: null config — falling back to DEFAULT_FIREBASE_CONFIG')
    } catch {
      // If the dynamic import somehow fails, fall through to old no-config path
    }
  }

  _config = effectiveCfg
  _familyId = familyId

  if (!effectiveCfg) {
    setState({ status: 'no-config', detail: 'no firebase config', pendingCount: 0 })
    return
  }

  const result = await initFirebase(effectiveCfg)
  if (!result) {
    setState({ status: 'no-config', detail: 'firebase init failed', pendingCount: 0 })
    return
  }

  _db = result.db
  _auth = result.auth
  setState({ status: 'signed-out', detail: 'not signed in', pendingCount: _pending.length })

  // Replay any onAuthStateChanged event that arrived before configure() completed.
  // _pendingAuthUser is set by start() when the auth callback fires before _auth is ready.
  if (_pendingAuthUser !== undefined) {
    const bufferedUser = _pendingAuthUser
    _pendingAuthUser = undefined
    _currentUser = bufferedUser
    if (bufferedUser) {
      void onUserSignedIn(bufferedUser)
    }
    // If bufferedUser is null: status is already 'signed-out' from above — no action needed.
  }
}

/** 회원가입 (신규 사용자) */
export async function signUp(email: string, password: string): Promise<User> {
  if (!_auth) throw new Error('Firebase not configured')
  const cred = await fbSignUp(_auth, email, password)
  return cred.user
}

/** 로그인 */
export async function signIn(email: string, password: string): Promise<User> {
  if (!_auth) throw new Error('Firebase not configured')
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
  setState({ status: 'signed-out', detail: 'signed out', pendingCount: _pending.length })
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
  // Fallback: if _currentUser was not yet set by onAuthStateChanged (e.g. race on
  // session restore before the callback fires), grab it directly from the Auth instance.
  const effectiveUser = _currentUser ?? getFirebaseAuth()?.currentUser ?? null
  if (!_db || !effectiveUser) throw new Error(ERR_NOT_SIGNED_IN)
  // Keep _currentUser in sync so subsequent calls don't hit the same race.
  if (!_currentUser) _currentUser = effectiveUser

  // Always use the authenticated user's uid, never the (possibly empty) caller-supplied uid.
  const authUid = effectiveUser.uid
  const memberName = profile.name || effectiveUser.email?.split('@')[0] || 'user'
  const memberRole = profile.role ?? 'mom'

  const inviteCode = generateInviteCode()
  const { doc, collection, writeBatch, serverTimestamp } = await _firestoreOps()
  const familyRef = doc(collection(_db, 'families'))
  const inviteRef = doc(_db, 'invites', inviteCode)

  const familyDocData: FamilyDoc = {
    name: babyInfo.familyName ?? `${memberName}'s family`,
    babyName: babyInfo.babyName,
    babyBirthdate: babyInfo.babyBirthdate,
    members: {
      [authUid]: { name: memberName, role: memberRole },
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
  // P6: auth state hasn't changed so onAuthStateChanged won't re-fire;
  // manually kick reconcile/snapshot so pending events drain without a restart.
  if (_currentUser) void onUserSignedIn(_currentUser)
  return { familyId: familyRef.id, inviteCode }
}

/**
 * 초대코드로 가족 합류.
 * F2 + F-RULES: Uses the top-level invites/{code} collection for a direct get() lookup
 * instead of a query on families. This prevents attackers from listing all families.
 * The attacker still needs the exact code (get() only — no list); brute-forcing 36^6
 * get()s is bounded by Spark quota (50k reads/day).
 * @returns { familyId, babyName, babyBirthdate } — caller uses babyName/babyBirthdate
 *   to populate local settings when the device has no baby name yet.
 */
export async function joinFamily(
  inviteCode: string,
  profile: { uid: string; name: string; role: 'dad' | 'mom' }
): Promise<{ familyId: string; babyName: string; babyBirthdate: string }> {
  // Fallback: if _currentUser was not yet set by onAuthStateChanged (e.g. race on
  // session restore before the callback fires), grab it directly from the Auth instance.
  const effectiveUser = _currentUser ?? getFirebaseAuth()?.currentUser ?? null
  if (!_db || !effectiveUser) throw new Error(ERR_NOT_SIGNED_IN)
  // Keep _currentUser in sync so subsequent calls don't hit the same race.
  if (!_currentUser) _currentUser = effectiveUser

  // Always use the authenticated user's uid, never the (possibly empty) caller-supplied uid.
  const authUid = effectiveUser.uid
  const memberName = profile.name || effectiveUser.email?.split('@')[0] || 'user'
  const memberRole = profile.role ?? 'mom'

  // F-RULES: direct get() on invites/{code} — no list needed
  const { doc, getDoc, updateDoc } = await _firestoreOps()
  const code = inviteCode.trim().toUpperCase()
  const inviteRef = doc(_db, 'invites', code)
  const inviteSnap = await getDoc(inviteRef)

  if (!inviteSnap.exists()) throw new Error('invite code not found')

  const familyId = (inviteSnap.data() as { familyId: string }).familyId

  // F-RULES: self-join — write ONLY the members.{uid} field-path.
  // Do NOT read families/{familyId} before this write: a non-member cannot
  // getDoc a family doc (rules: get requires isMember()), so any pre-join
  // read results in permission-denied.  The rules allow an unauthenticated-
  // member update as long as:
  //   (a) only the 'members' top-level key is in diff.affectedKeys()
  //   (b) auth.uid is added (not existing members removed)
  // updateDoc with a dotted field-path satisfies (a) cleanly.
  const familyRef = doc(_db, 'families', familyId)
  await updateDoc(familyRef, {
    [`members.${authUid}`]: { name: memberName, role: memberRole },
  })

  // AFTER updateDoc the user is now a member — fetch baby info from family doc.
  // This read is now permitted because isMember() is satisfied.
  let babyName = ''
  let babyBirthdate = ''
  try {
    const familySnap = await getDoc(familyRef)
    if (familySnap.exists()) {
      const fd = familySnap.data() as FamilyDoc
      babyName = fd.babyName ?? ''
      babyBirthdate = fd.babyBirthdate ?? ''
    }
  } catch {
    // best-effort: if the read fails, caller keeps existing local baby info
  }

  _familyId = familyId
  // P6: auth state hasn't changed so onAuthStateChanged won't re-fire;
  // manually kick reconcile/snapshot so pending events drain without a restart.
  if (_currentUser) void onUserSignedIn(_currentUser)
  return { familyId, babyName, babyBirthdate }
}

/**
 * Update the family doc's babyName and babyBirthdate fields.
 * Called from SettingsPage when the user saves changed baby info while a member.
 * Guard: only call when the user is a member (familyId set) and values actually changed.
 * Rules: isMember() update with non-members fields is allowed.
 */
export async function updateFamilyBabyInfo(babyName: string, babyBirthdate: string): Promise<void> {
  if (!_db || !_familyId || !_currentUser) return
  const { doc, updateDoc } = await _firestoreOps()
  const familyRef = doc(_db, 'families', _familyId)
  await updateDoc(familyRef, { babyName, babyBirthdate })
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
    // configure() was called but may still be resolving (async initFirebase).
    // Set up the onAuthStateChanged listener anyway using a safe wrapper:
    // if _auth is still null when the callback fires, buffer the user so configure()
    // can replay it once initFirebase() completes.
    setState({ status: 'no-config', detail: 'waiting for firebase init', pendingCount: 0 })
    // Listener will be attached after configure() completes via the _pendingAuthUser replay.
    // Nothing more to do here — configure() will call onUserSignedIn if needed.
    return
  }

  // MF-08: capture generation before the async gap so a stale then() from a
  // previous start() call cannot overwrite the newer auth listener.
  const gen = ++_startGeneration
  // onAuthStateChanged is loaded dynamically — firebase chunk already in cache
  // at this point because configure() awaited initFirebase() first.
  void _authOps().then(({ onAuthStateChanged }) => {
    if (gen !== _startGeneration) {
      // A newer start() has already run — discard this in-flight listener.
      return
    }
    // Unsubscribe any prior auth listener before attaching the new one.
    _unsubAuth?.()
    _unsubAuth = onAuthStateChanged(_auth!, user => {
      if (!_auth) {
        // configure() hasn't finished yet — buffer the event for replay
        _pendingAuthUser = user
        return
      }
      _currentUser = user
      if (user) {
        void onUserSignedIn(user)
      } else {
        setState({ status: 'signed-out', detail: 'not signed in', pendingCount: _pending.length })
        _unsubSnapshot?.()
        _unsubSnapshot = null
      }
    })
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
  _pendingAuthUser = undefined  // clear any buffered auth event
  setState({ status: 'off', detail: 'sync stopped', pendingCount: _pending.length })
}

/**
 * SYNC-07: Cleanly restart the sync engine with a new config.
 * Safe to call even when the engine was never started (idempotent stop).
 * Guards against concurrent calls with an in-flight flag.
 *
 * Sequence: stop() → configure(cfg, familyId) → start()
 */
let _restarting = false

export async function restartSync(cfg: FirebaseConfig, familyId: string): Promise<void> {
  if (_restarting) return
  _restarting = true
  try {
    stop()
    await configure(cfg, familyId)
    start()
  } finally {
    _restarting = false
  }
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
    setState({ status: 'signed-out', detail: DETAIL_FAMILY_NEEDED, pendingCount: _pending.length })
    return
  }

  setState({ status: 'connecting', detail: 'connecting...', pendingCount: _pending.length })

  try {
    // F2 + F8: fetch family doc early so we can surface the invite code and detect
    // not-found familyIds (e.g. a leftover uuid from the old F8 bug).
    const { doc, getDoc } = await _firestoreOps()
    const familyRef = doc(_db, 'families', _familyId)
    const familySnap = await getDoc(familyRef)
    if (!familySnap.exists()) {
      // F8: unknown familyId — treat as no-family, offer create/join
      _familyId = ''
      setState({ status: 'signed-out', detail: DETAIL_FAMILY_NEEDED, pendingCount: _pending.length })
      return
    }
    // F2: expose invite code in state so UI can display it
    const familyData = familySnap.data() as FamilyDoc
    setState({ inviteCode: familyData.inviteCode })

    // Reconnect adopt-if-empty: if this device has no baby name yet (e.g. joined
    // before the joinFamily fix, or restored from a fresh install), copy babyName
    // and babyBirthdate from the family doc into local settings.
    // Never overwrites a non-empty locally-entered name.
    try {
      const localSettings = await ipc.getSettings()
      const localName = localSettings.baby?.name?.trim() ?? ''
      const isDefault = localName === '' || localName === '아기'
      if (isDefault && (familyData.babyName || familyData.babyBirthdate)) {
        await ipc.saveSettings({
          ...localSettings,
          baby: {
            ...(localSettings.baby ?? { name: '', birthdate: '' }),
            name:      familyData.babyName      ?? localSettings.baby?.name      ?? '',
            birthdate: familyData.babyBirthdate ?? localSettings.baby?.birthdate ?? '',
          },
        })
      }
    } catch {
      // best-effort: local settings update failure must not block sync
    }

    await reconcile(user)
    await attachSnapshot()
    setState({ status: 'online', detail: `${user.email} connected`, pendingCount: _pending.length })
    void drainQueue()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    setState({ status: 'error', detail: `connection error: ${msg}`, pendingCount: _pending.length })
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

  const { doc, getDoc, collection, getDocs } = await _firestoreOps()

  // 가족 문서 확인 (멤버 검증)
  const familyRef = doc(_db, 'families', _familyId)
  const familySnap = await getDoc(familyRef)
  if (!familySnap.exists()) {
    throw new Error('family document not found')
  }
  const familyData = familySnap.data() as FamilyDoc
  if (!familyData.members[user.uid]) {
    throw new Error('not a member of this family')
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
async function attachSnapshot(): Promise<void> {
  if (!_db || !_familyId) return

  _unsubSnapshot?.()

  const { collection, onSnapshot } = await _firestoreOps()
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
      setState({ status: 'error', detail: `snapshot error: ${err.message}`, pendingCount: _pending.length })
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
  const { doc, writeBatch } = await _firestoreOps()
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
 * P2 + F6 + F7: Batch upload with per-doc fallback.
 * 1. Try a full batch. On failure fall back to per-doc writes.
 * 2. Docs that already exist remotely (create-conflict) → remote won: fetch remote,
 *    apply locally, converge (treat as uploaded).
 * 3. Other failing docs are quarantined: kept in pending for retry with backoff.
 * Returns Set of docIds that were successfully uploaded OR converged remotely.
 * drainQueue uses the returned set to remove only confirmed-ok docs from _pending,
 * so partial-failure events are never silently dropped.
 */
async function batchUpload(events: DiaryEvent[]): Promise<Set<string>> {
  const uploaded = new Set<string>()
  if (!_db || !_familyId || events.length === 0) return uploaded

  const { doc, writeBatch, getDoc } = await _firestoreOps()

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
      // Full batch succeeded — all docs in this chunk are uploaded
      for (const event of chunk) uploaded.add(makeDocId(event))
    } catch {
      // F7: batch failed — fall back to per-doc so one poison doc can't block the rest
      for (const event of chunk) {
        const docId = makeDocId(event)
        const result = await uploadOne(event)
        if (result === 'ok') {
          uploaded.add(docId)
        } else if (result === 'already-exists') {
          // F6: remote won — fetch it and apply locally, then converge
          try {
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
          // Converged — treat as uploaded so drain removes it from pending
          uploaded.add(docId)
        }
        // 'error' docs: NOT added to uploaded → drain keeps them in pending for retry
      }
    }
  }

  return uploaded
}

/** 업로드 큐 드레인 */
async function drainQueue(): Promise<void> {
  if (!_db || !_familyId || _pending.length === 0) return

  const now = Date.now()
  const ready = _pending.filter(p => p.nextRetry <= now)
  if (ready.length === 0) return

  const toUpload = ready.map(p => p.event)

  try {
    // P2: batchUpload now returns only the set of docIds that succeeded or converged.
    // We filter _pending by that set so partial-failure docs stay for retry.
    const uploadedIds = await batchUpload(toUpload)
    _pending = _pending.filter(p => !uploadedIds.has(makeDocId(p.event)))
    // Apply backoff to any docs that were attempted but NOT confirmed (still in pending)
    const attemptedDocIds = new Set(toUpload.map(makeDocId))
    _pending = _pending.map(p => {
      if (!attemptedDocIds.has(makeDocId(p.event))) return p
      const attempts = p.attempts + 1
      const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempts - 1), MAX_BACKOFF_MS)
      return { ...p, attempts, nextRetry: Date.now() + backoff }
    })
    savePending(_pending)
    syncPendingCount()
    if (_pending.length === 0) {
      setState({ status: 'online', detail: _currentUser?.email ? `${_currentUser.email} connected` : 'connected', pendingCount: 0 })
    } else {
      scheduleRetry()
    }
  } catch {
    // batchUpload itself threw (e.g. network-level error before any doc processed)
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


