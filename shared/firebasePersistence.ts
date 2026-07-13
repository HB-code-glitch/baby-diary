import type { AppSettings } from './types'

export type FirebaseConfig = NonNullable<AppSettings['firebase']>

export const FIREBASE_CONFIG_FIELDS = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
] as const

export const LEGACY_FIREBASE_APP_NAME = 'baby-diary'
const DIGEST_APP_NAME_PATTERN = /^baby-diary-[a-f0-9]{64}$/
const MAX_FIREBASE_CONFIG_VALUE_LENGTH = 4_096

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export interface FirebasePersistenceIdentity {
  configIdentity: string
  appName: string
  authUserKey: string
  firestorePersistenceKey: string
}

export interface FirebasePersistenceClaim {
  version: 1
  configIdentity: string
  appName: string
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index])
}

/** Strictly validate an IPC/config value; callers never trust renderer fingerprints. */
export function parseFirebaseConfig(value: unknown): FirebaseConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, FIREBASE_CONFIG_FIELDS)) {
    throw new Error('Firebase configuration shape is invalid')
  }
  for (const field of FIREBASE_CONFIG_FIELDS) {
    const item = value[field]
    if (typeof item !== 'string'
      || item.length === 0
      || item.length > MAX_FIREBASE_CONFIG_VALUE_LENGTH
      || item.includes('\0')) {
      throw new Error(`Firebase configuration field ${field} is invalid`)
    }
  }
  return Object.fromEntries(
    FIREBASE_CONFIG_FIELDS.map(field => [field, value[field]]),
  ) as unknown as FirebaseConfig
}

export function canonicalFirebaseConfig(configValue: unknown): string {
  const config = parseFirebaseConfig(configValue)
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

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

/** Browser/main-identical synchronous SHA-256 used only for public config identities. */
export function sha256Hex(value: string): string {
  const input = new TextEncoder().encode(value)
  const bitLength = input.byteLength * 8
  const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(input)
  padded[input.byteLength] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)

  const state = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ])
  const words = new Uint32Array(64)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false)
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15]
      const right = words[index - 2]
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3)
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10)
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
    }

    let a = state[0]
    let b = state[1]
    let c = state[2]
    let d = state[3]
    let e = state[4]
    let f = state[5]
    let g = state[6]
    let h = state[7]

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temporary1 = (h + sum1 + choose + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temporary2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temporary1) >>> 0
      d = c
      c = b
      b = a
      a = (temporary1 + temporary2) >>> 0
    }

    state[0] = (state[0] + a) >>> 0
    state[1] = (state[1] + b) >>> 0
    state[2] = (state[2] + c) >>> 0
    state[3] = (state[3] + d) >>> 0
    state[4] = (state[4] + e) >>> 0
    state[5] = (state[5] + f) >>> 0
    state[6] = (state[6] + g) >>> 0
    state[7] = (state[7] + h) >>> 0
  }

  return Array.from(state).map(word => word.toString(16).padStart(8, '0')).join('')
}

/** The pre-release FNV namespace is diagnostic only and is never selected for new writes. */
export function getUnreleasedFNVFirebaseAppName(configValue: unknown): string {
  const configIdentity = canonicalFirebaseConfig(configValue)
  const digest = fnv1a32(configIdentity, 0x811c9dc5)
    + fnv1a32(configIdentity.split('').reverse().join(''), 0x9e3779b9)
  return `${LEGACY_FIREBASE_APP_NAME}-${digest}`
}

/** Collision-resistant namespace for every non-legacy profile. */
export function getDigestFirebasePersistenceIdentity(
  configValue: unknown,
): FirebasePersistenceIdentity {
  const config = parseFirebaseConfig(configValue)
  const configIdentity = canonicalFirebaseConfig(config)
  const digest = sha256Hex(configIdentity)
  const appName = `${LEGACY_FIREBASE_APP_NAME}-${digest}`
  return {
    configIdentity,
    appName,
    authUserKey: `firebase:authUser:${config.apiKey}:${appName}`,
    firestorePersistenceKey: appName,
  }
}

export function getFirebasePersistenceIdentityForApp(
  configValue: unknown,
  appName: string,
): FirebasePersistenceIdentity {
  const config = parseFirebaseConfig(configValue)
  const digest = getDigestFirebasePersistenceIdentity(config)
  if (appName !== LEGACY_FIREBASE_APP_NAME && appName !== digest.appName) {
    throw new Error('Firebase persistence claim app name is invalid for configuration')
  }
  return {
    configIdentity: digest.configIdentity,
    appName,
    authUserKey: `firebase:authUser:${config.apiKey}:${appName}`,
    firestorePersistenceKey: appName,
  }
}

export function parseFirebasePersistenceClaim(
  value: unknown,
  configValue: unknown,
): FirebasePersistenceClaim {
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['version', 'configIdentity', 'appName'])
    || value.version !== 1
    || typeof value.configIdentity !== 'string'
    || typeof value.appName !== 'string') {
    throw new Error('Firebase persistence claim response is invalid')
  }
  const identity = getFirebasePersistenceIdentityForApp(configValue, value.appName)
  if (value.configIdentity !== identity.configIdentity
    || (value.appName !== LEGACY_FIREBASE_APP_NAME
      && !DIGEST_APP_NAME_PATTERN.test(value.appName))) {
    throw new Error('Firebase persistence claim does not match configuration')
  }
  return {
    version: 1,
    configIdentity: identity.configIdentity,
    appName: identity.appName,
  }
}
