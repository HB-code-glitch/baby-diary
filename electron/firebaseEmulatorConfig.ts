import type { FirebaseEmulatorBridge } from '../shared/types'

export const FIREBASE_EMULATOR_PROJECT_ID = 'demo-baby-diary' as const
export const FIREBASE_AUTH_EMULATOR_PORT = 9099
export const FIRESTORE_EMULATOR_PORT = 8080
export const FIREBASE_EMULATOR_CONFIG = Object.freeze({
  apiKey: 'demo-api-key',
  authDomain: 'demo-baby-diary.firebaseapp.com',
  projectId: FIREBASE_EMULATOR_PROJECT_ID,
  storageBucket: 'demo-baby-diary.appspot.com',
  messagingSenderId: '123456789',
  appId: '1:123456789:web:sync-e2e',
})

type Environment = Readonly<Record<string, string | undefined>>

function invalid(reason: string): FirebaseEmulatorBridge {
  return { enabled: false, reason }
}

function parseEndpoint(
  value: string | undefined,
  label: string,
  expectedPort: number,
): { host: string; port: number } | { error: string } {
  if (!value) return { error: `${label} is required` }

  const match = /^([A-Za-z0-9.-]+):(\d+)$/.exec(value)
  if (!match) return { error: `${label} must use host:port without a URL scheme` }

  const rawHost = match[1].toLowerCase()
  if (rawHost !== '127.0.0.1' && rawHost !== 'localhost') {
    return { error: `${label} must use a loopback host` }
  }

  const port = Number(match[2])
  if (port !== expectedPort) {
    return { error: `${label} must use port ${expectedPort}` }
  }

  return { host: rawHost === 'localhost' ? '127.0.0.1' : rawHost, port }
}

/**
 * Build the renderer-facing emulator bridge from main-process environment.
 * A malformed explicitly requested test setup returns a disabled sentinel so
 * the renderer can fail closed before Firebase initializes.
 */
export function readFirebaseEmulatorBridge(env: Environment): FirebaseEmulatorBridge | null {
  if (!env.BABYDIARY_TEST_USERDATA) return null

  const requested = env.BABYDIARY_FIREBASE_EMULATOR
  if (requested == null || requested === '') {
    return invalid('Isolated test userData requires the Firebase emulator')
  }
  if (requested !== '1') return invalid('BABYDIARY_FIREBASE_EMULATOR must be 1')

  if (env.BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID !== FIREBASE_EMULATOR_PROJECT_ID) {
    return invalid(`Firebase emulator project must be ${FIREBASE_EMULATOR_PROJECT_ID}`)
  }

  const auth = parseEndpoint(
    env.FIREBASE_AUTH_EMULATOR_HOST,
    'FIREBASE_AUTH_EMULATOR_HOST',
    FIREBASE_AUTH_EMULATOR_PORT,
  )
  if ('error' in auth) return invalid(auth.error)

  const firestore = parseEndpoint(
    env.FIRESTORE_EMULATOR_HOST,
    'FIRESTORE_EMULATOR_HOST',
    FIRESTORE_EMULATOR_PORT,
  )
  if ('error' in firestore) return invalid(firestore.error)

  return {
    enabled: true,
    projectId: FIREBASE_EMULATOR_PROJECT_ID,
    firebaseConfig: { ...FIREBASE_EMULATOR_CONFIG },
    authHost: auth.host,
    authPort: FIREBASE_AUTH_EMULATOR_PORT,
    firestoreHost: firestore.host,
    firestorePort: FIRESTORE_EMULATOR_PORT,
  }
}
