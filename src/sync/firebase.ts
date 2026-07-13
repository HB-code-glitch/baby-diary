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

const APP_NAME = 'baby-diary'

let _app: FirebaseApp | null = null
let _db: Firestore | null = null
let _auth: Auth | null = null

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
  config: FirebaseConfig | null
): Promise<{ db: Firestore; auth: Auth } | null> {
  if (!config) {
    return null
  }

  // 이미 동일 projectId로 초기화되어 있으면 재사용
  if (_app && _db && _auth) {
    return { db: _db, auth: _auth }
  }

  // Dynamic imports — firebase chunk is loaded on demand
  const { initializeApp, getApps, deleteApp } = await import('firebase/app')
  const {
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
  } = await import('firebase/firestore')
  const {
    getAuth,
    setPersistence,
    browserLocalPersistence,
  } = await import('firebase/auth')

  // 기존 앱이 있으면 삭제 후 재생성 (설정 변경 시)
  const existing = getApps().find(a => a.name === APP_NAME)
  if (existing) {
    await deleteApp(existing)
  }

  const app = initializeApp(config, APP_NAME)

  // Electron renderer에서는 IndexedDB 기반 persistentLocalCache 사용
  // 오프라인에서도 캐시된 데이터 읽기/쓰기 가능
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  })

  const auth = getAuth(app)

  // Make session restoration deterministic across macOS and Windows.
  // Do not expose a half-initialized auth instance if persistence setup fails.
  try {
    await setPersistence(auth, browserLocalPersistence)
  } catch (error) {
    await deleteApp(app).catch(() => undefined)
    throw error
  }

  _app = app
  _db = db
  _auth = auth

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
  if (_app) {
    const { deleteApp } = await import('firebase/app')
    await deleteApp(_app)
  }
  _app = null
  _db = null
  _auth = null
}
