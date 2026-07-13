import * as fs from 'fs'
import * as path from 'path'
import { createHash, randomUUID } from 'crypto'
import {
  LEGACY_FIREBASE_APP_NAME,
  canonicalFirebaseConfig,
  getDigestFirebasePersistenceIdentity,
  getUnreleasedFNVFirebaseAppName,
  parseFirebaseConfig,
  type FirebaseConfig,
  type FirebasePersistenceClaim,
} from '../../shared/firebasePersistence'
import { DEFAULT_FIREBASE_CONFIG } from '../../shared/defaultFirebaseConfig'
import { writeAllSync } from './durableFs'

export const FIREBASE_PERSISTENCE_REGISTRY_FILE = 'firebase-persistence-registry-v1.json'
const MAX_REGISTRY_BYTES = 64 * 1024
const MAX_SETTINGS_SNAPSHOT_BYTES = 32 * 1024 * 1024
const LEGACY_DIAGNOSTIC = 'preexisting-profile-assumed-v0.3.8; all digest namespaces remain untouched'
const FRESH_DIAGNOSTIC = 'fresh profile retired the legacy namespace before Firebase initialization'

export interface FirebaseProfileEligibilitySnapshot {
  readonly version: 1
  readonly existed: boolean
  readonly kind: 'registry-present' | 'settings-absent' | 'settings-snapshot'
  readonly legacyConfig: FirebaseConfig | null
  readonly settingsEvidenceSha256: string | null
  readonly rootIdentity: RootIdentity
  readonly settingsIdentity: FileIdentity | null
}

export interface FirebasePersistenceRegistryOptions {
  platform?: NodeJS.Platform
  beforePublish?: () => void
  afterPublish?: () => void
  /** Test seam used to prove same-inode rewrites and atomic path swaps fail closed. */
  afterFirstFileRead?: (target: string) => void
}

export interface FirebaseProfileSnapshotOptions {
  platform?: NodeJS.Platform
  beforeRootCreate?: () => void
}

interface RootIdentity {
  requestedPath: string
  realPath: string
  dev: number
  ino: number
  mode: number
  birthtimeMs: number
  // Directory mtime/ctime intentionally excluded: publishing our own candidate changes them.
}

interface LegacyClaimDocument {
  appName: typeof LEGACY_FIREBASE_APP_NAME
  canonicalConfig: string
  canonicalConfigSha256: string
  freshDigestAppName: string
  unreleasedDigestAppName: string
}

interface RegistryDocument {
  version: 1
  classification: 'legacy-v0.3.8-upgrade' | 'fresh-v0.3.9-or-newer'
  diagnostic: typeof LEGACY_DIAGNOSTIC | typeof FRESH_DIAGNOSTIC
  eligibilityEvidence: {
    kind: 'settings-snapshot' | 'settings-absent'
    settingsSha256: string | null
  }
  legacyClaim: LegacyClaimDocument | null
}

interface FileIdentity {
  dev: number
  ino: number
  mode: number
  size: number
  birthtimeMs: number
  mtimeMs: number
  ctimeMs: number
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const expectedSorted = [...expected].sort()
  const actual = Object.keys(value).sort()
  return actual.length === expectedSorted.length
    && actual.every((key, index) => key === expectedSorted[index])
}

function comparablePath(value: string, platform: NodeJS.Platform): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/, '')
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function sameObjectIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.birthtimeMs === right.birthtimeMs
}

function sameStableFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return sameObjectIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

function toFileIdentity(stats: fs.Stats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    birthtimeMs: stats.birthtimeMs,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  }
}

function captureRootIdentity(userDataPath: string, platform: NodeJS.Platform): RootIdentity {
  const requestedPath = path.resolve(userDataPath)
  const stats = fs.lstatSync(requestedPath)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('Firebase registry parent path is a link/reparse point or non-directory')
  }
  const realPath = fs.realpathSync.native(requestedPath)
  if (!path.isAbsolute(realPath)) throw new Error('Firebase registry parent realpath is invalid')
  // Keep both spellings: stable ancestors may be links, but the userData root itself may not change.
  if (comparablePath(path.dirname(realPath), platform).length === 0) {
    throw new Error('Firebase registry parent realpath is invalid')
  }
  return {
    requestedPath,
    realPath,
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    birthtimeMs: stats.birthtimeMs,
  }
}

