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
import type { Firestore } from 'firebase/firestore'
import type {
  Auth,
  UserCredential,
} from 'firebase/auth'
import type { AppSettings } from '../../shared/types'
import { ipc } from '../lib/ipc'

const APP_NAME_PREFIX = 'baby-diary'
const EMULATOR_CONNECTED = Symbol.for('baby-diary.firebase.emulator-connected')
const FIREBASE_SERVICE_REGISTRY = Symbol.for('baby-diary.firebase.service-registry.v1')
const MAX_REGISTRY_ENTRIES = 4

export type FirebaseConfig = NonNullable<AppSettings['firebase']>

const FIREBASE_CONFIG_FIELDS = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
] as const

interface FirebaseLease {
  id: number
  configIdentity: string
  ownerToken: string
}

interface FirebaseCleanupTask {
  epoch: number
  started: boolean
  promise: Promise<void>
}

interface FirebaseServiceEntry {
  configIdentity: string
  config: FirebaseConfig
  appName: string
  epoch: number
  app: FirebaseApp | null
  db: Firestore | null
  auth: Auth | null
  initialized: boolean
  initPromise: Promise<void> | null
  cleanupTask: FirebaseCleanupTask | null
  terminationAttempted: boolean
  terminated: boolean
  cleanupError: unknown | null
  cleanupErrorReported: boolean
}

interface FirebaseServiceRegistry {
  version: 1
  entries: Map<string, FirebaseServiceEntry>
  activeLease: FirebaseLease | null
  requestedLease: FirebaseLease | null
  nextLeaseId: number
}

type FirebaseService = { db: Firestore; auth: Auth }
type FirebaseEmulator = Awaited<ReturnType<typeof ipc.getFirebaseEmulator>>
type UsableFirebaseServiceEntry = FirebaseServiceEntry & {
  app: FirebaseApp
  db: Firestore
  auth: Auth
}

let _lease: FirebaseLease | null = null
let _localRequestVersion = 0
let _pendingConfigIdentity: string | null = null

export function canonicalFirebaseConfig(config: FirebaseConfig): string {
  return JSON.stringify(Object.fromEntries(
    FIREBASE_CONFIG_FIELDS.map(field => [field, config[field]]),
  ))
}

