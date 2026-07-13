/**
 * src/sync/syncEngine.ts
 * 클라우드 동기화 엔진.
 *
 * Firestore 구조:
 *   families/{familyId}  — 가족 문서
 *   families/{familyId}/events/{mutationDocId}  — 이벤트 mutation (불변 doc)
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
import { AppSettings, DiaryEvent } from '../../shared/types'
import {
  canonicalEventJson,
  ensureEventMutationIdentity,
  getEventContentId,
  isValidEventId,
  isValidMutationId,
  validateDiaryEvent,
} from '../../shared/eventResolver'
import { assertFamilyId } from '../../shared/familyId'
import { ipc } from '../lib/ipc'
import {
  makeBabyInfoDocId,
  parseCloudBabyInfoDocument,
  persistSettingsWithBabyInfoMutation,
  reconcileFamilyBabyInfo,
  setBabyInfoPersistenceObserver,
} from './babyInfoSync'
import type {
  FamilyBabyInfoDocument,
  ReconcileBabyInfoResult,
} from './babyInfoSync'
import {
  initFirebase,
  teardownFirebase,
  fbSignIn,
  fbSignUp,
  fbSignOut,
  getFirebaseAuth,
  preflightFirebasePersistence,
  FirebaseConfig,
} from './firebase'
import type { FirebasePersistenceClaim } from '../../shared/firebasePersistence'
import { DEFAULT_FIREBASE_CONFIG } from '../../shared/defaultFirebaseConfig'

export {
  makeBabyInfoDocId,
  parseCloudBabyInfoDocument,
  persistSettingsWithBabyInfoMutation,
}

// ────────────────────────────────────────────────────────────
// Lazy-loaded firebase/firestore helpers.
// Populated on first call to _firestoreOps() which runs only after
// initFirebase() has already fetched the firebase chunk.
// ────────────────────────────────────────────────────────────

type FirestoreOps = {
  collection: typeof import('firebase/firestore').collection
  doc: typeof import('firebase/firestore').doc
  query: typeof import('firebase/firestore').query
  orderBy: typeof import('firebase/firestore').orderBy
  documentId: typeof import('firebase/firestore').documentId
  startAfter: typeof import('firebase/firestore').startAfter
  limit: typeof import('firebase/firestore').limit
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
      query: m.query,
      orderBy: m.orderBy,
      documentId: m.documentId,
      startAfter: m.startAfter,
      limit: m.limit,
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
  | 'detached'    // 로컬 리스너는 즉시 분리됨; 원격 작업과 독립
  | 'no-config'   // 설정 없음
  | 'signing-out' // Firebase Auth 로그아웃 완료 대기 중
  | 'signed-out'  // 설정은 있으나 미로그인
  | 'superseded'  // 더 최신 lifecycle lease가 이전 작업을 대체함
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
  babyInfoWinnerKey?: string
  babyInfoWinnerMutationId?: string
  babyInfoWinnerLogicalClock?: number
  babyInfoWinnerUpdatedAt?: string
  babyInfoWinnerAuthorId?: string
  babyInfoWinnerOrigin?: import('../../shared/types').BabyInfoMutation['origin']
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

/** Emitted when the family doc is missing/inaccessible — offer create/join. */
export const DETAIL_FAMILY_GONE = 'FAMILY_GONE'

/** Access could not be classified; retain both local and cloud identity. */
export const DETAIL_FAMILY_ACCESS_UNCERTAIN = 'FAMILY_ACCESS_UNCERTAIN'

/** Local listeners detach immediately, while persisted Firebase logout is bounded. */
export const SIGN_OUT_TIMEOUT_MS = 10_000
export const DETAIL_SIGN_OUT_INCOMPLETE = 'SIGN_OUT_INCOMPLETE'
export const DETAIL_SIGN_OUT_TIMEOUT = 'SIGN_OUT_TIMEOUT'
export const DETAIL_SIGN_OUT_FAILED = 'SIGN_OUT_FAILED'

export class SyncLifecycleError extends Error {
  readonly code: 'SIGN_OUT_TIMEOUT' | 'SIGN_OUT_FAILED' | 'SIGN_OUT_SUPERSEDED'

  constructor(code: SyncLifecycleError['code'], message: string, cause?: unknown) {
    super(message)
    this.name = 'SyncLifecycleError'
    this.code = code
    if (cause !== undefined) Object.assign(this, { cause })
  }
}

// ────────────────────────────────────────────────────────────
// 내부 상태
// ────────────────────────────────────────────────────────────

let _db: Firestore | null = null
let _auth: Auth | null = null
let _config: FirebaseConfig | null = null
let _familyId: string = ''
let _currentUser: User | null = null
let _unsubSnapshot: Unsubscribe | null = null
let _unsubBabyInfoSnapshot: Unsubscribe | null = null
let _unsubFamilySnapshot: Unsubscribe | null = null
let _unsubAuth: Unsubscribe | null = null
let _statusCallbacks: StatusCallback[] = []
let _retryTimer: ReturnType<typeof setTimeout> | null = null
let _started = false
let _babyInfoPendingCount = 0
let _babyInfoNeedsRetry = false
let _babyInfoRetryAttempts = 0
let _babyInfoNextRetry = 0
let _connectionNeedsRetry = false
let _connectionRetryAttempts = 0
let _connectionNextRetry = 0

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
let _generation = 0
let _configurationRequestVersion = 0

interface InitializedFirebaseRuntime {
  config: FirebaseConfig
  familyId: string
  db: Firestore
  auth: Auth
}

interface PendingFirebaseInitialization {
  generation: number
  signOutClaimGeneration: number | null
  startAfterInitialization: boolean
  promise: Promise<InitializedFirebaseRuntime | null>
}

let _pendingFirebaseInitialization: PendingFirebaseInitialization | null = null

interface ActiveSignOut {
  generation: number
  supersede: () => void
}

let _activeSignOut: ActiveSignOut | null = null

function initializationLeaseIsCurrent(lease: PendingFirebaseInitialization): boolean {
  return lease.generation === _generation
    || lease.signOutClaimGeneration === _generation
}

interface SyncContext {
  generation: number
  db: Firestore
  familyId: string
  user: User
}

interface AuthContext {
  generation: number
  db: Firestore
  user: User
}

class StaleSyncOperationError extends Error {
  constructor() {
    super('stale sync operation')
    this.name = 'StaleSyncOperationError'
  }
}