function ensureUserDataRoot(
  userDataPath: string,
  platform: NodeJS.Platform,
  beforeRootCreate?: () => void,
): void {
  const requestedPath = path.resolve(userDataPath)
  const existing = optionalLstat(requestedPath)
  if (existing) return
  beforeRootCreate?.()
  try {
    fs.mkdirSync(requestedPath, { recursive: true, mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const winner = fs.lstatSync(requestedPath)
  if (winner.isSymbolicLink() || !winner.isDirectory()) {
    throw new Error('Firebase registry parent creation resolved to a link/reparse point or non-directory')
  }
  if (platform !== 'win32') {
    const parentFd = fs.openSync(path.dirname(requestedPath), fs.constants.O_RDONLY)
    try {
      fs.fsyncSync(parentFd)
    } finally {
      fs.closeSync(parentFd)
    }
  }
}

function assertRootIdentity(root: RootIdentity, platform: NodeJS.Platform): void {
  const current = captureRootIdentity(root.requestedPath, platform)
  if (current.dev !== root.dev
    || current.ino !== root.ino
    || current.mode !== root.mode
    || current.birthtimeMs !== root.birthtimeMs
    || comparablePath(current.realPath, platform) !== comparablePath(root.realPath, platform)) {
    throw new Error('Firebase registry parent directory identity changed')
  }
}

function optionalLstat(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function assertPathInsideRoot(
  target: string,
  root: RootIdentity,
  platform: NodeJS.Platform,
): void {
  const real = fs.realpathSync.native(target)
  if (comparablePath(path.dirname(real), platform) !== comparablePath(root.realPath, platform)) {
    throw new Error('Firebase registry file escaped its parent directory')
  }
}

interface StableReadResult {
  bytes: Buffer
  identity: FileIdentity
}

function readExactAt(fd: number, size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const count = fs.readSync(fd, bytes, offset, size - offset, offset)
    if (!Number.isInteger(count) || count <= 0 || count > size - offset) {
      throw new Error('Firebase protected file made no read progress')
    }
    offset += count
  }
  return bytes
}

function readBoundedRegularFile(
  target: string,
  root: RootIdentity,
  platform: NodeJS.Platform,
  maxBytes: number,
  afterFirstRead?: (target: string) => void,
): StableReadResult {
  assertRootIdentity(root, platform)
  const beforeStats = fs.lstatSync(target)
  if (beforeStats.isSymbolicLink() || !beforeStats.isFile()) {
    throw new Error('Firebase registry is a link/reparse point or non-regular file')
  }
  if (!Number.isSafeInteger(beforeStats.size)
    || beforeStats.size <= 0
    || beforeStats.size > maxBytes) {
    throw new Error('Firebase protected file size is invalid')
  }
  assertPathInsideRoot(target, root, platform)

  const noFollow = platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0)
  const fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow)
  let bytes: Buffer
  let openedIdentity: FileIdentity
  try {
    const openedStats = fs.fstatSync(fd)
    openedIdentity = toFileIdentity(openedStats)
    if (!openedStats.isFile()
      || !sameStableFileIdentity(toFileIdentity(beforeStats), openedIdentity)) {
      throw new Error('Firebase protected file identity changed while opening')
    }
    const first = readExactAt(fd, openedStats.size)
    afterFirstRead?.(target)
    const middleIdentity = toFileIdentity(fs.fstatSync(fd))
    const second = readExactAt(fd, openedStats.size)
    const finalIdentity = toFileIdentity(fs.fstatSync(fd))
    if (!sameStableFileIdentity(openedIdentity, middleIdentity)
      || !sameStableFileIdentity(openedIdentity, finalIdentity)
      || !first.equals(second)) {
      throw new Error('Firebase protected file changed while reading')
    }
    bytes = first
  } finally {
    fs.closeSync(fd)
  }

  const afterStats = fs.lstatSync(target)
  if (afterStats.isSymbolicLink()
    || !afterStats.isFile()
    || !sameStableFileIdentity(toFileIdentity(beforeStats), toFileIdentity(afterStats))) {
    throw new Error('Firebase protected file identity changed after reading')
  }
  assertPathInsideRoot(target, root, platform)
  assertRootIdentity(root, platform)
  return { bytes, identity: openedIdentity }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseReleasedSettingsFirebase(bytes: Buffer): FirebaseConfig {
  let value: unknown
  try {
    const raw = bytes.toString('utf8')
    const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    value = JSON.parse(withoutBom)
  } catch {
    throw new Error('Firebase profile settings evidence is invalid')
  }
  if (!isPlainRecord(value)) {
    throw new Error('Firebase profile settings evidence is not an object')
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'firebase') || value.firebase === null) {
    return parseFirebaseConfig(DEFAULT_FIREBASE_CONFIG)
  }
  try {
    return parseFirebaseConfig(value.firebase)
  } catch {
    throw new Error('Firebase profile settings firebase value is invalid')
  }
}

function parseRegistryDocument(bytes: Buffer): RegistryDocument {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('Firebase registry JSON is corrupt')
  }
  if (!isPlainRecord(value)
    || !hasExactKeys(value, [
      'version',
      'classification',
      'diagnostic',
      'eligibilityEvidence',
      'legacyClaim',
    ])
    || value.version !== 1
    || (value.classification !== 'legacy-v0.3.8-upgrade'
      && value.classification !== 'fresh-v0.3.9-or-newer')
    || (value.diagnostic !== LEGACY_DIAGNOSTIC && value.diagnostic !== FRESH_DIAGNOSTIC)) {
    throw new Error('Firebase registry schema is invalid')
  }
  if (!isPlainRecord(value.eligibilityEvidence)
    || !hasExactKeys(value.eligibilityEvidence, ['kind', 'settingsSha256'])
    || (value.eligibilityEvidence.kind !== 'settings-snapshot'
      && value.eligibilityEvidence.kind !== 'settings-absent')
    || (value.eligibilityEvidence.settingsSha256 !== null
      && (typeof value.eligibilityEvidence.settingsSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(value.eligibilityEvidence.settingsSha256)))) {
    throw new Error('Firebase registry eligibility evidence is invalid')
  }

  if (value.classification === 'fresh-v0.3.9-or-newer') {
    if (value.diagnostic !== FRESH_DIAGNOSTIC
      || value.legacyClaim !== null
      || value.eligibilityEvidence.kind !== 'settings-absent'
      || value.eligibilityEvidence.settingsSha256 !== null) {
      throw new Error('Firebase registry fresh classification is inconsistent')
    }
    return {
      version: 1,
      classification: value.classification,
      diagnostic: value.diagnostic,
      eligibilityEvidence: {
        kind: 'settings-absent',
        settingsSha256: null,
      },
      legacyClaim: null,
    }
  }

  if (value.diagnostic !== LEGACY_DIAGNOSTIC
    || value.eligibilityEvidence.kind !== 'settings-snapshot'
    || typeof value.eligibilityEvidence.settingsSha256 !== 'string'
    || !isPlainRecord(value.legacyClaim)
    || !hasExactKeys(value.legacyClaim, [
      'appName',
      'canonicalConfig',
      'canonicalConfigSha256',
      'freshDigestAppName',
      'unreleasedDigestAppName',
    ])) {
    throw new Error('Firebase registry legacy claim schema is invalid')
  }
  const claim = value.legacyClaim
  if (claim.appName !== LEGACY_FIREBASE_APP_NAME
    || typeof claim.canonicalConfig !== 'string'
    || claim.canonicalConfig.length === 0
    || claim.canonicalConfig.length > MAX_REGISTRY_BYTES / 2
    || typeof claim.canonicalConfigSha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(claim.canonicalConfigSha256)
    || typeof claim.freshDigestAppName !== 'string'
    || typeof claim.unreleasedDigestAppName !== 'string') {
    throw new Error('Firebase registry legacy claim value is invalid')
  }

  let config: FirebaseConfig
  try {
    config = parseFirebaseConfig(JSON.parse(claim.canonicalConfig))
  } catch {
    throw new Error('Firebase registry canonical configuration is invalid')
  }
  const canonical = canonicalFirebaseConfig(config)
  if (canonical !== claim.canonicalConfig
    || sha256(canonical) !== claim.canonicalConfigSha256
    || getDigestFirebasePersistenceIdentity(config).appName !== claim.freshDigestAppName
    || getUnreleasedFNVFirebaseAppName(config) !== claim.unreleasedDigestAppName) {
    throw new Error('Firebase registry legacy claim fingerprint is invalid')
  }

  return {
    version: 1,
    classification: value.classification,
    diagnostic: value.diagnostic,
    eligibilityEvidence: {
      kind: 'settings-snapshot',
      settingsSha256: value.eligibilityEvidence.settingsSha256,
    },
    legacyClaim: {
      appName: LEGACY_FIREBASE_APP_NAME,
      canonicalConfig: canonical,
      canonicalConfigSha256: claim.canonicalConfigSha256,
      freshDigestAppName: claim.freshDigestAppName,
      unreleasedDigestAppName: claim.unreleasedDigestAppName,
    },
  }
}