function fnv1a32(value: string, seed: number): string {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Stable inputs used by the installed Auth and Firestore persistence-key schemes. */
export function getFirebasePersistenceIdentity(config: FirebaseConfig): {
  appName: string
  authUserKey: string
  firestorePersistenceKey: string
} {
  const canonical = canonicalFirebaseConfig(config)
  const digest = fnv1a32(canonical, 0x811c9dc5)
    + fnv1a32([...canonical].reverse().join(''), 0x9e3779b9)
  const appName = `${APP_NAME_PREFIX}-${digest}`
  return {
    appName,
    authUserKey: `firebase:authUser:${config.apiKey}:${appName}`,
    firestorePersistenceKey: appName,
  }
}

function existingAppMatchesConfig(app: FirebaseApp, config: FirebaseConfig): boolean {
  const options = app.options as Partial<Record<(typeof FIREBASE_CONFIG_FIELDS)[number], unknown>>
  return FIREBASE_CONFIG_FIELDS.every(field => options[field] === config[field])
}

function getServiceRegistry(): FirebaseServiceRegistry {
  const host = globalThis as unknown as Record<PropertyKey, unknown>
  const existing = host[FIREBASE_SERVICE_REGISTRY] as Partial<FirebaseServiceRegistry> | undefined
  if (existing?.version === 1 && existing.entries instanceof Map) {
    return existing as FirebaseServiceRegistry
  }

  const registry: FirebaseServiceRegistry = {
    version: 1,
    entries: new Map(),
    activeLease: null,
    requestedLease: null,
    nextLeaseId: 0,
  }
  host[FIREBASE_SERVICE_REGISTRY] = registry
  return registry
}

function entryIsUsable(entry: FirebaseServiceEntry): entry is UsableFirebaseServiceEntry {
  return entry.initialized
    && entry.app !== null
    && entry.db !== null
    && entry.auth !== null
    && !entry.terminationAttempted
    && !entry.terminated
    && entry.cleanupError === null
    && entry.cleanupTask?.started !== true
}

function entryCanTakeLease(entry: FirebaseServiceEntry): boolean {
  return !entry.terminationAttempted
    && !entry.terminated
    && entry.cleanupError === null
    && entry.cleanupTask?.started !== true
}

function currentModuleEntry(): UsableFirebaseServiceEntry | null {
  if (!_lease) return null
  const registry = getServiceRegistry()
  if (registry.activeLease?.id !== _lease.id) return null
  const entry = registry.entries.get(_lease.configIdentity)
  return entry && entryIsUsable(entry) ? entry : null
}

function requestedLeaseFor(
  registry: FirebaseServiceRegistry,
  configIdentity: string,
): FirebaseLease | null {
  return registry.requestedLease?.configIdentity === configIdentity
    ? registry.requestedLease
    : null
}

function canCleanupEntry(
  registry: FirebaseServiceRegistry,
  entry: FirebaseServiceEntry,
  task: FirebaseCleanupTask,
): boolean {
  return registry.entries.get(entry.configIdentity) === entry
    && entry.epoch === task.epoch
    && registry.activeLease?.configIdentity !== entry.configIdentity
}

async function executeEntryCleanup(
  registry: FirebaseServiceRegistry,
  entry: FirebaseServiceEntry,
  task: FirebaseCleanupTask,
): Promise<void> {
  const inflight = entry.initPromise
  if (inflight) await inflight.catch(() => undefined)

  const [{ deleteApp }, { terminate }] = await Promise.all([
    import('firebase/app'),
    import('firebase/firestore'),
  ])

  if (entry.db && !entry.terminated) {
    // No await is allowed between this epoch/lease check and the destructive call.
    if (!canCleanupEntry(registry, entry, task)) return
    task.started = true
    entry.terminationAttempted = true
    await terminate(entry.db)
    entry.terminated = true
  }

  if (entry.app) {
    // Reactivation during terminate invalidates this task before deleteApp.
    if (!canCleanupEntry(registry, entry, task)) return
    task.started = true
    await deleteApp(entry.app)

    // deleteApp has already completed. A lease requested while it was in flight
    // must recreate; retaining this entry would attempt to delete the same app twice.
    entry.app = null
    entry.db = null
    entry.auth = null
    entry.initialized = false
    entry.terminationAttempted = false
    entry.terminated = false
    entry.cleanupError = null
    entry.cleanupErrorReported = false
    if (registry.entries.get(entry.configIdentity) === entry) {
      registry.entries.delete(entry.configIdentity)
    }
    return
  }

  if (!canCleanupEntry(registry, entry, task)) return
  entry.app = null
  entry.db = null
  entry.auth = null
  entry.initialized = false
  entry.terminationAttempted = false
  entry.terminated = false
  entry.cleanupError = null
  entry.cleanupErrorReported = false
  registry.entries.delete(entry.configIdentity)
}

function scheduleEntryCleanup(
  registry: FirebaseServiceRegistry,
  entry: FirebaseServiceEntry,
): Promise<void> {
  if (entry.cleanupTask) return entry.cleanupTask.promise

  const task: FirebaseCleanupTask = {
    epoch: entry.epoch,
    started: false,
    promise: Promise.resolve(),
  }
  const promise = (async () => {
    try {
      await executeEntryCleanup(registry, entry, task)
    } catch (error) {
      entry.cleanupError = error
      entry.cleanupErrorReported = false
      throw error
    } finally {
      if (entry.cleanupTask === task) entry.cleanupTask = null
    }
  })()
  task.promise = promise
  entry.cleanupTask = task
  // Config replacement intentionally runs cleanup in the background. Keep the
  // rejection observable through the retained entry and a later teardown.
  void promise.catch(() => undefined)
  return promise
}

function releaseLease(
  registry: FirebaseServiceRegistry,
  lease: FirebaseLease,
): Promise<void> | null {
  let cleanup: Promise<void> | null = null
  if (registry.activeLease?.id === lease.id) {
    registry.activeLease = null
    const entry = registry.entries.get(lease.configIdentity)
    if (entry) cleanup = scheduleEntryCleanup(registry, entry)
  }
  if (registry.requestedLease?.id === lease.id) {
    registry.requestedLease = null
  }
  return cleanup
}

function beginLease(
  registry: FirebaseServiceRegistry,
  configIdentity: string,
  ownerToken: string,
): FirebaseLease {
  const lease: FirebaseLease = {
    id: ++registry.nextLeaseId,
    configIdentity,
    ownerToken,
  }
  const previous = registry.activeLease
  registry.requestedLease = lease

  if (previous) {
    registry.activeLease = null
    if (previous.configIdentity !== configIdentity) {
      const previousEntry = registry.entries.get(previous.configIdentity)
      if (previousEntry) scheduleEntryCleanup(registry, previousEntry)
    }
  }

  const entry = registry.entries.get(configIdentity)
  if (!entry) {
    registry.activeLease = lease
    return lease
  }

  // Every new lease changes the epoch. A task that has not reached terminate
  // is canceled; a task already terminating must finish/cancel and be recreated.
  entry.epoch += 1
  if (entryCanTakeLease(entry)) registry.activeLease = lease
  return lease
}

function activateLatestLease(
  registry: FirebaseServiceRegistry,
  entry: FirebaseServiceEntry,
): FirebaseLease | null {
  const requested = requestedLeaseFor(registry, entry.configIdentity)
  if (!requested || !entryCanTakeLease(entry)) return null
  if (registry.activeLease?.id !== requested.id) {
    entry.epoch += 1
    registry.activeLease = requested
  }
  return requested
}

async function initializeEntry(
  entry: FirebaseServiceEntry,
  emulator: FirebaseEmulator,
): Promise<void> {
  const { initializeApp, getApps } = await import('firebase/app')
  const {
    getFirestore,
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager,
    connectFirestoreEmulator,
  } = await import('firebase/firestore')
  const {
    getAuth,
    connectAuthEmulator,
  } = await import('firebase/auth')

  const existing = getApps().find(app => app.name === entry.appName)
  if (existing && !existingAppMatchesConfig(existing, entry.config)) {
    throw new Error('deterministic Firebase app-name collision')
  }

  const app = existing ?? initializeApp(entry.config, entry.appName)
  entry.app = app
  const db = existing
    ? getFirestore(app)
    : initializeFirestore(app, {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      })
  entry.db = db
  const auth = getAuth(app)
  entry.auth = auth

  if (emulator?.enabled && !(app as FirebaseApp & { [EMULATOR_CONNECTED]?: boolean })[EMULATOR_CONNECTED]) {
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
    ;(app as FirebaseApp & { [EMULATOR_CONNECTED]?: boolean })[EMULATOR_CONNECTED] = true
  }

  entry.initialized = true
}

async function waitForEntryInitialization(
  entry: FirebaseServiceEntry,
  emulator: FirebaseEmulator,
): Promise<void> {
  if (entryIsUsable(entry)) return
  if (!entry.initPromise) {
    entry.initPromise = initializeEntry(entry, emulator)
    void entry.initPromise.catch(() => undefined)
  }
  const inflight = entry.initPromise
  try {
    await inflight
  } finally {
    if (entry.initPromise === inflight) entry.initPromise = null
  }
}

function makeEntry(
  config: FirebaseConfig,
  configIdentity: string,
  appName: string,
): FirebaseServiceEntry {
  return {
    configIdentity,
    config: { ...config },
    appName,
    epoch: 0,
    app: null,
    db: null,
    auth: null,
    initialized: false,
    initPromise: null,
    cleanupTask: null,
    terminationAttempted: false,
    terminated: false,
    cleanupError: null,
    cleanupErrorReported: false,
  }
}

async function retryInactiveFailures(
  registry: FirebaseServiceRegistry,
  targetIdentity: string,
): Promise<void> {
  for (const entry of [...registry.entries.values()]) {
    if (entry.configIdentity === targetIdentity || entry.cleanupError === null) continue
    if (registry.activeLease?.configIdentity === entry.configIdentity) continue
    if (!entry.cleanupErrorReported) {
      entry.cleanupErrorReported = true
      throw entry.cleanupError
    }
    await scheduleEntryCleanup(registry, entry)
  }
}

async function prepareRegistryLease(
  registry: FirebaseServiceRegistry,
  config: FirebaseConfig,
  configIdentity: string,
  appName: string,
  ownerToken: string,
): Promise<{ entry: FirebaseServiceEntry; lease: FirebaseLease }> {
  await retryInactiveFailures(registry, configIdentity)
  const existing = registry.entries.get(configIdentity)
  if (existing) {
    return {
      entry: existing,
      lease: beginLease(registry, configIdentity, ownerToken),
    }
  }

  while (registry.entries.size >= MAX_REGISTRY_ENTRIES) {
    const activeIdentity = registry.activeLease?.configIdentity
    const cleanups = [...registry.entries.values()]
      .filter(entry => entry.configIdentity !== activeIdentity)
      .map(entry => scheduleEntryCleanup(registry, entry))
    if (cleanups.length === 0) break
    const results = await Promise.allSettled(cleanups)
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  if (registry.entries.size >= MAX_REGISTRY_ENTRIES) {
    throw new Error('Firebase service registry capacity exhausted by inactive cleanup')
  }

  const entry = makeEntry(config, configIdentity, appName)
  registry.entries.set(configIdentity, entry)
  return {
    entry,
    lease: beginLease(registry, configIdentity, ownerToken),
  }
}

async function cleanupFailedInitialization(
  registry: FirebaseServiceRegistry,
  entry: FirebaseServiceEntry,
  initializationError: unknown,
): Promise<never> {
  if (registry.activeLease?.configIdentity === entry.configIdentity) {
    registry.activeLease = null
  }
  if (registry.requestedLease?.configIdentity === entry.configIdentity) {
    registry.requestedLease = null
  }

  try {
    await scheduleEntryCleanup(registry, entry)
  } catch (cleanupError) {
    entry.cleanupErrorReported = true
    const initMessage = initializationError instanceof Error
      ? initializationError.message
      : String(initializationError)
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
    throw new Error(`Firebase initialization failed: ${initMessage}; cleanup failed: ${cleanupMessage}`)
  }
  throw initializationError
}

async function acquireLeaseService(
  registry: FirebaseServiceRegistry,
  preparedEntry: FirebaseServiceEntry,
  emulator: FirebaseEmulator,
): Promise<FirebaseService | null> {
  let entry = preparedEntry

  while (requestedLeaseFor(registry, entry.configIdentity)) {
    if (entry.cleanupTask) {
      await entry.cleanupTask.promise.catch(() => undefined)
      const retained = registry.entries.get(entry.configIdentity)
      if (!retained) {
        entry = makeEntry(entry.config, entry.configIdentity, entry.appName)
        registry.entries.set(entry.configIdentity, entry)
      } else {
        entry = retained
      }
      continue
    }

    if (entry.cleanupError !== null && !entry.cleanupErrorReported) {
      entry.cleanupErrorReported = true
      if (registry.requestedLease?.configIdentity === entry.configIdentity) {
        registry.requestedLease = null
      }
      throw entry.cleanupError
    }

    if (entry.terminationAttempted || entry.terminated || entry.cleanupError !== null) {
      if (registry.activeLease?.configIdentity === entry.configIdentity) {
        registry.activeLease = null
      }
      await scheduleEntryCleanup(registry, entry)
      const retained = registry.entries.get(entry.configIdentity)
      if (!retained) {
        entry = makeEntry(entry.config, entry.configIdentity, entry.appName)
        registry.entries.set(entry.configIdentity, entry)
      } else {
        entry = retained
      }
      continue
    }

    if (!activateLatestLease(registry, entry)) return null

    try {
      await waitForEntryInitialization(entry, emulator)
    } catch (error) {
      return cleanupFailedInitialization(registry, entry, error)
    }

    if (!requestedLeaseFor(registry, entry.configIdentity)) return null
    if (entryIsUsable(entry)) return { db: entry.db, auth: entry.auth }
  }

  return null
}

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
): Promise<FirebaseService | null> {
  if (!config) return null
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ownerToken)) {
    throw new Error('invalid Firebase owner token')
  }

  const configIdentity = canonicalFirebaseConfig(config)
  const identity = getFirebasePersistenceIdentity(config)
  const requestVersion = ++_localRequestVersion
  _pendingConfigIdentity = configIdentity

  const current = currentModuleEntry()
  if (current?.configIdentity === configIdentity) {
    return { db: current.db, auth: current.auth }
  }

  // Validate the renderer-provided emulator profile before releasing a working lease.
  const emulator = await ipc.getFirebaseEmulator()
  if (requestVersion !== _localRequestVersion && _pendingConfigIdentity !== configIdentity) return null
  if (emulator && !emulator.enabled) {
    throw new Error(`Firebase emulator configuration rejected: ${emulator.reason}`)
  }
  if (emulator?.enabled && config.projectId !== emulator.projectId) {
    throw new Error(
      `Firebase emulator requires project ${emulator.projectId}; received ${config.projectId}`,
    )
  }

  const registry = getServiceRegistry()
  const prepared = await prepareRegistryLease(
    registry,
    config,
    configIdentity,
    identity.appName,
    ownerToken,
  )
  const { entry, lease } = prepared
  if (requestVersion !== _localRequestVersion && _pendingConfigIdentity !== configIdentity) {
    releaseLease(registry, lease)
    return null
  }

  _lease = lease

  try {
    const service = await acquireLeaseService(registry, entry, emulator)
    if (!service) return null
    return service
  } catch (error) {
    if (_lease?.id === lease.id) {
      _lease = null
    }
    throw error
  }
}

