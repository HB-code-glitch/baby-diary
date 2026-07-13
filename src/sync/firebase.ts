/**
 * src/sync/firebase.ts
 * Firebase 앱 지연 초기화 (lazy init).
 * 설정이 없으면 sync는 off 상태, 앱의 나머지 기능은 로컬 모드로 동작.
 *
 * PERF: All firebase/* modules are dynamically imported inside initFirebase()
 * so that the firebase chunk is never pulled into the main bundle.
 * Type-only imports are used at the module level to keep TypeScript happy.
 */
import type { FirebaseApp } from 'firebase/app'
import type {
  Firestore,
} from 'firebase/firestore'
import type {
  Auth,
  UserCredential,
} from 'firebase/auth'
import { AppSettings } from '../../shared/types'
import { ipc } from '../lib/ipc'

const APP_NAME = 'baby-diary'
const OWNED_APP_SESSION = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

let _app: FirebaseApp | null = null
let _db: Firestore | null = null
let _auth: Auth | null = null
let _ownerToken: string | null = null
let _requestVersion = 0

export type FirebaseConfig = NonNullable<AppSettings['firebase']>

/**
 * 설정이 있으면 Firebase 앱을 초기화하고 { db, auth }를 반환.
 * 같은 설정으로 이미 초기화된 경우 기존 인스턴스를 재사용.
 * 설정이 null이면 null 반환 → 호출자가 로컬 모드로 처리.
 *
 * Dynamic import keeps firebase/* out of the initial JS bundle — the chunk
 * is fetched only when this function is first called (after first paint).
 */
export async function initFirebase(
  config: FirebaseConfig | null,
  ownerToken = 'default',
): Promise<{ db: Firestore; auth: Auth } | null> {
  if (!config) {
    return null
  }

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ownerToken)) {
    throw new Error('invalid Firebase owner token')
  }

  // 이미 동일 projectId로 초기화되어 있으면 재사용
  if (_app && _db && _auth && _ownerToken === ownerToken) {
    return { db: _db, auth: _auth }
  }

  const requestVersion = ++_requestVersion
  const appName = ownerToken === 'default'
    ? APP_NAME
    : `${APP_NAME}-${OWNED_APP_SESSION}-${ownerToken}`

  // The main process exposes emulator endpoints only for an explicitly
  // isolated E2E profile. Validate before initializeApp so a malformed test
  // configuration can never fall through to production Firebase.
  const emulator = await ipc.getFirebaseEmulator()
  if (requestVersion !== _requestVersion) return null
  if (emulator && !emulator.enabled) {
    throw new Error(`Firebase emulator configuration rejected: ${emulator.reason}`)
  }
  if (emulator?.enabled && config.projectId !== emulator.projectId) {
    throw new Error(
      `Firebase emulator requires project ${emulator.projectId}; received ${config.projectId}`,
    )
  }

  // Dynamic imports — firebase chunk is loaded on demand
  const { initializeApp, getApps, deleteApp } = await import('firebase/app')
  const {
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    connectFirestoreEmulator,
  } = await import('firebase/firestore')
  const {
    getAuth,
    connectAuthEmulator,
  } = await import('firebase/auth')
  if (requestVersion !== _requestVersion) return null

  // 기존 앱이 있으면 삭제 후 재생성 (설정 변경 시)
  const existing = getApps().find(a => a.name === appName)
  if (existing) {
    await deleteApp(existing)
    if (requestVersion !== _requestVersion) return null
  }

  const app = initializeApp(config, appName)

  // Electron renderer에서는 IndexedDB 기반 persistentLocalCache 사용
  // 오프라인에서도 캐시된 데이터 읽기/쓰기 가능
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  })

  const auth = getAuth(app)

  // Emulator connectors must run before any Auth/Firestore operation. Keep
  // setup atomic so a connector failure cannot leave a cached half-initialized
  // app behind. Auth persistence is selected only immediately before a new
  // sign-in/sign-up, preserving any session Firebase restored here.
  try {
    if (emulator?.enabled) {
      connectAuthEmulator(
        auth,
        `http://${emulator.authHost}:${emulator.authPort}`,
        { disableWarnings: true },
      )
      connectFirestoreEmulator(
        db,
        emulator.firestoreHost,
        emulator.firestorePort,
      )
    }
  } catch (error) {
    await deleteApp(app).catch(() => undefined)
    throw error
  }

  if (requestVersion !== _requestVersion) {
    void deleteApp(app).catch(() => undefined)
    return null
  }

  const previousApp = _app
  _app = app
  _db = db
  _auth = auth
  _ownerToken = ownerToken
  if (previousApp && previousApp !== app) {
    void deleteApp(previousApp).catch(() => undefined)
  }

  return { db: _db, auth: _auth }
}

/** 현재 초기화된 Firestore 인스턴스 반환 (없으면 null) */
export function getDb(): Firestore | null {
  return _db
}

/** 현재 초기화된 Auth 인스턴스 반환 (없으면 null) */
export function getFirebaseAuth(): Auth | null {
  return _auth
}

/** Firebase 이메일/비밀번호 로그인 */
export async function fbSignIn(
  auth: Auth,
  email: string,
  password: string,
  keepLoggedIn = true,
): Promise<UserCredential> {
  const {
    signInWithEmailAndPassword,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
  } = await import('firebase/auth')
  await setPersistence(
    auth,
    keepLoggedIn ? browserLocalPersistence : browserSessionPersistence,
  )
  return signInWithEmailAndPassword(auth, email, password)
}

/** Firebase 이메일/비밀번호 회원가입 */
export async function fbSignUp(
  auth: Auth,
  email: string,
  password: string,
  keepLoggedIn = true,
): Promise<UserCredential> {
  const {
    createUserWithEmailAndPassword,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
  } = await import('firebase/auth')
  await setPersistence(
    auth,
    keepLoggedIn ? browserLocalPersistence : browserSessionPersistence,
  )
  return createUserWithEmailAndPassword(auth, email, password)
}

/** Firebase 로그아웃 */
export async function fbSignOut(auth: Auth): Promise<void> {
  const { signOut } = await import('firebase/auth')
  return signOut(auth)
}

/** Firebase 앱 종료 (설정 변경 또는 앱 종료 시) */
export async function teardownFirebase(): Promise<void> {
  ++_requestVersion
  const app = _app
  _app = null
  _db = null
  _auth = null
  _ownerToken = null
  if (app) {
    const { deleteApp } = await import('firebase/app')
    await deleteApp(app)
  }
}