function makeRegistryDocument(snapshot: FirebaseProfileEligibilitySnapshot): RegistryDocument {
  if (snapshot.kind === 'registry-present') {
    throw new Error('Firebase registry disappeared after eligibility snapshot')
  }
  if (snapshot.existed) {
    if (snapshot.kind !== 'settings-snapshot'
      || snapshot.legacyConfig === null
      || snapshot.settingsEvidenceSha256 === null
      || snapshot.settingsIdentity === null) {
      throw new Error('Firebase legacy profile eligibility is inconsistent')
    }
    const config = parseFirebaseConfig(snapshot.legacyConfig)
    const canonicalConfig = canonicalFirebaseConfig(config)
    return {
      version: 1,
      classification: 'legacy-v0.3.8-upgrade',
      diagnostic: LEGACY_DIAGNOSTIC,
      eligibilityEvidence: {
        kind: 'settings-snapshot',
        settingsSha256: snapshot.settingsEvidenceSha256,
      },
      legacyClaim: {
        appName: LEGACY_FIREBASE_APP_NAME,
        canonicalConfig,
        canonicalConfigSha256: sha256(canonicalConfig),
        freshDigestAppName: getDigestFirebasePersistenceIdentity(config).appName,
        unreleasedDigestAppName: getUnreleasedFNVFirebaseAppName(config),
      },
    }
  }
  if (snapshot.kind !== 'settings-absent'
    || snapshot.legacyConfig !== null
    || snapshot.settingsEvidenceSha256 !== null
    || snapshot.settingsIdentity !== null) {
    throw new Error('Firebase fresh profile eligibility is inconsistent')
  }
  return {
    version: 1,
    classification: 'fresh-v0.3.9-or-newer',
    diagnostic: FRESH_DIAGNOSTIC,
    eligibilityEvidence: {
      kind: 'settings-absent',
      settingsSha256: null,
    },
    legacyClaim: null,
  }
}