/** Network work must never occupy the lifecycle lane used by stop/restart. */
function runDetached(operation: () => Promise<void>, label: string): void {
  void Promise.resolve()
    .then(operation)
    .catch(error => {
      if (error instanceof StaleSyncOperationError) return
      console.error(`[syncEngine] detached ${label} failed`, error)
    })
}

function supersedeActiveSignOut(): void {
  const active = _activeSignOut
  if (!active) return
  _activeSignOut = null
  setState({
    status: 'superseded',
    detail: 'sign-out superseded by a newer lifecycle lease',
    pendingCount: totalPendingCount(),
  })
  active.supersede()
}

function contextIsCurrent(context: SyncContext): boolean {
  return context.generation === _generation
    && context.db === _db
    && context.familyId === _familyId
    && context.user.uid === _currentUser?.uid
}

function authContextIsCurrent(context: AuthContext): boolean {
  return context.generation === _generation
    && context.db === _db
    && context.user.uid === _currentUser?.uid
}

function assertAuthCurrent(context: AuthContext): void {
  if (!authContextIsCurrent(context)) throw new StaleSyncOperationError()
}

function assertCurrent(context: SyncContext): void {
  if (!contextIsCurrent(context)) throw new StaleSyncOperationError()
}

function currentContext(): SyncContext | null {
  if (!_db || !_familyId || !_currentUser) return null
  return {
    generation: _generation,
    db: _db,
    familyId: _familyId,
    user: _currentUser,
  }
}

// ────────────────────────────────────────────────────────────
// 상태 관리
// ────────────────────────────────────────────────────────────

function setState(partial: Partial<SyncState>): void {
  _state = { ..._state, ...partial }
  _statusCallbacks.forEach(cb => {
    try { cb(_state) } catch { /* ignore */ }
  })
}