/** 현재 초기화된 Firestore 인스턴스 반환 (없으면 null) */
export function getDb(): Firestore | null {
  const entry = currentModuleEntry()
  return entry?.db ?? null
}

/** 현재 초기화된 Auth 인스턴스 반환 (없으면 null) */
export function getFirebaseAuth(): Auth | null {
  const entry = currentModuleEntry()
  return entry?.auth ?? null
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
  ++_localRequestVersion
  _pendingConfigIdentity = null
  const registry = getServiceRegistry()
  const lease = _lease
  _lease = null

  const cleanups = new Map<Promise<void>, FirebaseServiceEntry>()
  const observedErrors: unknown[] = []
  if (lease) {
    const releasedEntry = registry.entries.get(lease.configIdentity)
    const released = releaseLease(registry, lease)
    if (released && releasedEntry) cleanups.set(released, releasedEntry)
  }

  for (const entry of [...registry.entries.values()]) {
    if (registry.activeLease?.configIdentity === entry.configIdentity) continue
    if (entry.cleanupTask) {
      cleanups.set(entry.cleanupTask.promise, entry)
    } else if (entry.cleanupError !== null) {
      if (!entry.cleanupErrorReported) {
        entry.cleanupErrorReported = true
        observedErrors.push(entry.cleanupError)
      } else {
        cleanups.set(scheduleEntryCleanup(registry, entry), entry)
      }
    }
  }

  const cleanupList = [...cleanups.entries()]
  const results = await Promise.allSettled(cleanupList.map(([cleanup]) => cleanup))
  let cleanupFailure: unknown | null = null
  results.forEach((result, index) => {
    if (result.status !== 'rejected') return
    const entry = cleanupList[index]?.[1]
    if (entry?.cleanupError !== null) entry.cleanupErrorReported = true
    cleanupFailure ??= result.reason
  })
  if (observedErrors.length > 0) throw observedErrors[0]
  if (cleanupFailure !== null) throw cleanupFailure
}