function sameRootIdentity(left: RootIdentity, right: RootIdentity, platform: NodeJS.Platform): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.birthtimeMs === right.birthtimeMs
    && comparablePath(left.requestedPath, platform) === comparablePath(right.requestedPath, platform)
    && comparablePath(left.realPath, platform) === comparablePath(right.realPath, platform)
}

function verifyEligibilitySnapshot(
  snapshot: FirebaseProfileEligibilitySnapshot,
  root: RootIdentity,
  platform: NodeJS.Platform,
): void {
  if (snapshot.version !== 1 || !sameRootIdentity(snapshot.rootIdentity, root, platform)) {
    throw new Error('Firebase eligibility snapshot parent directory identity changed')
  }
  const settingsPath = path.join(root.requestedPath, 'settings.json')
  if (snapshot.kind === 'registry-present') {
    if (!optionalLstat(path.join(root.requestedPath, FIREBASE_PERSISTENCE_REGISTRY_FILE))) {
      throw new Error('Firebase registry disappeared after eligibility snapshot')
    }
    return
  }
  if (snapshot.kind === 'settings-absent') {
    if (optionalLstat(settingsPath)) {
      throw new Error('Firebase settings appeared after fresh eligibility snapshot')
    }
    return
  }
  if (!snapshot.settingsIdentity
    || !snapshot.settingsEvidenceSha256
    || !snapshot.legacyConfig) {
    throw new Error('Firebase settings eligibility snapshot is incomplete')
  }
  const stable = readBoundedRegularFile(
    settingsPath,
    root,
    platform,
    MAX_SETTINGS_SNAPSHOT_BYTES,
  )
  if (!sameStableFileIdentity(snapshot.settingsIdentity, stable.identity)
    || sha256Bytes(stable.bytes) !== snapshot.settingsEvidenceSha256) {
    throw new Error('Firebase settings changed after eligibility snapshot')
  }
  const effectiveConfig = parseReleasedSettingsFirebase(stable.bytes)
  if (canonicalFirebaseConfig(effectiveConfig) !== canonicalFirebaseConfig(snapshot.legacyConfig)) {
    throw new Error('Firebase settings configuration changed after eligibility snapshot')
  }
}