function totalPendingCount(): number {
  return _pending.length + _babyInfoPendingCount
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
    const seen = new Set<string>()
    for (const item of parsed) {
      if (
        item &&
        typeof item === 'object' &&
        item.event &&
        Number.isInteger(item.attempts) &&
        item.attempts >= 0 &&
        typeof item.nextRetry === 'number' &&
        Number.isFinite(item.nextRetry) &&
        validateDiaryEvent(item.event) === null
      ) {
        const pendingItem = {
          ...(item as PendingItem),
          event: ensureEventMutationIdentity((item as PendingItem).event),
        }
        const key = makeDocId(pendingItem.event)
        if (!seen.has(key)) {
          seen.add(key)
          valid.push(pendingItem)
        }
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
    // In-memory _pending is still intact; reconcile rescues on restart via the physical mutation log.
    console.error('[syncEngine] savePending failed — pending may be lost on restart:', err)
  }
}

let _pending: PendingItem[] = loadPending()

function syncPendingCount(): void {
  setState({ pendingCount: totalPendingCount() })
}

setBabyInfoPersistenceObserver((pendingCount, needsRetry) => {
  _babyInfoPendingCount = pendingCount
  _babyInfoNeedsRetry = needsRetry
  syncPendingCount()
  if (_state.status === 'online' && needsRetry) {
    _babyInfoNextRetry = 0
    const context = currentContext()
    if (context) runDetached(() => drainQueue(context), 'baby-info drain')
  }
})

// ────────────────────────────────────────────────────────────
// Immutable cloud document identity. Legacy records retain "${id}_${rev}".
// ────────────────────────────────────────────────────────────

export function makeDocId(event: DiaryEvent): string {
  const validationError = validateDiaryEvent(event)
  if (validationError) throw new Error(`invalid event identity: ${validationError}`)
  if (isValidMutationId(event.mutationId)) {
    return `m3|${encodeURIComponent(event.id)}|${event.rev}|${event.mutationId}|${getEventContentId(event)}`
  }
  return `${event.id}_${event.rev}`
}

export function parseDocId(docId: string): { id: string; rev: number; mutationId?: string; contentId?: string } | null {
  if (typeof docId !== 'string' || docId.length === 0 || docId.length > 1500 || docId.includes('/')) return null

  if (docId.startsWith('m3|')) {
    const parts = docId.split('|')
    if (
      parts.length === 5
      && parts[0] === 'm3'
      && /^[1-9]\d*$/.test(parts[2])
      && isValidMutationId(parts[3])
      && isValidMutationId(parts[4])
    ) {
      try {
        const id = decodeURIComponent(parts[1])
        const rev = Number(parts[2])
        if (isValidEventId(id) && encodeURIComponent(id) === parts[1] && Number.isSafeInteger(rev)) {
          return { id, rev, mutationId: parts[3], contentId: parts[4] }
        }
      } catch {
        // It may still be a legacy id beginning with the reserved-looking prefix.
      }
    }
  }

  if (docId.startsWith('m2|')) {
    const parts = docId.split('|')
    if (parts.length === 4 && parts[0] === 'm2' && /^[1-9]\d*$/.test(parts[2]) && isValidMutationId(parts[3])) {
      try {
        const id = decodeURIComponent(parts[1])
        const rev = Number(parts[2])
        if (isValidEventId(id) && encodeURIComponent(id) === parts[1] && Number.isSafeInteger(rev)) {
          return { id, rev, mutationId: parts[3] }
        }
      } catch {
        // It may still be a legacy id beginning with the reserved-looking prefix.
      }
    }
  }

  const lastUnderscore = docId.lastIndexOf('_')
  if (lastUnderscore < 0) return null
  const id = docId.substring(0, lastUnderscore)
  const rawRev = docId.substring(lastUnderscore + 1)
  if (!isValidEventId(id) || !/^[1-9]\d*$/.test(rawRev)) return null
  const rev = Number(rawRev)
  if (!Number.isSafeInteger(rev)) return null
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
 * A null config resolves to the exact historical default. The main process must claim
 * that config's immutable persistence namespace before the active runtime is detached;
 * a rejected claim therefore leaves the current Auth/Firestore runtime untouched.
 */
async function configureInternal(
  effectiveCfg: FirebaseConfig,
  familyIdValue: string,
  generation: number,
  lease: PendingFirebaseInitialization,
  persistenceClaim: FirebasePersistenceClaim,
): Promise<InitializedFirebaseRuntime | null> {
  const familyId = familyIdValue === '' ? '' : assertFamilyId(familyIdValue)

  try {
    if (familyId && typeof ipc.getBabyInfoSummary === 'function') {
      const summary = await ipc.getBabyInfoSummary(familyId)
      if (!initializationLeaseIsCurrent(lease)) return null
      _babyInfoPendingCount = summary.totalPendingCount
      _babyInfoNeedsRetry = summary.pendingCount > 0
    } else {
      _babyInfoPendingCount = 0
      _babyInfoNeedsRetry = false
    }
  } catch (err) {
    if (!initializationLeaseIsCurrent(lease)) return null
    _babyInfoPendingCount = 0
    _babyInfoNeedsRetry = false
    if (generation === _generation) {
      setState({
        status: 'error',
        detail: `baby info settings error: ${err instanceof Error ? err.message : String(err)}`,
        pendingCount: totalPendingCount(),
      })
    }
    throw err
  }

  const result = await initFirebase(
    effectiveCfg,
    `sync-${generation}`,
    persistenceClaim,
  )
  if (!initializationLeaseIsCurrent(lease)) return null
  if (!result) {
    if (generation === _generation) {
      setState({ status: 'no-config', detail: 'firebase init failed', pendingCount: totalPendingCount() })
    }
    return null
  }

  const runtime: InitializedFirebaseRuntime = {
    config: effectiveCfg,
    familyId,
    db: result.db,
    auth: result.auth,
  }
  if (generation === _generation) {
    publishInitializedFirebaseRuntime(runtime)
    setState({ status: 'signed-out', detail: 'not signed in', pendingCount: totalPendingCount() })
  }
  return runtime
}

function publishInitializedFirebaseRuntime(runtime: InitializedFirebaseRuntime): void {
  _config = runtime.config
  _familyId = runtime.familyId
  _db = runtime.db
  _auth = runtime.auth
}

function beginFirebaseInitialization(
  cfg: FirebaseConfig,
  familyId: string,
  generation: number,
  startAfterInitialization: boolean,
  persistenceClaim: FirebasePersistenceClaim,
): Promise<void> {
  const lease: PendingFirebaseInitialization = {
    generation,
    signOutClaimGeneration: null,
    startAfterInitialization,
    promise: Promise.resolve(null),
  }
  _pendingFirebaseInitialization = lease
  const operation = configureInternal(
    cfg,
    familyId,
    generation,
    lease,
    persistenceClaim,
  )
  lease.promise = operation
  const clearLease = () => {
    if (_pendingFirebaseInitialization === lease) _pendingFirebaseInitialization = null
  }
  void operation.then(clearLease, clearLease)
  return operation.then(() => undefined)
}

interface PreparedFirebaseConfiguration {
  config: FirebaseConfig
  familyId: string
  persistenceClaim: FirebasePersistenceClaim
}

async function prepareFirebaseConfiguration(
  cfg: FirebaseConfig | null,
  familyIdValue: string,
): Promise<PreparedFirebaseConfiguration> {
  const familyId = familyIdValue === '' ? '' : assertFamilyId(familyIdValue)
  const config = cfg ?? DEFAULT_FIREBASE_CONFIG
  const persistenceClaim = await preflightFirebasePersistence(config)
  return { config, familyId, persistenceClaim }
}

/** Claim first; only the latest successful preflight may detach a working runtime. */
export function configure(cfg: FirebaseConfig | null, familyId: string): Promise<void> {
  const requestVersion = ++_configurationRequestVersion
  return (async () => {
    const prepared = await prepareFirebaseConfiguration(cfg, familyId)
    if (requestVersion !== _configurationRequestVersion) return
    supersedeActiveSignOut()
    const generation = ++_generation
    invalidateConfiguredRuntime(false)
    setState({ status: 'detached', detail: 'reconfiguring sync', pendingCount: totalPendingCount() })
    void stopRuntime(generation, false)
    await beginFirebaseInitialization(
      prepared.config,
      prepared.familyId,
      generation,
      false,
      prepared.persistenceClaim,
    )
  })()
}

/** 회원가입 (신규 사용자) */
export async function signUp(email: string, password: string, keepLoggedIn = true): Promise<User> {
  if (!_auth) throw new Error('Firebase not configured')
  const cred = await fbSignUp(_auth, email, password, keepLoggedIn)
  return cred.user
}

/** 로그인 */
export async function signIn(email: string, password: string, keepLoggedIn = true): Promise<User> {
  if (!_auth) throw new Error('Firebase not configured')
  const cred = await fbSignIn(_auth, email, password, keepLoggedIn)
  return cred.user
}

/** 로그아웃. Local detach is immediate; success is published only after Auth confirms it. */
export function signOutSync(): Promise<void> {
  _configurationRequestVersion += 1
  supersedeActiveSignOut()
  const auth = _auth
  const pendingInitialization = !auth
    && _pendingFirebaseInitialization
    && initializationLeaseIsCurrent(_pendingFirebaseInitialization)
    ? _pendingFirebaseInitialization
    : null
  if (!auth && !pendingInitialization) {
    suspendRuntimeWork()
    _currentUser = null
    return Promise.resolve()
  }

  const generation = ++_generation
  if (pendingInitialization) pendingInitialization.signOutClaimGeneration = generation
  const shouldRemainStarted = _started
    || pendingInitialization?.startAfterInitialization === true
  // Invalidate captured callbacks synchronously, before the Firebase promise.
  suspendRuntimeWork()
  _currentUser = null
  setState({ status: 'signing-out', detail: 'signing out', pendingCount: totalPendingCount() })

  const remoteOperation = auth
    ? Promise.resolve().then(() => fbSignOut(auth))
    : pendingInitialization!.promise.then(runtime => {
      if (!runtime) return
      // A newer lifecycle lease owns Firebase now. Never sign out a service it
      // may have reactivated under the same stable persistence identity.
      if (generation !== _generation) {
        throw new SyncLifecycleError(
          'SIGN_OUT_SUPERSEDED',
          'Firebase sign-out was superseded before initialization completed',
        )
      }
      // Publish only while this sign-out is still active. After a timeout the
      // late remote logout may finish, but it must not resurrect local state.
      if (_activeSignOut?.generation === generation) {
        publishInitializedFirebaseRuntime(runtime)
      }
      return fbSignOut(runtime.auth)
    })
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = () => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      if (_activeSignOut?.generation === generation) _activeSignOut = null
      return true
    }
    const fail = (error: SyncLifecycleError) => {
      if (!finish()) return
      if (generation === _generation && error.code !== 'SIGN_OUT_SUPERSEDED') {
        setState({
          status: 'error',
          detail: error.code === 'SIGN_OUT_TIMEOUT'
            ? DETAIL_SIGN_OUT_TIMEOUT
            : DETAIL_SIGN_OUT_FAILED,
          pendingCount: totalPendingCount(),
        })
      }
      reject(error)
    }
    const timer = setTimeout(() => {
      fail(new SyncLifecycleError('SIGN_OUT_TIMEOUT', 'Firebase sign-out timed out'))
    }, SIGN_OUT_TIMEOUT_MS)

    _activeSignOut = {
      generation,
      supersede: () => fail(new SyncLifecycleError(
        'SIGN_OUT_SUPERSEDED',
        'Firebase sign-out was superseded before completion',
      )),
    }

    remoteOperation.then(
      () => {
        if (!finish()) return
        if (generation !== _generation) {
          reject(new SyncLifecycleError(
            'SIGN_OUT_SUPERSEDED',
            'Firebase sign-out was superseded before completion',
          ))
          return
        }
        setState({ status: 'signed-out', detail: 'signed out', pendingCount: totalPendingCount() })
        if (shouldRemainStarted && _auth && _config) {
          runDetached(() => startInternal(generation), 'post-sign-out auth listener')
        }
        resolve()
      },
      error => fail(new SyncLifecycleError('SIGN_OUT_FAILED', 'Firebase sign-out failed', error)),
    )
  })
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

  // Write cloud identity truth: users/{authUid}.familyId
  try {
    const { doc: docFn2, setDoc: setDocFn } = await _firestoreOps()
    await setDocFn(docFn2(_db, 'users', authUid), { familyId: familyRef.id }, { merge: true })
  } catch (e) {
    console.warn('[syncEngine] createFamily: could not write users doc', e)
  }

  // Main owns the projection transition. Creation is the only path allowed
  // to adopt an unlinked local pair into the destination journal.
  await ipc.commitBabyInfo({
    kind: 'family-transition',
    familyId: familyRef.id,
    mode: 'create',
  })

  _familyId = familyRef.id
  setState({ inviteCode })
  // P6: auth state hasn't changed so onAuthStateChanged won't re-fire;
  // manually kick reconcile/snapshot so pending events drain without a restart.
  if (_currentUser && _db) {
    const context: AuthContext = { generation: _generation, db: _db, user: _currentUser }
    runDetached(() => onUserSignedIn(context), 'family creation reconnect')
  }
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

  const familyId = assertFamilyId((inviteSnap.data() as { familyId: string }).familyId)

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

  // Write cloud identity truth: users/{authUid}.familyId
  try {
    const { doc: docFn3, setDoc: setDocFn2 } = await _firestoreOps()
    await setDocFn2(docFn3(_db, 'users', authUid), { familyId }, { merge: true })
  } catch (e) {
    console.warn('[syncEngine] joinFamily: could not write users doc', e)
  }

  // Joining selects only destination history (or a blank projection); it must
  // never upload the previous/local family pair.
  await ipc.commitBabyInfo({
    kind: 'family-transition',
    familyId,
    mode: 'join',
  })

  // P6: auth state hasn't changed so onAuthStateChanged won't re-fire;
  // manually kick reconcile/snapshot so pending events drain without a restart.
  if (_currentUser && _db) {
    const context: AuthContext = { generation: _generation, db: _db, user: _currentUser }
    runDetached(() => onUserSignedIn(context), 'family join reconnect')
  }
  return { familyId, babyName, babyBirthdate }
}

/** Compatibility API routed through the durable local mutation path. */
export async function updateFamilyBabyInfo(babyName: string, babyBirthdate: string): Promise<void> {
  const current = await ipc.getSettings()
  await persistSettingsWithBabyInfoMutation({
    ...current,
    baby: {
      ...current.baby,
      name: babyName,
      birthdate: babyBirthdate,
    },
  })
}

/**
 * Update own member entry in the family doc.
 * Called on connect and on settings save when profile name/role changes.
 * Rules: isMember() update restricted to members.{uid} field-path is allowed.
 */
export async function updateMemberEntry(name: string, role: 'dad' | 'mom'): Promise<void> {
  if (!_db || !_familyId || !_currentUser) return
  const uid = _currentUser.uid
  const memberName = name || _currentUser.email?.split('@')[0] || 'user'
  const { doc, updateDoc } = await _firestoreOps()
  const familyRef = doc(_db, 'families', _familyId)
  await updateDoc(familyRef, {
    [`members.${uid}`]: { name: memberName, role },
  })
}

/**
 * 이벤트를 업로드 큐에 추가.
 * 로컬 append 성공 후 즉시 호출.
 * 원격에서 수신한 이벤트는 tag된 docId로 필터링 → 재업로드 없음.
 */
export function enqueue(event: DiaryEvent): void {
  const validationError = validateDiaryEvent(event)
  if (validationError) {
    console.error(`[syncEngine] enqueue rejected invalid event: ${validationError}`)
    return
  }
  const mutation = ensureEventMutationIdentity(event)
  const docId = makeDocId(mutation)

  // 원격에서 받은 이벤트는 재업로드 하지 않음
  if (_seenFromRemote.has(docId)) return

  // 이미 대기 중인 동일 immutable mutation은 추가하지 않음
  if (_pending.some(p => makeDocId(p.event) === docId)) return

  _pending.push({ event: mutation, attempts: 0, nextRetry: 0 })
  savePending(_pending)
  syncPendingCount()

  // 연결 중이면 즉시 드레인 시도
  if (_state.status === 'online') {
    const context = currentContext()
    if (context) runDetached(() => drainQueue(context), 'event drain')
  }
}

function detachDataListeners(): void {
  _unsubSnapshot?.()
  _unsubSnapshot = null
  _unsubBabyInfoSnapshot?.()
  _unsubBabyInfoSnapshot = null
  _unsubFamilySnapshot?.()
  _unsubFamilySnapshot = null
}

function suspendRuntimeWork(): void {
  _started = false
  detachDataListeners()
  _unsubAuth?.()
  _unsubAuth = null
  if (_retryTimer) {
    clearTimeout(_retryTimer)
    _retryTimer = null
  }
}