function serializeRegistry(document: RegistryDocument): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
  if (bytes.byteLength > MAX_REGISTRY_BYTES) throw new Error('Firebase registry is too large')
  return bytes
}

function syncParentDirectory(root: RootIdentity, platform: NodeJS.Platform): void {
  if (platform === 'win32') return
  assertRootIdentity(root, platform)
  const fd = fs.openSync(root.requestedPath, fs.constants.O_RDONLY)
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function cleanupOwnedCandidate(
  candidatePath: string,
  candidateIdentity: FileIdentity | null,
  expectedBytes: Buffer,
  root: RootIdentity,
  platform: NodeJS.Platform,
): void {
  if (!candidateIdentity) return
  try {
    assertRootIdentity(root, platform)
    const current = fs.lstatSync(candidatePath)
    if (current.isSymbolicLink()
      || !current.isFile()
      || !sameObjectIdentity(candidateIdentity, toFileIdentity(current))
      || current.size !== expectedBytes.byteLength) return
    assertPathInsideRoot(candidatePath, root, platform)
    const stable = readBoundedRegularFile(
      candidatePath,
      root,
      platform,
      MAX_REGISTRY_BYTES,
    )
    if (!sameObjectIdentity(candidateIdentity, stable.identity)
      || !stable.bytes.equals(expectedBytes)) return
    fs.unlinkSync(candidatePath)
  } catch {
    // Leave uncertain evidence in place. Unknown/foreign candidates are never scanned or removed.
  }
}

function publishImmutableRegistry(
  target: string,
  document: RegistryDocument,
  snapshot: FirebaseProfileEligibilitySnapshot,
  root: RootIdentity,
  options: FirebasePersistenceRegistryOptions,
): RegistryDocument {
  const platform = options.platform ?? process.platform
  const bytes = serializeRegistry(document)
  const candidatePath = path.join(
    root.requestedPath,
    `${FIREBASE_PERSISTENCE_REGISTRY_FILE}.candidate-${process.pid}-${randomUUID()}`,
  )
  const noFollow = platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0)
  let candidateIdentity: FileIdentity | null = null
  let published = false
  let winner: RegistryDocument

  try {
    assertRootIdentity(root, platform)
    verifyEligibilitySnapshot(snapshot, root, platform)
    const fd = fs.openSync(
      candidatePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    )
    try {
      writeAllSync(fd, bytes)
      fs.fsyncSync(fd)
      const stats = fs.fstatSync(fd)
      if (!stats.isFile() || stats.size !== bytes.byteLength) {
        throw new Error('Firebase registry candidate verification failed')
      }
      candidateIdentity = toFileIdentity(stats)
    } finally {
      fs.closeSync(fd)
    }
    const candidateStats = fs.lstatSync(candidatePath)
    if (candidateStats.isSymbolicLink()
      || !candidateStats.isFile()
      || !candidateIdentity
      || !sameStableFileIdentity(candidateIdentity, toFileIdentity(candidateStats))
      || candidateStats.size !== bytes.byteLength) {
      throw new Error('Firebase registry candidate identity changed')
    }
    assertPathInsideRoot(candidatePath, root, platform)
    assertRootIdentity(root, platform)

    options.beforePublish?.()
    assertRootIdentity(root, platform)
    verifyEligibilitySnapshot(snapshot, root, platform)
    try {
      fs.linkSync(candidatePath, target)
      published = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const targetStats = fs.lstatSync(target)
    if (published && (!candidateIdentity
      || !sameObjectIdentity(candidateIdentity, toFileIdentity(targetStats))
      || targetStats.size !== bytes.byteLength)) {
      throw new Error('Firebase registry final does not match the published candidate')
    }
    winner = parseRegistryDocument(readBoundedRegularFile(
      target,
      root,
      platform,
      MAX_REGISTRY_BYTES,
      options.afterFirstFileRead,
    ).bytes)
  } finally {
    cleanupOwnedCandidate(candidatePath, candidateIdentity, bytes, root, platform)
  }

  if (published) {
    syncParentDirectory(root, platform)
    options.afterPublish?.()
  }
  return winner
}

function readRegistry(
  registryPath: string,
  root: RootIdentity,
  platform: NodeJS.Platform,
  afterFirstRead?: (target: string) => void,
): RegistryDocument {
  return parseRegistryDocument(readBoundedRegularFile(
    registryPath,
    root,
    platform,
    MAX_REGISTRY_BYTES,
    afterFirstRead,
  ).bytes)
}

/** Snapshot only released v0.3.8 evidence, before current startup creates any files. */
export function detectPreexistingFirebaseProfile(
  userDataPath: string,
  options: FirebaseProfileSnapshotOptions = {},
): FirebaseProfileEligibilitySnapshot {
  const platform = options.platform ?? process.platform
  ensureUserDataRoot(userDataPath, platform, options.beforeRootCreate)
  const root = captureRootIdentity(userDataPath, platform)
  const registryPath = path.join(root.requestedPath, FIREBASE_PERSISTENCE_REGISTRY_FILE)
  if (optionalLstat(registryPath)) {
    return Object.freeze({
      version: 1 as const,
      existed: false,
      kind: 'registry-present' as const,
      legacyConfig: null,
      settingsEvidenceSha256: null,
      rootIdentity: Object.freeze({ ...root }),
      settingsIdentity: null,
    })
  }
  const settingsPath = path.join(root.requestedPath, 'settings.json')
  const stats = optionalLstat(settingsPath)
  if (!stats) {
    return Object.freeze({
      version: 1 as const,
      existed: false,
      kind: 'settings-absent' as const,
      legacyConfig: null,
      settingsEvidenceSha256: null,
      rootIdentity: Object.freeze({ ...root }),
      settingsIdentity: null,
    })
  }
  const stable = readBoundedRegularFile(
    settingsPath,
    root,
    platform,
    MAX_SETTINGS_SNAPSHOT_BYTES,
  )
  const legacyConfig = parseReleasedSettingsFirebase(stable.bytes)
  return Object.freeze({
    version: 1 as const,
    existed: true,
    kind: 'settings-snapshot' as const,
    legacyConfig: Object.freeze({ ...legacyConfig }),
    settingsEvidenceSha256: sha256Bytes(stable.bytes),
    rootIdentity: Object.freeze({ ...root }),
    settingsIdentity: Object.freeze({ ...stable.identity }),
  })
}

export class FirebasePersistenceRegistry {
  private constructor(private readonly document: RegistryDocument) {}

  static open(
    userDataPath: string,
    snapshot: FirebaseProfileEligibilitySnapshot,
    options: FirebasePersistenceRegistryOptions = {},
  ): FirebasePersistenceRegistry {
    const platform = options.platform ?? process.platform
    const root = captureRootIdentity(userDataPath, platform)
    const registryPath = path.join(root.requestedPath, FIREBASE_PERSISTENCE_REGISTRY_FILE)
    const existing = optionalLstat(registryPath)
    const document = existing
      ? readRegistry(registryPath, root, platform, options.afterFirstFileRead)
      : publishImmutableRegistry(
          registryPath,
          makeRegistryDocument(snapshot),
          snapshot,
          root,
          options,
        )
    return new FirebasePersistenceRegistry(document)
  }

  /** Main canonicalizes the exact config and never accepts a renderer fingerprint/path. */
  claim(configValue: unknown): FirebasePersistenceClaim {
    const config = parseFirebaseConfig(configValue)
    const digest = getDigestFirebasePersistenceIdentity(config)
    const appName = this.document.legacyClaim?.canonicalConfig === digest.configIdentity
      ? LEGACY_FIREBASE_APP_NAME
      : digest.appName
    return {
      version: 1,
      configIdentity: digest.configIdentity,
      appName,
    }
  }

  diagnostic(): {
    classification: RegistryDocument['classification']
    legacyAppName?: string
    preservedDigestAppName?: string
    unreleasedDigestAppName?: string
    settingsEvidenceSha256?: string
    detail: string
  } {
    const claim = this.document.legacyClaim
    return {
      classification: this.document.classification,
      ...(claim ? {
        legacyAppName: claim.appName,
        preservedDigestAppName: claim.freshDigestAppName,
        unreleasedDigestAppName: claim.unreleasedDigestAppName,
        settingsEvidenceSha256: this.document.eligibilityEvidence.settingsSha256 ?? undefined,
      } : {}),
      detail: this.document.diagnostic,
    }
  }
}