function invalidateConfiguredRuntime(publishState: boolean): void {
  suspendRuntimeWork()
  _db = null
  _auth = null
  _currentUser = null
  _pendingAuthUser = undefined
  _connectionNeedsRetry = false
  _connectionRetryAttempts = 0
  _connectionNextRetry = 0
  if (publishState) {
    setState({ status: 'detached', detail: 'sync detached', pendingCount: totalPendingCount() })
  }
}

async function startInternal(generation: number): Promise<void> {
  if (generation !== _generation || _started) return
  if (!_auth || !_config || !_db) {
    setState({ status: 'no-config', detail: 'waiting for firebase init', pendingCount: totalPendingCount() })
    return
  }

  const auth = _auth
  const db = _db
  const { onAuthStateChanged } = await _authOps()
  if (generation !== _generation || auth !== _auth || db !== _db) return

  _unsubAuth?.()
  _unsubAuth = onAuthStateChanged(auth, user => {
    if (generation !== _generation || auth !== _auth || db !== _db) return
    if (!user) {
      _currentUser = null
      detachDataListeners()
      setState({ status: 'signed-out', detail: 'not signed in', pendingCount: totalPendingCount() })
      return
    }

    _currentUser = user
    const context: AuthContext = { generation, db, user }
    runDetached(async () => {
      if (!authContextIsCurrent(context)) return
      await onUserSignedIn(context)
    }, 'auth reconciliation')
  })
  _started = true
}

/** 동기화 시작 (앱 기동 시 호출) */
export function start(): Promise<void> {
  const generation = _generation
  return startInternal(generation)
}

async function stopRuntime(generation: number, publishState = true): Promise<void> {
  invalidateConfiguredRuntime(false)
  try {
    const teardown = teardownFirebase()
    void teardown.catch(error => {
      console.error('[syncEngine] background Firebase teardown failed', error)
    })
  } catch (error) {
    console.error('[syncEngine] background Firebase teardown failed', error)
  }
  if (generation !== _generation) return
  if (publishState) {
    setState({ status: 'detached', detail: 'sync detached', pendingCount: totalPendingCount() })
  }
}

/** 동기화 중단. Generation is invalidated synchronously. */
export function stop(): Promise<void> {
  _configurationRequestVersion += 1
  supersedeActiveSignOut()
  const generation = ++_generation
  invalidateConfiguredRuntime(false)
  setState({ status: 'detached', detail: 'sync detached', pendingCount: totalPendingCount() })
  void stopRuntime(generation, false)
  return Promise.resolve()
}

/** Latest restart owns Firebase/listeners without awaiting any older network work. */
export function restartSync(cfg: FirebaseConfig, familyId: string): Promise<void> {
  const requestVersion = ++_configurationRequestVersion
  return (async () => {
    const prepared = await prepareFirebaseConfiguration(cfg, familyId)
    if (requestVersion !== _configurationRequestVersion) return
    supersedeActiveSignOut()
    const generation = ++_generation
    invalidateConfiguredRuntime(false)
    setState({ status: 'detached', detail: 'sync restart detached', pendingCount: totalPendingCount() })
    void stopRuntime(generation, false)
    await beginFirebaseInitialization(
      prepared.config,
      prepared.familyId,
      generation,
      true,
      prepared.persistenceClaim,
    )
    if (generation !== _generation) return
    await startInternal(generation)
  })()
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

function markConnectionRetry(context: AuthContext, error: unknown): void {
  if (!authContextIsCurrent(context)) return
  _connectionNeedsRetry = true
  _connectionRetryAttempts += 1
  const backoff = Math.min(
    BASE_BACKOFF_MS * Math.pow(2, _connectionRetryAttempts - 1),
    MAX_BACKOFF_MS,
  )
  _connectionNextRetry = Date.now() + backoff
  console.warn('[syncEngine] family access/sync uncertain; retaining identity', error)
  setState({
    status: 'error',
    detail: DETAIL_FAMILY_ACCESS_UNCERTAIN,
    pendingCount: totalPendingCount(),
  })
  scheduleRetry()
}

async function onUserSignedIn(authContext: AuthContext): Promise<void> {
  if (!authContextIsCurrent(authContext)) return
  const { user, db } = authContext
  setState({ status: 'connecting', detail: 'connecting...', pendingCount: totalPendingCount() })

  try {
    const { doc, getDoc, setDoc, updateDoc } = await _firestoreOps()
    assertAuthCurrent(authContext)

    let cloudFamilyId: string | undefined
    const userDocRef = doc(db, 'users', user.uid)
    const userSnap = await getDoc(userDocRef)
    assertAuthCurrent(authContext)
    if (userSnap.exists()) cloudFamilyId = (userSnap.data() as { familyId?: string }).familyId
    if (cloudFamilyId) cloudFamilyId = assertFamilyId(cloudFamilyId)

    const localSettings = await ipc.getSettings()
    assertAuthCurrent(authContext)
    const localFamilyIdValue = localSettings.familyId || _familyId || ''
    const localFamilyId = localFamilyIdValue ? assertFamilyId(localFamilyIdValue) : ''

    if (!cloudFamilyId && localFamilyId) {
      const localFamilyRef = doc(db, 'families', localFamilyId)
      const localFamilySnap = await getDoc(localFamilyRef)
      assertAuthCurrent(authContext)
      const localContext: SyncContext = {
        ...authContext,
        familyId: localFamilyId,
      }
      if (!localFamilySnap.exists()) {
        await handleFamilyGone(localContext)
        return
      }
      const localFamilyData = localFamilySnap.data() as FamilyDoc
      if (!localFamilyData.members?.[user.uid]) {
        await handleFamilyGone(localContext)
        return
      }
      assertAuthCurrent(authContext)
      await setDoc(userDocRef, { familyId: localFamilyId }, { merge: true })
      assertAuthCurrent(authContext)
      cloudFamilyId = localFamilyId
    }

    if (cloudFamilyId && cloudFamilyId !== localFamilyId) {
      assertAuthCurrent(authContext)
      await ipc.mergeSettings({ familyId: cloudFamilyId })
      assertAuthCurrent(authContext)
      _familyId = cloudFamilyId
    } else if (cloudFamilyId) {
      _familyId = cloudFamilyId
    } else {
      _familyId = localFamilyId
    }

    if (!_familyId) {
      _connectionNeedsRetry = false
      setState({ status: 'signed-out', detail: DETAIL_FAMILY_NEEDED, pendingCount: totalPendingCount() })
      return
    }

    const context: SyncContext = {
      ...authContext,
      familyId: _familyId,
    }
    assertCurrent(context)
    const familyRef = doc(db, 'families', context.familyId)
    const familySnap = await getDoc(familyRef)
    assertCurrent(context)
    if (!familySnap.exists()) {
      await handleFamilyGone(context)
      return
    }

    const familyData = familySnap.data() as FamilyDoc
    if (!familyData.members?.[user.uid]) {
      await handleFamilyGone(context)
      return
    }
    setState({ inviteCode: familyData.inviteCode })

    // Membership is confirmed readable before any self-heal write.
    try {
      const profileName = localSettings.profile?.name ?? ''
      const profileRole = localSettings.profile?.role ?? 'mom'
      const existingEntry = familyData.members[user.uid]
      const memberName = profileName || user.email?.split('@')[0] || 'user'
      if (existingEntry.name !== memberName || existingEntry.role !== profileRole) {
        assertCurrent(context)
        await updateDoc(familyRef, {
          [`members.${user.uid}`]: { name: memberName, role: profileRole },
        })
        assertCurrent(context)
      }
    } catch (error) {
      if (error instanceof StaleSyncOperationError) throw error
      console.warn('[syncEngine] member entry self-heal failed (non-fatal)', error)
    }

    await reconcile(context)
    assertCurrent(context)
    await attachSnapshot(context)
    assertCurrent(context)
    _connectionNeedsRetry = false
    _connectionRetryAttempts = 0
    _connectionNextRetry = 0
    setState({ status: 'online', detail: `${user.email} connected`, pendingCount: totalPendingCount() })
    runDetached(() => drainQueue(context), 'post-connect drain')
  } catch (error) {
    if (error instanceof StaleSyncOperationError || !authContextIsCurrent(authContext)) return
    markConnectionRetry(authContext, error)
  }
}

/** Confirmed missing/not-a-member clears only local identity, never cloud truth. */
async function handleFamilyGone(context: SyncContext): Promise<void> {
  assertCurrent(context)
  try {
    await ipc.mergeSettings({ familyId: '' })
    assertCurrent(context)
  } catch (error) {
    if (error instanceof StaleSyncOperationError) return
    markConnectionRetry(context, error)
    return
  }
  _familyId = ''
  detachDataListeners()
  _connectionNeedsRetry = false
  _connectionRetryAttempts = 0
  _connectionNextRetry = 0
  setState({ status: 'signed-out', detail: DETAIL_FAMILY_GONE, pendingCount: totalPendingCount() })
}

async function runBabyInfoReconcile(
  context: SyncContext,
  familyDataValue?: FamilyBabyInfoDocument,
): Promise<ReconcileBabyInfoResult> {
  assertCurrent(context)
  const ops = await _firestoreOps()
  assertCurrent(context)
  const familyRef = ops.doc(context.db, 'families', context.familyId)
  let familyData = familyDataValue
  if (!familyData) {
    const familySnapshot = await ops.getDoc(familyRef)
    assertCurrent(context)
    if (!familySnapshot.exists()) throw new Error('family document not found')
    familyData = familySnapshot.data() as FamilyBabyInfoDocument
  }
  const result = await reconcileFamilyBabyInfo({
    db: context.db,
    familyId: context.familyId,
    familyRef,
    familyData,
    ops,
    assertCurrent: () => assertCurrent(context),
  })
  assertCurrent(context)
  _babyInfoPendingCount = result.pendingCount
  _babyInfoNeedsRetry = result.needsRetry
  if (result.needsRetry) {
    _babyInfoRetryAttempts += 1
    const backoff = Math.min(
      BASE_BACKOFF_MS * Math.pow(2, _babyInfoRetryAttempts - 1),
      MAX_BACKOFF_MS,
    )
    _babyInfoNextRetry = Date.now() + backoff
    scheduleRetry()
  } else {
    _babyInfoRetryAttempts = 0
    _babyInfoNextRetry = 0
  }
  syncPendingCount()
  return result
}

/**
 * 초기 연결 시 로컬↔원격 diff 후 양방향 동기화.
 *
 * 로컬: listEventMutations() → 모든 물리 mutation을 손실 없이 반환.
 * 원격: families/{familyId}/events 전체 doc (각 doc = immutable mutation).
 *
 * 1. 원격에 없는 로컬 revision → batched write로 업로드
 * 2. 로컬에 없는 원격 revision → ipc.appendEvent로 로컬 append (dedup은 JSONL 레이어가 처리)
 */
async function reconcile(context: SyncContext): Promise<void> {
  assertCurrent(context)
  const { user, db, familyId } = context
  const { doc, getDoc, collection, getDocs } = await _firestoreOps()
  assertCurrent(context)

  // 가족 문서 확인 (멤버 검증)
  const familyRef = doc(db, 'families', familyId)
  const familySnap = await getDoc(familyRef)
  assertCurrent(context)
  if (!familySnap.exists()) {
    throw new Error('family document not found')
  }
  const familyData = familySnap.data() as FamilyDoc
  if (!familyData.members[user.uid]) {
    throw new Error('not a member of this family')
  }

  // Lossless local mutation list (all physical revisions and same-rev variants).
  const localMutationMap = new Map<string, DiaryEvent>()
  for (const localEvent of await ipc.listEventMutations()) {
    const validationError = validateDiaryEvent(localEvent)
    if (validationError) {
      console.error(`[syncEngine] reconcile ignored invalid local event: ${validationError}`)
      continue
    }
    const mutation = ensureEventMutationIdentity(localEvent)
    localMutationMap.set(makeDocId(mutation), mutation)
  }
  assertCurrent(context)
  const localEvents = Array.from(localMutationMap.values())
  const localDocIds = new Set<string>(localEvents.map(makeDocId))

  // 원격 이벤트 docs 전체 조회
  const eventsRef = collection(db, 'families', familyId, 'events')
  const remoteSnap = await getDocs(eventsRef)
  assertCurrent(context)

  const remoteDocIds = new Set<string>()
  const remoteDocuments: Array<{ docId: string; event: DiaryEvent }> = []

  remoteSnap.docs.forEach(d => {
    const event = parseCloudEventDocument(d.id, d.data())
    if (!event) {
      console.error(`[syncEngine] reconcile ignored invalid cloud event document: ${d.id}`)
      return
    }
    remoteDocIds.add(d.id)
    remoteDocuments.push({ docId: d.id, event })
  })

  // 1. 원격에 없는 로컬 이벤트 → 업로드
  const toUpload = localEvents.filter(e => !remoteDocIds.has(makeDocId(e)))
  await batchUpload(toUpload, context)
  assertCurrent(context)

  // 2. 로컬에 없는 원격 이벤트 → 로컬 append
  const locallyConfirmedDocIds = new Set(localDocIds)
  const toDownload = remoteDocuments.filter(({ docId }) => !localDocIds.has(docId))
  for (const { docId, event } of toDownload) {
    assertCurrent(context)
    _seenFromRemote.add(docId)
    const appendResult = await ipc.appendEvent(event)
    assertCurrent(context)
    if (appendResult !== 'error') locallyConfirmedDocIds.add(docId)
  }

  // Acknowledge only the exact cloud identity and exact canonical payload.
  const remoteByDocId = new Map(remoteDocuments.map(document => [document.docId, document.event]))
  _pending = _pending.filter(pending => {
    const pendingDocId = makeDocId(pending.event)
    const remoteEvent = remoteByDocId.get(pendingDocId)
    if (!remoteEvent || !locallyConfirmedDocIds.has(pendingDocId)) return true
    return canonicalEventJson(pending.event) !== canonicalEventJson(remoteEvent)
  })
  savePending(_pending)
  syncPendingCount()

  // Baby info uses its own immutable collection and durable AppSettings log.
  await runBabyInfoReconcile(context)
}

/** onSnapshot 리스너 부착 — 실시간 원격 업데이트 수신 */
async function attachSnapshot(context: SyncContext): Promise<void> {
  assertCurrent(context)
  detachDataListeners()
  const { collection, onSnapshot } = await _firestoreOps()
  assertCurrent(context)
  const eventsRef = collection(context.db, 'families', context.familyId, 'events')
  _unsubSnapshot = onSnapshot(
    eventsRef,
    { includeMetadataChanges: false },
    snapshot => {
      if (!contextIsCurrent(context)) return
      snapshot.docChanges().forEach(change => {
        if (change.type === 'added' || change.type === 'modified') {
          const event = parseCloudEventDocument(change.doc.id, change.doc.data())
          if (!event) {
            console.error(`[syncEngine] snapshot ignored invalid cloud event document: ${change.doc.id}`)
            return
          }
          const sourceDocId = change.doc.id
          _seenFromRemote.add(sourceDocId)
          void (async () => {
            if (!contextIsCurrent(context)) return
            const appendResult = await ipc.appendEvent(event)
            if (!contextIsCurrent(context) || appendResult === 'error') return
            const remoteCanonical = canonicalEventJson(event)
            _pending = _pending.filter(pending => (
              makeDocId(pending.event) !== sourceDocId
              || canonicalEventJson(pending.event) !== remoteCanonical
            ))
            savePending(_pending)
            syncPendingCount()
          })().catch(() => { /* durable pending remains for retry */ })
        }
      })
    },
    err => {
      if (!contextIsCurrent(context)) return
      detachDataListeners()
      markConnectionRetry(context, err)
    }
  )

  const babyInfoRef = collection(context.db, 'families', context.familyId, 'babyInfoMutations')
  _unsubBabyInfoSnapshot = onSnapshot(
    babyInfoRef,
    { includeMetadataChanges: false },
    snapshot => {
      if (!contextIsCurrent(context)) return
      const hasRelevantChange = snapshot.docChanges().some(change => (
        change.type === 'added' || change.type === 'modified'
      ))
      if (!hasRelevantChange) return
      runDetached(async () => {
        if (!contextIsCurrent(context)) return
        try {
          await runBabyInfoReconcile(context)
        } catch (error) {
          if (error instanceof StaleSyncOperationError || !contextIsCurrent(context)) return
          detachDataListeners()
          markConnectionRetry(context, error)
        }
      }, 'baby-info snapshot reconciliation')
    },
    err => {
      if (!contextIsCurrent(context)) return
      detachDataListeners()
      markConnectionRetry(context, err)
    },
  )

  const { doc } = await _firestoreOps()
  assertCurrent(context)
  const familyRef = doc(context.db, 'families', context.familyId)
  _unsubFamilySnapshot = onSnapshot(
    familyRef,
    { includeMetadataChanges: false },
    snapshot => {
      if (!contextIsCurrent(context)) return
      runDetached(async () => {
        if (!contextIsCurrent(context)) return
        if (!snapshot.exists()) {
          await handleFamilyGone(context)
          return
        }
        const familyData = snapshot.data() as FamilyDoc
        if (!familyData.members?.[context.user.uid]) {
          await handleFamilyGone(context)
          return
        }
        try {
          await runBabyInfoReconcile(context, familyData)
        } catch (error) {
          if (error instanceof StaleSyncOperationError || !contextIsCurrent(context)) return
          detachDataListeners()
          markConnectionRetry(context, error)
        }
      }, 'family snapshot reconciliation')
    },
    err => {
      if (!contextIsCurrent(context)) return
      detachDataListeners()
      markConnectionRetry(context, err)
    },
  )
}

/** Strict Firestore document decoder; doc identity must match immutable payload identity. */
export function parseCloudEventDocument(docId: string, data: DocumentData): DiaryEvent | null {
  const identity = parseDocId(docId)
  if (!identity || !data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  const candidate = (record.event ?? record) as unknown
  if (validateDiaryEvent(candidate) !== null) return null
  const event = candidate as DiaryEvent
  if (event.id !== identity.id || event.rev !== identity.rev) return null
  if ((event.mutationId ?? undefined) !== (identity.mutationId ?? undefined)) return null
  try {
    if (identity.contentId) {
      if (getEventContentId(event) !== identity.contentId || makeDocId(event) !== docId) return null
    } else if (identity.mutationId) {
      const legacyImmutableDocId = `m2|${encodeURIComponent(event.id)}|${event.rev}|${event.mutationId}`
      if (legacyImmutableDocId !== docId) return null
    } else if (`${event.id}_${event.rev}` !== docId) {
      return null
    }
  } catch {
    return null
  }
  return event
}

/**
 * Upload a single event to Firestore. Returns 'ok', 'already-exists', or 'error'.
 * F6: when the same immutable mutation doc already exists remotely (create-conflict),
 *     we treat remote as winner and fetch it to apply locally via ipc.appendEvent.
 */
async function uploadOne(
  event: DiaryEvent,
  context: SyncContext,
): Promise<'ok' | 'already-exists' | 'error'> {
  assertCurrent(context)
  const { doc, writeBatch, getDoc } = await _firestoreOps()
  assertCurrent(context)
  const docId = makeDocId(event)
  const ref = doc(context.db, 'families', context.familyId, 'events', docId)
  try {
    const batch = writeBatch(context.db)
    batch.set(ref, { event })
    assertCurrent(context)
    await batch.commit()
    assertCurrent(context)
    return 'ok'
  } catch (err) {
    // Firestore returns ALREADY_EXISTS (code 6) when a create-only doc already exists
    const code = (err as { code?: number | string }).code
    if (code === 6 || String(code) === 'already-exists') {
      return 'already-exists'
    }
    if (code === ERR_PERMISSION_DENIED || String(code) === ERR_PERMISSION_DENIED) {
      try {
        const snapshot = await getDoc(ref)
        assertCurrent(context)
        if (snapshot.exists() && parseCloudEventDocument(snapshot.id, snapshot.data())) {
          return 'already-exists'
        }
      } catch {
        // Keep as an upload error; pending must survive for retry.
      }
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
async function batchUpload(events: DiaryEvent[], context: SyncContext): Promise<Set<string>> {
  const uploaded = new Set<string>()
  if (events.length === 0) return uploaded
  assertCurrent(context)

  const { doc, writeBatch, getDoc } = await _firestoreOps()
  assertCurrent(context)

  for (let i = 0; i < events.length; i += BATCH_SIZE) {
    const chunk = events.slice(i, i + BATCH_SIZE)
    const batch = writeBatch(context.db)

    for (const event of chunk) {
      const docId = makeDocId(event)
      const ref = doc(context.db, 'families', context.familyId, 'events', docId)
      batch.set(ref, { event })
    }

    try {
      assertCurrent(context)
      await batch.commit()
      assertCurrent(context)
      // Full batch succeeded — all docs in this chunk are uploaded
      for (const event of chunk) uploaded.add(makeDocId(event))
    } catch {
      // F7: batch failed — fall back to per-doc so one poison doc can't block the rest
      for (const event of chunk) {
        const docId = makeDocId(event)
        const result = await uploadOne(event, context)
        if (result === 'ok') {
          uploaded.add(docId)
        } else if (result === 'already-exists') {
          // F6: remote won — fetch it and apply locally, then converge
          let converged = false
          try {
            const ref = doc(context.db, 'families', context.familyId, 'events', docId)
            const remoteSnap = await getDoc(ref)
            assertCurrent(context)
            if (remoteSnap.exists()) {
              const remoteEvent = parseCloudEventDocument(remoteSnap.id, remoteSnap.data())
              if (remoteEvent) {
                _seenFromRemote.add(docId)
                const appendResult = await ipc.appendEvent(remoteEvent)
                assertCurrent(context)
                converged = appendResult !== 'error'
                  && canonicalEventJson(remoteEvent) === canonicalEventJson(event)
              }
            }
          } catch {
            // Do not clear pending until the immutable remote doc is confirmed locally.
          }
          if (converged) uploaded.add(docId)
        }
        // 'error' docs: NOT added to uploaded → drain keeps them in pending for retry
      }
    }
  }

  return uploaded
}

/** 업로드 큐 드레인 */
async function drainQueue(context: SyncContext): Promise<void> {
  if (!contextIsCurrent(context)) return

  const now = Date.now()
  if (_babyInfoNeedsRetry && _babyInfoNextRetry <= now) {
    try {
      await runBabyInfoReconcile(context)
      assertCurrent(context)
    } catch (error) {
      if (error instanceof StaleSyncOperationError || !contextIsCurrent(context)) return
      _babyInfoNeedsRetry = true
      _babyInfoRetryAttempts += 1
      const backoff = Math.min(
        BASE_BACKOFF_MS * Math.pow(2, _babyInfoRetryAttempts - 1),
        MAX_BACKOFF_MS,
      )
      _babyInfoNextRetry = Date.now() + backoff
      syncPendingCount()
      scheduleRetry()
    }
  }

  const ready = _pending.filter(p => p.nextRetry <= now)
  if (ready.length === 0) {
    if (_pending.length > 0 || _babyInfoNeedsRetry) scheduleRetry()
    return
  }

  const toUpload = ready.map(p => p.event)

  try {
    // P2: batchUpload now returns only the set of docIds that succeeded or converged.
    // We filter _pending by that set so partial-failure docs stay for retry.
    const uploadedIds = await batchUpload(toUpload, context)
    assertCurrent(context)
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
    if (totalPendingCount() === 0) {
      setState({
        status: 'online',
        detail: _currentUser?.email ? `${_currentUser.email} connected` : 'connected',
        pendingCount: 0,
      })
    } else {
      scheduleRetry()
    }
  } catch (error) {
    if (error instanceof StaleSyncOperationError || !contextIsCurrent(context)) return
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

  const retryTimes = _pending.map(p => p.nextRetry)
  if (_babyInfoNeedsRetry) retryTimes.push(_babyInfoNextRetry)
  if (_connectionNeedsRetry) retryTimes.push(_connectionNextRetry)
  const nextRetry = retryTimes.length > 0
    ? Math.min(...retryTimes)
    : Date.now() + 30_000

  const delay = Math.max(nextRetry - Date.now(), 1_000)

  const generation = _generation
  _retryTimer = setTimeout(() => {
    _retryTimer = null
    if (generation !== _generation) return
    if (_connectionNeedsRetry && _connectionNextRetry <= Date.now() && _db && _currentUser) {
      const context: AuthContext = {
        generation,
        db: _db,
        user: _currentUser,
      }
      runDetached(() => onUserSignedIn(context), 'connection retry')
      return
    }
    const context = currentContext()
    if (context && (_state.status === 'online' || _state.status === 'error')) {
      runDetached(() => drainQueue(context), 'pending retry')
    }
  }, delay)
}


