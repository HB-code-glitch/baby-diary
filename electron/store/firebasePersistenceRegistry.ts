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
import { parseAppSettingsWithLegacyDefaults } from '../../shared/babyInfoSettingsCommit'
import { writeAllSync } from './durableFs'

export const FIREBASE_PERSISTENCE_REGISTRY_FILE = 'firebase-persistence-registry-v1.json'
export const FIREBASE_PROFILE_BOOTSTRAP_FILE = 'firebase-profile-bootstrap-v1.json'
export const FIREBASE_PROFILE_BOOTSTRAP_REVOCATION_FILE = 'firebase-profile-bootstrap-revocation-v1.json'
export const FIREBASE_PROFILE_BOOTSTRAP_RESOLUTION_FILE = 'firebase-profile-bootstrap-resolution-v1.json'
const MAX_REGISTRY_BYTES = 64 * 1024
const MAX_BOOTSTRAP_BYTES = 4 * 1024
const MAX_BOOTSTRAP_DECISION_BYTES = 128 * 1024
const MAX_SETTINGS_SNAPSHOT_BYTES = 32 * 1024 * 1024
const MAX_LEVELDB_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_LEVELDB_FILE_BYTES = 64 * 1024 * 1024
const MAX_LEVELDB_LIVE_FILES = 128
const MAX_LEVELDB_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_LEVELDB_LOGICAL_BLOCK_BYTES = 64 * 1024 * 1024
const MAX_LEVELDB_TABLE_BLOCKS = 16_384
const LEGACY_DIAGNOSTIC = 'preexisting-profile-assumed-v0.3.8; all digest namespaces remain untouched'
const FNV_DIAGNOSTIC = 'preexisting-profile-proved-unreleased-fnv; public v0.3.8 namespace absent'
const FRESH_DIAGNOSTIC = 'fresh profile retired the legacy namespace before Firebase initialization'
const RESTORE_INTENT_FILE = '.baby-info-pair-restore-v1.json'
const RESTORE_STAGING_DIR = '.baby-info-pair-restore-v1'
const RESTORE_INTENT_TOMBSTONE_PREFIX = `${RESTORE_INTENT_FILE}.cleanup-`
const BABY_INFO_JOURNAL_FILE = 'baby-info-journal-v1.jsonl'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface FreshBootstrapDocument {
  readonly version: 1
  readonly settingsInitiallyAbsent: true
  readonly rootFingerprint: string
  readonly nonce: string
}

interface BootstrapResolutionDocument {
  readonly version: 1
  readonly rootFingerprint: string
  readonly markerSha256: string
  readonly registrySha256: string
  readonly registry: RegistryDocument
}

interface BootstrapRevocationDocument {
  readonly version: 1
  readonly reason: 'fresh-retired'
  readonly rootFingerprint: string
  readonly markerSha256: string
}

interface BrowserPersistenceEvidence {
  readonly state: 'absent' | 'present'
  readonly fingerprint: string
  readonly publicAuthKey: boolean
  readonly fnvAuthKey: boolean
}

export interface FirebaseProfileEligibilitySnapshot {
  readonly version: 1
  readonly existed: boolean
  readonly kind:
    | 'registry-present'
    | 'settings-absent'
    | 'settings-validated-from-absence'
    | 'settings-snapshot'
    | 'settings-invalid'
    | 'settings-recovered'
  readonly legacyConfig: FirebaseConfig | null
  readonly settingsEvidenceSha256: string | null
  readonly rootIdentity: RootIdentity
  readonly settingsIdentity: FileIdentity | null
  readonly browserEvidence: BrowserPersistenceEvidence
  readonly freshBootstrap: boolean
  readonly recoveryEvidencePaths: readonly string[]
  readonly bootstrapDecisionEvidence: BootstrapDecisionEvidence
}

export interface FirebasePersistenceRegistryOptions {
  platform?: NodeJS.Platform
  beforePublish?: () => void
  afterPublish?: () => void
  /** Test seam used to prove same-inode rewrites and atomic path swaps fail closed. */
  afterFirstFileRead?: (target: string) => void
}

export interface FirebaseProfileInitialState {
  readonly version: 1
  readonly rootIdentity: RootIdentity
  readonly registryExisted: boolean
  readonly settingsExisted: boolean
  readonly freshBootstrap: boolean
  readonly recoveryEvidencePaths: readonly string[]
  readonly bootstrapDecisionEvidence: BootstrapDecisionEvidence
}

export interface FirebaseProfileSnapshotOptions {
  platform?: NodeJS.Platform
  beforeRootCreate?: () => void
  /** Existing backup roots make an absent settings file recovery evidence, not a fresh install. */
  recoveryEvidencePaths?: readonly string[]
  /** Existence-only state captured before startup constructors create or recover files. */
  initialState?: FirebaseProfileInitialState
  /** Test seam used to prove browser evidence rewrites/swaps fail closed. */
  afterFirstFileRead?: (target: string) => void
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
  appName: string
  canonicalConfig: string
  canonicalConfigSha256: string
  freshDigestAppName: string
  unreleasedDigestAppName: string
}

interface RegistryDocument {
  version: 1
  classification: 'legacy-v0.3.8-upgrade' | 'unreleased-fnv-upgrade' | 'fresh-v0.3.9-or-newer'
  diagnostic: typeof LEGACY_DIAGNOSTIC | typeof FNV_DIAGNOSTIC | typeof FRESH_DIAGNOSTIC
  eligibilityEvidence: {
    kind: 'settings-snapshot' | 'settings-absent' | 'browser-persistence' | 'settings-recovered'
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

interface BootstrapDecisionEvidence {
  readonly revocationIdentity: FileIdentity | null
  readonly revocationSha256: string | null
  readonly resolutionIdentity: FileIdentity | null
  readonly resolutionSha256: string | null
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

function comparableEntryName(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' || platform === 'darwin'
    ? value.toLocaleLowerCase('en-US')
    : value
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

function isFileIdentityOrNull(value: unknown): value is FileIdentity | null {
  if (value === null) return true
  if (!isPlainRecord(value)
    || !hasExactKeys(value, [
      'dev', 'ino', 'mode', 'size', 'birthtimeMs', 'mtimeMs', 'ctimeMs',
    ])) return false
  return ['dev', 'ino', 'mode', 'size', 'birthtimeMs', 'mtimeMs', 'ctimeMs']
    .every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))
}

function isBootstrapDecisionEvidence(value: unknown): value is BootstrapDecisionEvidence {
  return isPlainRecord(value)
    && hasExactKeys(value, [
      'revocationIdentity',
      'revocationSha256',
      'resolutionIdentity',
      'resolutionSha256',
    ])
    && isFileIdentityOrNull(value.revocationIdentity)
    && isFileIdentityOrNull(value.resolutionIdentity)
    && (value.revocationSha256 === null
      || (typeof value.revocationSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.revocationSha256)))
    && (value.resolutionSha256 === null
      || (typeof value.resolutionSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.resolutionSha256)))
    && (value.revocationIdentity === null) === (value.revocationSha256 === null)
    && (value.resolutionIdentity === null) === (value.resolutionSha256 === null)
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

function assertPathInsideDirectory(
  target: string,
  expectedParentRealPath: string,
  platform: NodeJS.Platform,
): void {
  const real = fs.realpathSync.native(target)
  if (comparablePath(path.dirname(real), platform) !== comparablePath(expectedParentRealPath, platform)) {
    throw new Error('Firebase protected file escaped its expected directory')
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
  expectedParentRealPath: string = root.realPath,
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
  assertPathInsideDirectory(target, expectedParentRealPath, platform)

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
  assertPathInsideDirectory(target, expectedParentRealPath, platform)
  assertRootIdentity(root, platform)
  return { bytes, identity: openedIdentity }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) === 1 ? 0x82f63b78 : 0)
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32c(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    value = (value >>> 8) ^ CRC32C_TABLE[(value ^ bytes[index]) & 0xff]
  }
  return (~value) >>> 0
}

function maskedCrc32c(bytes: Uint8Array): number {
  const checksum = crc32c(bytes)
  return (((checksum >>> 15) | (checksum << 17)) + 0xa282ead8) >>> 0
}

function readVarint(bytes: Buffer, start: number): { value: number; offset: number } {
  let value = 0
  let multiplier = 1
  let offset = start
  for (let count = 0; count < 10 && offset < bytes.length; count += 1) {
    const byte = bytes[offset]
    offset += 1
    value += (byte & 0x7f) * multiplier
    if (!Number.isSafeInteger(value)) throw new Error('Firebase LevelDB varint is too large')
    if ((byte & 0x80) === 0) return { value, offset }
    multiplier *= 128
  }
  throw new Error('Firebase LevelDB varint is truncated')
}

function readLengthPrefixed(bytes: Buffer, start: number): { value: Buffer; offset: number } {
  const length = readVarint(bytes, start)
  const end = length.offset + length.value
  if (end < length.offset || end > bytes.length) {
    throw new Error('Firebase LevelDB length-prefixed value is truncated')
  }
  return { value: bytes.subarray(length.offset, end), offset: end }
}

function readLevelDbLogRecords(bytes: Buffer): Buffer[] {
  const blockSize = 32 * 1024
  const records: Buffer[] = []
  let fragments: Buffer[] | null = null
  let offset = 0
  // Set only when parsing stops because the file ends before a physical
  // record header/payload was fully flushed. Real LevelDB treats an
  // incomplete final record this way as a benign unclean-shutdown artifact,
  // not corruption, and still replays every complete record before it.
  let stoppedAtTruncatedTail = false
  while (offset < bytes.length) {
    const blockOffset = offset % blockSize
    const remainingInBlock = Math.min(blockSize - blockOffset, bytes.length - offset)
    const atBufferEnd = offset + remainingInBlock >= bytes.length
    if (remainingInBlock < 7) {
      if (atBufferEnd) {
        stoppedAtTruncatedTail = true
        break
      }
      if (bytes.subarray(offset, offset + remainingInBlock).some(byte => byte !== 0)) {
        throw new Error('Firebase LevelDB log trailer is invalid')
      }
      offset += remainingInBlock
      continue
    }
    const expectedCrc = bytes.readUInt32LE(offset)
    const length = bytes.readUInt16LE(offset + 4)
    const type = bytes[offset + 6]
    if (expectedCrc === 0 && length === 0 && type === 0) {
      const blockEnd = offset + remainingInBlock
      if (bytes.subarray(offset, blockEnd).some(byte => byte !== 0)) {
        throw new Error('Firebase LevelDB log zero trailer is invalid')
      }
      offset = blockEnd
      continue
    }
    if (type < 1 || type > 4) {
      throw new Error('Firebase LevelDB physical record is invalid')
    }
    if (offset + 7 + length > bytes.length) {
      // The header was flushed but the declared payload extends past the
      // actual end of the captured file: the writer died mid-write. Stop
      // replay here instead of discarding every record parsed so far.
      stoppedAtTruncatedTail = true
      break
    }
    if (length > remainingInBlock - 7) {
      throw new Error('Firebase LevelDB physical record is invalid')
    }
    const payload = bytes.subarray(offset + 7, offset + 7 + length)
    const protectedBytes = Buffer.concat([Buffer.from([type]), payload])
    if (maskedCrc32c(protectedBytes) !== expectedCrc) {
      throw new Error('Firebase LevelDB physical record checksum is invalid')
    }
    if (type === 1) {
      if (fragments) throw new Error('Firebase LevelDB fragmented record is incomplete')
      records.push(Buffer.from(payload))
    } else if (type === 2) {
      if (fragments) throw new Error('Firebase LevelDB fragmented record overlaps')
      fragments = [Buffer.from(payload)]
    } else if (type === 3) {
      if (!fragments) throw new Error('Firebase LevelDB middle fragment has no start')
      fragments.push(Buffer.from(payload))
    } else {
      if (!fragments) throw new Error('Firebase LevelDB final fragment has no start')
      fragments.push(Buffer.from(payload))
      records.push(Buffer.concat(fragments))
      fragments = null
    }
    offset += 7 + length
  }
  if (fragments && !stoppedAtTruncatedTail) {
    throw new Error('Firebase LevelDB fragmented record is truncated')
  }
  return records
}

interface LevelDbManifestState {
  logNumber: number | null
  previousLogNumber: number | null
  tableNumbers: Set<number>
}

function parseLevelDbManifest(bytes: Buffer): LevelDbManifestState {
  let logNumber: number | null = null
  let previousLogNumber: number | null = null
  const tableNumbers = new Set<number>()
  for (const edit of readLevelDbLogRecords(bytes)) {
    let offset = 0
    while (offset < edit.length) {
      const tag = readVarint(edit, offset)
      offset = tag.offset
      if (tag.value === 1) {
        offset = readLengthPrefixed(edit, offset).offset
      } else if (tag.value === 2) {
        const value = readVarint(edit, offset)
        logNumber = value.value
        offset = value.offset
      } else if (tag.value === 3 || tag.value === 4) {
        offset = readVarint(edit, offset).offset
      } else if (tag.value === 9) {
        const value = readVarint(edit, offset)
        previousLogNumber = value.value
        offset = value.offset
      } else if (tag.value === 5) {
        offset = readVarint(edit, offset).offset
        offset = readLengthPrefixed(edit, offset).offset
      } else if (tag.value === 6) {
        const level = readVarint(edit, offset)
        const file = readVarint(edit, level.offset)
        tableNumbers.delete(file.value)
        offset = file.offset
      } else if (tag.value === 7) {
        const level = readVarint(edit, offset)
        const file = readVarint(edit, level.offset)
        const size = readVarint(edit, file.offset)
        const smallest = readLengthPrefixed(edit, size.offset)
        const largest = readLengthPrefixed(edit, smallest.offset)
        if (file.value <= 0 || size.value < 0) {
          throw new Error('Firebase LevelDB manifest file descriptor is invalid')
        }
        tableNumbers.add(file.value)
        offset = largest.offset
      } else {
        throw new Error(`Firebase LevelDB manifest tag ${tag.value} is unsupported`)
      }
    }
  }
  return { logNumber, previousLogNumber, tableNumbers }
}

function readBigEndianInteger(bytes: Buffer, start: number, length: number): number {
  if (length < 1 || length > 8 || start + length > bytes.length) {
    throw new Error('Firebase IndexedDB key integer is invalid')
  }
  let value = 0
  for (let index = 0; index < length; index += 1) {
    value = value * 256 + bytes[start + index]
    if (!Number.isSafeInteger(value)) throw new Error('Firebase IndexedDB key integer is too large')
  }
  return value
}

function chromiumIndexedDbStringDataKey(key: Buffer): string | null {
  if (key.length < 7) return null
  const prefix = key[0]
  const databaseLength = ((prefix >>> 5) & 0x07) + 1
  const objectStoreLength = ((prefix >>> 2) & 0x07) + 1
  const indexLength = (prefix & 0x03) + 1
  let offset = 1
  const databaseId = readBigEndianInteger(key, offset, databaseLength)
  offset += databaseLength
  const objectStoreId = readBigEndianInteger(key, offset, objectStoreLength)
  offset += objectStoreLength
  const indexId = readBigEndianInteger(key, offset, indexLength)
  offset += indexLength
  if (databaseId === 0 || objectStoreId === 0 || indexId !== 1 || key[offset] !== 1) return null
  offset += 1
  const codeUnits = readVarint(key, offset)
  offset = codeUnits.offset
  const byteLength = codeUnits.value * 2
  if (!Number.isSafeInteger(byteLength) || offset + byteLength !== key.length) return null
  const utf16Le = Buffer.from(key.subarray(offset)).swap16()
  return utf16Le.toString('utf16le')
}

interface LevelDbSequence {
  high: number
  low: number
}

interface AuthKeyVersion {
  sequence: LevelDbSequence
  present: boolean
}

function compareLevelDbSequence(left: LevelDbSequence, right: LevelDbSequence): number {
  if (left.high !== right.high) return left.high < right.high ? -1 : 1
  if (left.low === right.low) return 0
  return left.low < right.low ? -1 : 1
}

function addLevelDbSequence(base: LevelDbSequence, increment: number): LevelDbSequence {
  const sum = base.low + increment
  const high = base.high + Math.floor(sum / 0x100000000)
  if (!Number.isSafeInteger(increment) || increment < 0 || high > 0x00ffffff) {
    throw new Error('Firebase LevelDB sequence is outside its 56-bit domain')
  }
  return { high, low: sum >>> 0 }
}

function recordAuthKeyVersion(
  versions: Map<string, AuthKeyVersion>,
  key: string,
  sequence: LevelDbSequence,
  present: boolean,
): void {
  const current = versions.get(key)
  if (!current) {
    versions.set(key, { sequence, present })
    return
  }
  const order = compareLevelDbSequence(sequence, current.sequence)
  if (order > 0) {
    versions.set(key, { sequence, present })
  } else if (order === 0 && present !== current.present) {
    throw new Error('Firebase LevelDB sequence has conflicting Auth key states')
  }
}

function inspectLevelDbWriteBatch(
  batch: Buffer,
  authKeys: ReadonlySet<string>,
  versions: Map<string, AuthKeyVersion>,
): void {
  if (batch.length < 12) throw new Error('Firebase LevelDB WriteBatch is truncated')
  const baseSequence: LevelDbSequence = {
    low: batch.readUInt32LE(0),
    high: batch.readUInt32LE(4),
  }
  if (baseSequence.high > 0x00ffffff) {
    throw new Error('Firebase LevelDB sequence is outside its 56-bit domain')
  }
  const count = batch.readUInt32LE(8)
  if (count > 1_000_000) throw new Error('Firebase LevelDB WriteBatch count is invalid')
  if (count > 0) addLevelDbSequence(baseSequence, count - 1)
  let offset = 12
  for (let index = 0; index < count; index += 1) {
    if (offset >= batch.length) throw new Error('Firebase LevelDB WriteBatch record is truncated')
    const tag = batch[offset]
    offset += 1
    if (tag !== 0 && tag !== 1) throw new Error('Firebase LevelDB WriteBatch record type is invalid')
    const keyLength = readVarint(batch, offset)
    offset = keyLength.offset
    const keyEnd = offset + keyLength.value
    if (keyEnd < offset || keyEnd > batch.length) {
      throw new Error('Firebase LevelDB WriteBatch key is truncated')
    }
    const indexedDbKey = chromiumIndexedDbStringDataKey(batch.subarray(offset, keyEnd))
    if (indexedDbKey && authKeys.has(indexedDbKey)) {
      recordAuthKeyVersion(
        versions,
        indexedDbKey,
        addLevelDbSequence(baseSequence, index),
        tag === 1,
      )
    }
    offset = keyEnd
    if (tag === 1) {
      const valueLength = readVarint(batch, offset)
      offset = valueLength.offset + valueLength.value
      if (offset > batch.length) throw new Error('Firebase LevelDB WriteBatch value is truncated')
    }
  }
  if (offset !== batch.length) throw new Error('Firebase LevelDB WriteBatch has trailing bytes')
}

interface LevelDbTableScanBudget {
  logicalBytes: number
  blockCount: number
}

function reserveLevelDbLogicalBytes(budget: LevelDbTableScanBudget, bytes: number): void {
  const total = budget.logicalBytes + bytes
  if (!Number.isSafeInteger(bytes) || bytes < 0
    || !Number.isSafeInteger(total) || total > MAX_LEVELDB_LOGICAL_BLOCK_BYTES) {
    throw new Error('Firebase LevelDB aggregate logical block bytes exceed the budget')
  }
  budget.logicalBytes = total
}

function reserveLevelDbTableBlocks(budget: LevelDbTableScanBudget, count: number): void {
  const total = budget.blockCount + count
  if (!Number.isSafeInteger(count) || count < 0
    || !Number.isSafeInteger(total) || total > MAX_LEVELDB_TABLE_BLOCKS) {
    throw new Error('Firebase LevelDB aggregate table block count exceeds the budget')
  }
  budget.blockCount = total
}

function snappyDecode(bytes: Buffer, budget: LevelDbTableScanBudget): Buffer {
  const expected = readVarint(bytes, 0)
  if (expected.value > MAX_LEVELDB_FILE_BYTES) throw new Error('Firebase LevelDB Snappy block is too large')
  reserveLevelDbLogicalBytes(budget, expected.value)
  const output = Buffer.allocUnsafe(expected.value)
  let inputOffset = expected.offset
  let outputOffset = 0
  while (inputOffset < bytes.length && outputOffset < output.length) {
    const tag = bytes[inputOffset]
    inputOffset += 1
    const kind = tag & 0x03
    if (kind === 0) {
      let length = tag >>> 2
      if (length < 60) {
        length += 1
      } else {
        const extra = length - 59
        if (extra > 4 || inputOffset + extra > bytes.length) throw new Error('Firebase Snappy literal is invalid')
        length = 0
        for (let index = 0; index < extra; index += 1) length += bytes[inputOffset + index] * 2 ** (8 * index)
        inputOffset += extra
        length += 1
      }
      if (inputOffset + length > bytes.length || outputOffset + length > output.length) {
        throw new Error('Firebase Snappy literal is truncated')
      }
      bytes.copy(output, outputOffset, inputOffset, inputOffset + length)
      inputOffset += length
      outputOffset += length
      continue
    }
    let length: number
    let distance: number
    if (kind === 1) {
      if (inputOffset >= bytes.length) throw new Error('Firebase Snappy copy is truncated')
      length = 4 + ((tag >>> 2) & 0x07)
      distance = ((tag & 0xe0) << 3) | bytes[inputOffset]
      inputOffset += 1
    } else if (kind === 2) {
      if (inputOffset + 2 > bytes.length) throw new Error('Firebase Snappy copy is truncated')
      length = 1 + (tag >>> 2)
      distance = bytes.readUInt16LE(inputOffset)
      inputOffset += 2
    } else {
      if (inputOffset + 4 > bytes.length) throw new Error('Firebase Snappy copy is truncated')
      length = 1 + (tag >>> 2)
      distance = bytes.readUInt32LE(inputOffset)
      inputOffset += 4
    }
    if (distance <= 0 || distance > outputOffset || outputOffset + length > output.length) {
      throw new Error('Firebase Snappy copy distance is invalid')
    }
    for (let index = 0; index < length; index += 1) {
      output[outputOffset] = output[outputOffset - distance]
      outputOffset += 1
    }
  }
  if (inputOffset !== bytes.length || outputOffset !== output.length) {
    throw new Error('Firebase Snappy block length is invalid')
  }
  return output
}

interface LevelDbBlockHandle { offset: number; size: number }

function readBlockHandle(bytes: Buffer, start: number): { handle: LevelDbBlockHandle; offset: number } {
  const blockOffset = readVarint(bytes, start)
  const size = readVarint(bytes, blockOffset.offset)
  return { handle: { offset: blockOffset.value, size: size.value }, offset: size.offset }
}

function levelDbBlockRange(
  table: Buffer,
  handle: LevelDbBlockHandle,
): { start: number; end: number } {
  const trailerOffset = handle.offset + handle.size
  const end = trailerOffset + 5
  if (!Number.isSafeInteger(handle.offset) || !Number.isSafeInteger(handle.size)
    || handle.offset < 0 || handle.size < 0
    || !Number.isSafeInteger(trailerOffset) || !Number.isSafeInteger(end)
    || end > table.length - 48) {
    throw new Error('Firebase LevelDB table block handle is invalid')
  }
  return { start: handle.offset, end }
}

function assertNonOverlappingLevelDbBlockHandles(
  table: Buffer,
  handles: readonly LevelDbBlockHandle[],
): void {
  const ranges = handles.map(handle => levelDbBlockRange(table, handle))
    .sort((left, right) => left.start - right.start || left.end - right.end)
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) {
      throw new Error('Firebase LevelDB table block handles duplicate or overlap')
    }
  }
}

function readLevelDbTableBlock(
  table: Buffer,
  handle: LevelDbBlockHandle,
  budget: LevelDbTableScanBudget,
): Buffer {
  const { end } = levelDbBlockRange(table, handle)
  const trailerOffset = end - 5
  const stored = table.subarray(handle.offset, trailerOffset)
  const compression = table[trailerOffset]
  const expectedCrc = table.readUInt32LE(trailerOffset + 1)
  if (maskedCrc32c(Buffer.concat([stored, Buffer.from([compression])])) !== expectedCrc) {
    throw new Error('Firebase LevelDB table block checksum is invalid')
  }
  if (compression === 0) {
    reserveLevelDbLogicalBytes(budget, stored.length)
    return Buffer.from(stored)
  }
  if (compression === 1) return snappyDecode(stored, budget)
  throw new Error('Firebase LevelDB table compression is unsupported')
}

function visitLevelDbBlockEntries(
  block: Buffer,
  visitor: (key: Buffer, value: Buffer) => void,
): void {
  if (block.length < 4) throw new Error('Firebase LevelDB table block is truncated')
  const restartCount = block.readUInt32LE(block.length - 4)
  if (restartCount === 0 || restartCount > Math.floor((block.length - 4) / 4)) {
    throw new Error('Firebase LevelDB table restart array is invalid')
  }
  const entriesEnd = block.length - 4 - restartCount * 4
  let offset = 0
  let previousKey = Buffer.alloc(0)
  while (offset < entriesEnd) {
    const shared = readVarint(block, offset)
    const unshared = readVarint(block, shared.offset)
    const valueLength = readVarint(block, unshared.offset)
    offset = valueLength.offset
    if (shared.value > previousKey.length
      || offset + unshared.value + valueLength.value > entriesEnd) {
      throw new Error('Firebase LevelDB table entry is invalid')
    }
    const key = Buffer.concat([
      previousKey.subarray(0, shared.value),
      block.subarray(offset, offset + unshared.value),
    ])
    offset += unshared.value
    const value = block.subarray(offset, offset + valueLength.value)
    offset += valueLength.value
    visitor(key, value)
    previousKey = key
  }
  if (offset !== entriesEnd) throw new Error('Firebase LevelDB table entries are misaligned')
}

function inspectLevelDbTable(
  table: Buffer,
  authKeys: ReadonlySet<string>,
  versions: Map<string, AuthKeyVersion>,
  budget: LevelDbTableScanBudget,
): void {
  if (table.length < 48) throw new Error('Firebase LevelDB table footer is truncated')
  const footer = table.subarray(table.length - 48)
  const magic = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb])
  if (!footer.subarray(40).equals(magic)) throw new Error('Firebase LevelDB table magic is invalid')
  const meta = readBlockHandle(footer, 0)
  const index = readBlockHandle(footer, meta.offset)
  reserveLevelDbTableBlocks(budget, 2)
  assertNonOverlappingLevelDbBlockHandles(table, [meta.handle, index.handle])
  const metaBlock = readLevelDbTableBlock(table, meta.handle, budget)
  const indexBlock = readLevelDbTableBlock(table, index.handle, budget)
  const metaHandles: LevelDbBlockHandle[] = []
  const dataHandles: LevelDbBlockHandle[] = []
  visitLevelDbBlockEntries(metaBlock, (_key, value) => {
    const decoded = readBlockHandle(value, 0)
    if (decoded.offset !== value.length) throw new Error('Firebase LevelDB metaindex handle has trailing bytes')
    reserveLevelDbTableBlocks(budget, 1)
    metaHandles.push(decoded.handle)
  })
  visitLevelDbBlockEntries(indexBlock, (_key, value) => {
    const decoded = readBlockHandle(value, 0)
    if (decoded.offset !== value.length) throw new Error('Firebase LevelDB index handle has trailing bytes')
    reserveLevelDbTableBlocks(budget, 1)
    dataHandles.push(decoded.handle)
  })
  assertNonOverlappingLevelDbBlockHandles(
    table,
    [meta.handle, index.handle, ...metaHandles, ...dataHandles],
  )
  for (const handle of metaHandles) readLevelDbTableBlock(table, handle, budget)
  for (const handle of dataHandles) {
    const dataBlock = readLevelDbTableBlock(table, handle, budget)
    visitLevelDbBlockEntries(dataBlock, (internalKey) => {
      if (internalKey.length < 8) throw new Error('Firebase LevelDB internal key is truncated')
      const trailerOffset = internalKey.length - 8
      const trailerLow = internalKey.readUInt32LE(trailerOffset)
      const trailerHigh = internalKey.readUInt32LE(trailerOffset + 4)
      const valueType = trailerLow & 0xff
      if (valueType !== 0 && valueType !== 1) {
        throw new Error('Firebase LevelDB internal key value type is invalid')
      }
      const indexedDbKey = chromiumIndexedDbStringDataKey(internalKey.subarray(0, trailerOffset))
      if (indexedDbKey && authKeys.has(indexedDbKey)) {
        recordAuthKeyVersion(
          versions,
          indexedDbKey,
          {
            high: trailerHigh >>> 8,
            low: ((trailerLow >>> 8) | (trailerHigh << 24)) >>> 0,
          },
          valueType === 1,
        )
      }
    })
  }
}

interface ProtectedDirectoryIdentity {
  identity: FileIdentity
  realPath: string
}

function captureProtectedDirectory(
  target: string,
  expectedParentRealPath: string,
  platform: NodeJS.Platform,
): ProtectedDirectoryIdentity {
  const stats = fs.lstatSync(target)
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('Firebase browser persistence path is a link/reparse point or non-directory')
  }
  const realPath = fs.realpathSync.native(target)
  if (comparablePath(path.dirname(realPath), platform) !== comparablePath(expectedParentRealPath, platform)) {
    throw new Error('Firebase browser persistence directory escaped its parent')
  }
  return { identity: toFileIdentity(stats), realPath }
}

function sameProtectedDirectory(
  target: string,
  expectedParentRealPath: string,
  expected: ProtectedDirectoryIdentity,
  platform: NodeJS.Platform,
): boolean {
  const current = captureProtectedDirectory(target, expectedParentRealPath, platform)
  return sameObjectIdentity(expected.identity, current.identity)
    && comparablePath(expected.realPath, platform) === comparablePath(current.realPath, platform)
}

function evidenceIdentity(value: FileIdentity): string {
  return [value.dev, value.ino, value.mode, value.size, value.birthtimeMs, value.mtimeMs, value.ctimeMs].join(':')
}

function scanBrowserPersistenceEvidence(
  root: RootIdentity,
  platform: NodeJS.Platform,
  configValue: FirebaseConfig,
  afterFirstRead?: (target: string) => void,
): BrowserPersistenceEvidence {
  const fingerprint = createHash('sha256')
  const indexedDbPath = path.join(root.requestedPath, 'IndexedDB')
  const indexedDbStats = optionalLstat(indexedDbPath)
  if (!indexedDbStats) {
    fingerprint.update('IndexedDB:absent')
    return { state: 'absent', fingerprint: fingerprint.digest('hex'), publicAuthKey: false, fnvAuthKey: false }
  }
  const indexedDb = captureProtectedDirectory(indexedDbPath, root.realPath, platform)
  const levelDbPath = path.join(indexedDbPath, 'file__0.indexeddb.leveldb')
  const levelDbStats = optionalLstat(levelDbPath)
  if (!levelDbStats) {
    fingerprint.update(`IndexedDB:present:${evidenceIdentity(indexedDb.identity)}:leveldb:absent`)
    return { state: 'absent', fingerprint: fingerprint.digest('hex'), publicAuthKey: false, fnvAuthKey: false }
  }
  const levelDb = captureProtectedDirectory(levelDbPath, indexedDb.realPath, platform)
  const entriesBefore = fs.readdirSync(levelDbPath).sort()
  if (entriesBefore.length > MAX_LEVELDB_LIVE_FILES * 4) {
    throw new Error('Firebase browser persistence directory has too many entries')
  }

  let totalBytes = 0
  const readProtected = (name: string, maxBytes: number): Buffer => {
    const target = path.join(levelDbPath, name)
    const stable = readBoundedRegularFile(
      target,
      root,
      platform,
      maxBytes,
      afterFirstRead,
      levelDb.realPath,
    )
    totalBytes += stable.bytes.length
    if (totalBytes > MAX_LEVELDB_TOTAL_BYTES) {
      throw new Error('Firebase browser persistence evidence exceeds the read budget')
    }
    fingerprint.update(name)
    fingerprint.update(evidenceIdentity(stable.identity))
    fingerprint.update(sha256Bytes(stable.bytes))
    return stable.bytes
  }

  const current = readProtected('CURRENT', 4 * 1024).toString('utf8')
  const currentMatch = /^(MANIFEST-[0-9]{6,})\n$/.exec(current)
  if (!currentMatch) throw new Error('Firebase LevelDB CURRENT is invalid')
  const manifestBytes = readProtected(currentMatch[1], MAX_LEVELDB_MANIFEST_BYTES)
  const manifest = parseLevelDbManifest(manifestBytes)
  const minimumLogNumber = manifest.logNumber ?? 0
  const previousLogNumber = manifest.previousLogNumber ?? 0
  const liveLogs = entriesBefore.flatMap(name => {
    const match = /^([0-9]{6,})\.log$/.exec(name)
    if (!match) return []
    const fileNumber = Number(match[1])
    if (!Number.isSafeInteger(fileNumber) || fileNumber <= 0
      || `${String(fileNumber).padStart(6, '0')}.log` !== name) {
      throw new Error('Firebase LevelDB log file name is invalid')
    }
    return fileNumber >= minimumLogNumber || fileNumber === previousLogNumber
      ? [{ fileNumber, name }]
      : []
  }).sort((left, right) => left.fileNumber - right.fileNumber)
  if (liveLogs.length + manifest.tableNumbers.size > MAX_LEVELDB_LIVE_FILES) {
    throw new Error('Firebase LevelDB manifest has too many live files')
  }
  const liveTableNames: string[] = []
  for (const tableNumber of Array.from(manifest.tableNumbers).sort((left, right) => left - right)) {
    const prefix = String(tableNumber).padStart(6, '0')
    const ldb = `${prefix}.ldb`
    const sst = `${prefix}.sst`
    const hasLdb = entriesBefore.includes(ldb)
    const hasSst = entriesBefore.includes(sst)
    if (hasLdb === hasSst) throw new Error('Firebase LevelDB live table path is ambiguous or missing')
    liveTableNames.push(hasLdb ? ldb : sst)
  }
  const publicKey = `firebase:authUser:${configValue.apiKey}:${LEGACY_FIREBASE_APP_NAME}`
  const fnvKey = `firebase:authUser:${configValue.apiKey}:${getUnreleasedFNVFirebaseAppName(configValue)}`
  const authKeys = new Set([publicKey, fnvKey])
  const versions = new Map<string, AuthKeyVersion>()
  const tableBudget: LevelDbTableScanBudget = { logicalBytes: 0, blockCount: 0 }
  for (const { name } of liveLogs) {
    const bytes = readProtected(name, MAX_LEVELDB_FILE_BYTES)
    for (const batch of readLevelDbLogRecords(bytes)) {
      inspectLevelDbWriteBatch(batch, authKeys, versions)
    }
  }
  for (const name of liveTableNames) {
    inspectLevelDbTable(
      readProtected(name, MAX_LEVELDB_FILE_BYTES),
      authKeys,
      versions,
      tableBudget,
    )
  }

  const entriesAfter = fs.readdirSync(levelDbPath).sort()
  if (entriesAfter.length !== entriesBefore.length
    || entriesAfter.some((name, index) => name !== entriesBefore[index])
    || !sameProtectedDirectory(indexedDbPath, root.realPath, indexedDb, platform)
    || !sameProtectedDirectory(levelDbPath, indexedDb.realPath, levelDb, platform)) {
    throw new Error('Firebase browser persistence directory identity changed')
  }
  assertRootIdentity(root, platform)
  fingerprint.update(`IndexedDB:${evidenceIdentity(indexedDb.identity)}`)
  fingerprint.update(`leveldb:${evidenceIdentity(levelDb.identity)}`)
  fingerprint.update(entriesBefore.join('\0'))
  return {
    state: 'present',
    fingerprint: fingerprint.digest('hex'),
    publicAuthKey: versions.get(publicKey)?.present === true,
    fnvAuthKey: versions.get(fnvKey)?.present === true,
  }
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
      && value.classification !== 'unreleased-fnv-upgrade'
      && value.classification !== 'fresh-v0.3.9-or-newer')
    || (value.diagnostic !== LEGACY_DIAGNOSTIC
      && value.diagnostic !== FNV_DIAGNOSTIC
      && value.diagnostic !== FRESH_DIAGNOSTIC)) {
    throw new Error('Firebase registry schema is invalid')
  }
  if (!isPlainRecord(value.eligibilityEvidence)
    || !hasExactKeys(value.eligibilityEvidence, ['kind', 'settingsSha256'])
    || (value.eligibilityEvidence.kind !== 'settings-snapshot'
      && value.eligibilityEvidence.kind !== 'settings-absent'
      && value.eligibilityEvidence.kind !== 'browser-persistence'
      && value.eligibilityEvidence.kind !== 'settings-recovered')
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

  const fnvClassification = value.classification === 'unreleased-fnv-upgrade'
  if (value.diagnostic !== (fnvClassification ? FNV_DIAGNOSTIC : LEGACY_DIAGNOSTIC)
    || value.eligibilityEvidence.kind === 'settings-absent'
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
  if (typeof claim.appName !== 'string'
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
  const expectedAppName = fnvClassification
    ? getUnreleasedFNVFirebaseAppName(config)
    : LEGACY_FIREBASE_APP_NAME
  if (claim.appName !== expectedAppName
    || canonical !== claim.canonicalConfig
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
      kind: value.eligibilityEvidence.kind,
      settingsSha256: value.eligibilityEvidence.settingsSha256,
    },
    legacyClaim: {
      appName: expectedAppName,
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
  if (snapshot.kind === 'settings-invalid') {
    throw new Error('Firebase settings recovery must complete before registry publication')
  }
  const hasBrowserClaim = snapshot.browserEvidence.publicAuthKey || snapshot.browserEvidence.fnvAuthKey
  if (snapshot.kind === 'settings-snapshot'
    || snapshot.kind === 'settings-recovered'
    || ((snapshot.kind === 'settings-absent'
      || snapshot.kind === 'settings-validated-from-absence') && hasBrowserClaim)) {
    if (snapshot.legacyConfig === null) throw new Error('Firebase legacy profile eligibility is inconsistent')
    const config = parseFirebaseConfig(snapshot.legacyConfig)
    const canonicalConfig = canonicalFirebaseConfig(config)
    const fnvOnly = !snapshot.browserEvidence.publicAuthKey && snapshot.browserEvidence.fnvAuthKey
    const appName = fnvOnly ? getUnreleasedFNVFirebaseAppName(config) : LEGACY_FIREBASE_APP_NAME
    const evidenceKind = snapshot.kind === 'settings-absent'
      || snapshot.kind === 'settings-validated-from-absence'
      ? 'browser-persistence'
      : snapshot.kind === 'settings-recovered'
        ? 'settings-recovered'
        : 'settings-snapshot'
    const evidenceHash = snapshot.kind === 'settings-absent'
      || snapshot.kind === 'settings-validated-from-absence'
      ? snapshot.browserEvidence.fingerprint
      : snapshot.settingsEvidenceSha256
    if (!evidenceHash) throw new Error('Firebase legacy profile evidence is incomplete')
    return {
      version: 1,
      classification: fnvOnly ? 'unreleased-fnv-upgrade' : 'legacy-v0.3.8-upgrade',
      diagnostic: fnvOnly ? FNV_DIAGNOSTIC : LEGACY_DIAGNOSTIC,
      eligibilityEvidence: {
        kind: evidenceKind,
        settingsSha256: evidenceHash,
      },
      legacyClaim: {
        appName,
        canonicalConfig,
        canonicalConfigSha256: sha256(canonicalConfig),
        freshDigestAppName: getDigestFirebasePersistenceIdentity(config).appName,
        unreleasedDigestAppName: getUnreleasedFNVFirebaseAppName(config),
      },
    }
  }
  if ((snapshot.kind !== 'settings-absent'
      && snapshot.kind !== 'settings-validated-from-absence')
    || snapshot.legacyConfig !== null
    || (snapshot.kind === 'settings-absent'
      && (snapshot.settingsEvidenceSha256 !== null || snapshot.settingsIdentity !== null))
    || (snapshot.kind === 'settings-validated-from-absence'
      && (!snapshot.settingsEvidenceSha256 || !snapshot.settingsIdentity))) {
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

function assertInitialRegularFile(target: string, label: string): boolean {
  const stats = optionalLstat(target)
  if (!stats) return false
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Firebase initial ${label} path is a link/reparse point or non-file`)
  }
  return true
}

function bindRecoveryEvidencePaths(
  values: readonly string[],
  platform: NodeJS.Platform,
): readonly string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new Error('Firebase recovery evidence path must be absolute')
    }
    const normalized = path.normalize(value)
    const comparable = comparablePath(normalized, platform)
    if (!seen.has(comparable)) {
      seen.add(comparable)
      result.push(normalized)
    }
  }
  return Object.freeze(result)
}

function mergeRecoveryEvidencePaths(
  first: readonly string[],
  second: readonly string[],
  platform: NodeJS.Platform,
): readonly string[] {
  return bindRecoveryEvidencePaths([...first, ...second], platform)
}

function firebaseRootFingerprint(root: RootIdentity, platform: NodeJS.Platform): string {
  return sha256(JSON.stringify({
    requestedPath: comparablePath(root.requestedPath, platform),
    realPath: comparablePath(root.realPath, platform),
    dev: root.dev,
    ino: root.ino,
    mode: root.mode,
    birthtimeMs: root.birthtimeMs,
  }))
}

function serializeFreshBootstrapDocument(document: FreshBootstrapDocument): Buffer {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
}

function makeFreshBootstrapBytes(root: RootIdentity, platform: NodeJS.Platform): Buffer {
  return serializeFreshBootstrapDocument({
    version: 1,
    settingsInitiallyAbsent: true,
    rootFingerprint: firebaseRootFingerprint(root, platform),
    nonce: randomUUID(),
  })
}

function readFreshBootstrapEvidence(
  root: RootIdentity,
  platform: NodeJS.Platform,
  afterFirstRead?: (target: string) => void,
): StableReadResult {
  const stable = readBoundedRegularFile(
    path.join(root.requestedPath, FIREBASE_PROFILE_BOOTSTRAP_FILE),
    root,
    platform,
    MAX_BOOTSTRAP_BYTES,
    afterFirstRead,
  )
  let value: unknown
  try {
    value = JSON.parse(stable.bytes.toString('utf8'))
  } catch {
    throw new Error('Firebase fresh bootstrap evidence is invalid JSON')
  }
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['version', 'settingsInitiallyAbsent', 'rootFingerprint', 'nonce'])
    || value.version !== 1
    || value.settingsInitiallyAbsent !== true
    || typeof value.rootFingerprint !== 'string'
    || value.rootFingerprint !== firebaseRootFingerprint(root, platform)
    || typeof value.nonce !== 'string'
    || !UUID_PATTERN.test(value.nonce)
    || !stable.bytes.equals(serializeFreshBootstrapDocument({
      version: 1,
      settingsInitiallyAbsent: true,
      rootFingerprint: value.rootFingerprint,
      nonce: value.nonce,
    }))) {
    throw new Error('Firebase fresh bootstrap evidence is invalid')
  }
  return stable
}

function serializeBootstrapRevocation(
  root: RootIdentity,
  platform: NodeJS.Platform,
  markerSha256: string,
): Buffer {
  return Buffer.from(`${JSON.stringify({
    version: 1,
    reason: 'fresh-retired',
    rootFingerprint: firebaseRootFingerprint(root, platform),
    markerSha256,
  }, null, 2)}\n`, 'utf8')
}

function readBootstrapRevocation(
  root: RootIdentity,
  platform: NodeJS.Platform,
): { stable: StableReadResult; document: BootstrapRevocationDocument } | null {
  const target = path.join(root.requestedPath, FIREBASE_PROFILE_BOOTSTRAP_REVOCATION_FILE)
  if (!optionalLstat(target)) return null
  const stable = readBoundedRegularFile(target, root, platform, MAX_BOOTSTRAP_DECISION_BYTES)
  let value: unknown
  try {
    value = JSON.parse(stable.bytes.toString('utf8'))
  } catch {
    throw new Error('Firebase bootstrap revocation evidence is invalid JSON')
  }
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['version', 'reason', 'rootFingerprint', 'markerSha256'])
    || value.version !== 1
    || value.reason !== 'fresh-retired'
    || typeof value.rootFingerprint !== 'string'
    || value.rootFingerprint !== firebaseRootFingerprint(root, platform)
    || typeof value.markerSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.markerSha256)
    || !stable.bytes.equals(serializeBootstrapRevocation(root, platform, value.markerSha256))) {
    throw new Error('Firebase bootstrap revocation evidence is invalid')
  }
  return {
    stable,
    document: Object.freeze({
      version: 1 as const,
      reason: 'fresh-retired' as const,
      rootFingerprint: value.rootFingerprint,
      markerSha256: value.markerSha256,
    }),
  }
}

function serializeBootstrapResolution(
  root: RootIdentity,
  platform: NodeJS.Platform,
  document: RegistryDocument,
  markerSha256: string,
): Buffer {
  const registrySha256 = sha256Bytes(serializeRegistry(document))
  return Buffer.from(`${JSON.stringify({
    version: 1,
    rootFingerprint: firebaseRootFingerprint(root, platform),
    markerSha256,
    registrySha256,
    registry: document,
  }, null, 2)}\n`, 'utf8')
}

function readBootstrapResolution(
  root: RootIdentity,
  platform: NodeJS.Platform,
): { stable: StableReadResult; document: BootstrapResolutionDocument } | null {
  const target = path.join(root.requestedPath, FIREBASE_PROFILE_BOOTSTRAP_RESOLUTION_FILE)
  if (!optionalLstat(target)) return null
  const stable = readBoundedRegularFile(target, root, platform, MAX_BOOTSTRAP_DECISION_BYTES)
  let value: unknown
  try {
    value = JSON.parse(stable.bytes.toString('utf8'))
  } catch {
    throw new Error('Firebase bootstrap resolution evidence is invalid JSON')
  }
  if (!isPlainRecord(value)
    || !hasExactKeys(value, ['version', 'rootFingerprint', 'markerSha256', 'registrySha256', 'registry'])
    || value.version !== 1
    || typeof value.rootFingerprint !== 'string'
    || value.rootFingerprint !== firebaseRootFingerprint(root, platform)
    || typeof value.markerSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.markerSha256)
    || typeof value.registrySha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.registrySha256)) {
    throw new Error('Firebase bootstrap resolution evidence is invalid')
  }
  const registry = parseRegistryDocument(Buffer.from(JSON.stringify(value.registry), 'utf8'))
  if (sha256Bytes(serializeRegistry(registry)) !== value.registrySha256
    || !stable.bytes.equals(serializeBootstrapResolution(
      root,
      platform,
      registry,
      value.markerSha256,
    ))) {
    throw new Error('Firebase bootstrap resolution evidence is invalid')
  }
  return {
    stable,
    document: Object.freeze({
      version: 1 as const,
      rootFingerprint: value.rootFingerprint,
      markerSha256: value.markerSha256,
      registrySha256: value.registrySha256,
      registry,
    }),
  }
}

function publishImmutableBootstrapDecision(
  root: RootIdentity,
  platform: NodeJS.Platform,
  fileName: string,
  bytes: Buffer,
): void {
  const target = path.join(root.requestedPath, fileName)
  const candidatePath = path.join(
    root.requestedPath,
    `${fileName}.candidate-${process.pid}-${randomUUID()}`,
  )
  const noFollow = platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0)
  let candidateIdentity: FileIdentity | null = null
  let published = false
  try {
    assertRootIdentity(root, platform)
    const fd = fs.openSync(
      candidatePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    )
    try {
      writeAllSync(fd, bytes)
      fs.fsyncSync(fd)
      candidateIdentity = toFileIdentity(fs.fstatSync(fd))
    } finally {
      fs.closeSync(fd)
    }
    const candidateStats = fs.lstatSync(candidatePath)
    if (!candidateIdentity
      || candidateStats.isSymbolicLink()
      || !candidateStats.isFile()
      || !sameStableFileIdentity(candidateIdentity, toFileIdentity(candidateStats))
      || candidateStats.size !== bytes.byteLength) {
      throw new Error('Firebase bootstrap decision candidate identity changed')
    }
    assertPathInsideRoot(candidatePath, root, platform)
    assertRootIdentity(root, platform)
    try {
      fs.linkSync(candidatePath, target)
      published = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stable = readBoundedRegularFile(
      target,
      root,
      platform,
      MAX_BOOTSTRAP_DECISION_BYTES,
    )
    if (!stable.bytes.equals(bytes)
      || (published && (!candidateIdentity
        || !sameObjectIdentity(candidateIdentity, stable.identity)))) {
      throw new Error('Firebase bootstrap decision conflicts with immutable evidence')
    }
  } finally {
    cleanupOwnedCandidate(candidatePath, candidateIdentity, bytes, root, platform)
  }
  if (published) syncParentDirectory(root, platform)
}

function publishBootstrapRevocation(
  root: RootIdentity,
  platform: NodeJS.Platform,
  marker: StableReadResult,
): void {
  publishImmutableBootstrapDecision(
    root,
    platform,
    FIREBASE_PROFILE_BOOTSTRAP_REVOCATION_FILE,
    serializeBootstrapRevocation(root, platform, sha256Bytes(marker.bytes)),
  )
}

function publishBootstrapResolution(
  root: RootIdentity,
  platform: NodeJS.Platform,
  document: RegistryDocument,
  marker: StableReadResult,
): void {
  publishImmutableBootstrapDecision(
    root,
    platform,
    FIREBASE_PROFILE_BOOTSTRAP_RESOLUTION_FILE,
    serializeBootstrapResolution(root, platform, document, sha256Bytes(marker.bytes)),
  )
}

function captureBootstrapDecisionEvidence(
  root: RootIdentity,
  platform: NodeJS.Platform,
): BootstrapDecisionEvidence {
  const revocation = readBootstrapRevocation(root, platform)
  const resolution = readBootstrapResolution(root, platform)
  if (revocation || resolution) {
    const marker = readFreshBootstrapEvidence(root, platform)
    const markerSha256 = sha256Bytes(marker.bytes)
    if ((revocation && revocation.document.markerSha256 !== markerSha256)
      || (resolution && resolution.document.markerSha256 !== markerSha256)
      || (revocation && resolution
        && revocation.document.markerSha256 !== resolution.document.markerSha256)) {
      throw new Error('Firebase bootstrap decision does not match its root-bound marker')
    }
  }
  return Object.freeze({
    revocationIdentity: revocation ? Object.freeze({ ...revocation.stable.identity }) : null,
    revocationSha256: revocation ? sha256Bytes(revocation.stable.bytes) : null,
    resolutionIdentity: resolution ? Object.freeze({ ...resolution.stable.identity }) : null,
    resolutionSha256: resolution ? sha256Bytes(resolution.stable.bytes) : null,
  })
}

function verifyBootstrapDecisionEvidence(
  expected: BootstrapDecisionEvidence,
  root: RootIdentity,
  platform: NodeJS.Platform,
): void {
  const current = captureBootstrapDecisionEvidence(root, platform)
  const sameEvidence = (
    expectedIdentity: FileIdentity | null,
    expectedSha256: string | null,
    currentIdentity: FileIdentity | null,
    currentSha256: string | null,
  ): boolean => expectedIdentity === null
    ? currentIdentity === null && expectedSha256 === null && currentSha256 === null
    : currentIdentity !== null
      && typeof expectedSha256 === 'string'
      && expectedSha256 === currentSha256
      && sameStableFileIdentity(expectedIdentity, currentIdentity)
  if (!sameEvidence(
    expected.revocationIdentity,
    expected.revocationSha256,
    current.revocationIdentity,
    current.revocationSha256,
  ) || !sameEvidence(
    expected.resolutionIdentity,
    expected.resolutionSha256,
    current.resolutionIdentity,
    current.resolutionSha256,
  )) {
    throw new Error('Firebase bootstrap decision evidence changed after startup capture')
  }
}

function cloneBootstrapDecisionEvidence(
  evidence: BootstrapDecisionEvidence,
): BootstrapDecisionEvidence {
  return Object.freeze({
    revocationIdentity: evidence.revocationIdentity
      ? Object.freeze({ ...evidence.revocationIdentity })
      : null,
    revocationSha256: evidence.revocationSha256,
    resolutionIdentity: evidence.resolutionIdentity
      ? Object.freeze({ ...evidence.resolutionIdentity })
      : null,
    resolutionSha256: evidence.resolutionSha256,
  })
}

function hasBootstrapInvalidatingEvidence(
  root: RootIdentity,
  platform: NodeJS.Platform,
  recoveryEvidencePaths: readonly string[],
): boolean {
  const entries = fs.readdirSync(root.requestedPath)
    .map(name => comparableEntryName(name, platform))
  const restoreIntent = comparableEntryName(RESTORE_INTENT_FILE, platform)
  const restoreStaging = comparableEntryName(RESTORE_STAGING_DIR, platform)
  const restoreTombstone = comparableEntryName(RESTORE_INTENT_TOMBSTONE_PREFIX, platform)
  const settingsTemp = comparableEntryName('settings.json.tmp-', platform)
  const journalTemp = comparableEntryName(`${BABY_INFO_JOURNAL_FILE}.tmp-`, platform)
  if (entries.includes(restoreIntent)
    || entries.includes(restoreStaging)
    || entries.some(name => name.startsWith(restoreTombstone)
      || name.startsWith(settingsTemp)
      || name.startsWith(journalTemp))) {
    return true
  }
  for (const evidencePath of recoveryEvidencePaths) {
    if (optionalLstat(evidencePath)) return true
  }
  return false
}

function hasBootstrapBlockingEvidence(
  root: RootIdentity,
  platform: NodeJS.Platform,
  recoveryEvidencePaths: readonly string[],
): boolean {
  const journal = comparableEntryName(BABY_INFO_JOURNAL_FILE, platform)
  return fs.readdirSync(root.requestedPath)
    .some(name => comparableEntryName(name, platform) === journal)
    || hasBootstrapInvalidatingEvidence(root, platform, recoveryEvidencePaths)
}

function validateFreshBootstrapAgainstRecovery(
  root: RootIdentity,
  platform: NodeJS.Platform,
  recoveryEvidencePaths: readonly string[],
  includeInitialJournal: boolean,
  afterFirstRead?: (target: string) => void,
): boolean {
  if (readBootstrapResolution(root, platform) || readBootstrapRevocation(root, platform)) {
    return false
  }
  const hasInvalidatingEvidence = (): boolean => includeInitialJournal
    ? hasBootstrapBlockingEvidence(root, platform, recoveryEvidencePaths)
    : hasBootstrapInvalidatingEvidence(root, platform, recoveryEvidencePaths)
  const invalidBeforeRead = hasInvalidatingEvidence()
  const stable = readFreshBootstrapEvidence(root, platform, afterFirstRead)
  const invalidAfterRead = hasInvalidatingEvidence()
  if (invalidBeforeRead || invalidAfterRead) {
    publishBootstrapRevocation(root, platform, stable)
    return false
  }
  if (readBootstrapResolution(root, platform) || readBootstrapRevocation(root, platform)) {
    return false
  }
  return true
}

function assertFreshBootstrapCreationEligible(
  root: RootIdentity,
  platform: NodeJS.Platform,
  recoveryEvidencePaths: readonly string[],
): void {
  assertRootIdentity(root, platform)
  if (optionalLstat(path.join(root.requestedPath, FIREBASE_PERSISTENCE_REGISTRY_FILE))
    || optionalLstat(path.join(root.requestedPath, 'settings.json'))
    || readBootstrapResolution(root, platform)
    || readBootstrapRevocation(root, platform)
    || hasBootstrapBlockingEvidence(root, platform, recoveryEvidencePaths)) {
    throw new Error('Firebase fresh bootstrap eligibility changed before durable publication')
  }
  assertRootIdentity(root, platform)
}

function publishFreshBootstrapEvidence(
  root: RootIdentity,
  platform: NodeJS.Platform,
  recoveryEvidencePaths: readonly string[],
  afterFirstRead?: (target: string) => void,
): boolean {
  const target = path.join(root.requestedPath, FIREBASE_PROFILE_BOOTSTRAP_FILE)
  const bootstrapBytes = makeFreshBootstrapBytes(root, platform)
  const candidatePath = path.join(
    root.requestedPath,
    `${FIREBASE_PROFILE_BOOTSTRAP_FILE}.candidate-${process.pid}-${randomUUID()}`,
  )
  const noFollow = platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0)
  let candidateIdentity: FileIdentity | null = null
  let published = false
  try {
    assertFreshBootstrapCreationEligible(root, platform, recoveryEvidencePaths)
    const fd = fs.openSync(
      candidatePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    )
    try {
      writeAllSync(fd, bootstrapBytes)
      fs.fsyncSync(fd)
      const stats = fs.fstatSync(fd)
      if (!stats.isFile() || stats.size !== bootstrapBytes.byteLength) {
        throw new Error('Firebase fresh bootstrap candidate verification failed')
      }
      candidateIdentity = toFileIdentity(stats)
    } finally {
      fs.closeSync(fd)
    }
    const candidateStats = fs.lstatSync(candidatePath)
    if (candidateStats.isSymbolicLink()
      || !candidateStats.isFile()
      || !candidateIdentity
      || !sameStableFileIdentity(candidateIdentity, toFileIdentity(candidateStats))) {
      throw new Error('Firebase fresh bootstrap candidate identity changed')
    }
    assertPathInsideRoot(candidatePath, root, platform)
    assertFreshBootstrapCreationEligible(root, platform, recoveryEvidencePaths)
    try {
      fs.linkSync(candidatePath, target)
      published = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const targetStats = fs.lstatSync(target)
    if (published && (!candidateIdentity
      || !sameObjectIdentity(candidateIdentity, toFileIdentity(targetStats))
      || targetStats.size !== bootstrapBytes.byteLength)) {
      throw new Error('Firebase fresh bootstrap final does not match its candidate')
    }
    const eligible = validateFreshBootstrapAgainstRecovery(
      root,
      platform,
      recoveryEvidencePaths,
      true,
      afterFirstRead,
    )
    if (!eligible) return false
  } finally {
    cleanupOwnedCandidate(
      candidatePath,
      candidateIdentity,
      bootstrapBytes,
      root,
      platform,
    )
  }
  if (published) syncParentDirectory(root, platform)
  return true
}

function assertFreshBootstrapEvidence(
  snapshot: FirebaseProfileEligibilitySnapshot,
  root: RootIdentity,
  platform: NodeJS.Platform,
): void {
  if (!snapshot.freshBootstrap) return
  const recoveryEvidencePaths = bindRecoveryEvidencePaths(snapshot.recoveryEvidencePaths, platform)
  if (!validateFreshBootstrapAgainstRecovery(
    root,
    platform,
    recoveryEvidencePaths,
    false,
  )) {
    throw new Error('Firebase fresh bootstrap evidence was invalidated by recovery evidence')
  }
  assertRootIdentity(root, platform)
}

/**
 * Capture only the startup facts that constructors are allowed to change.
 * Settings contents are deliberately read later, after SettingsStore validation/recovery.
 */
export function captureFirebaseProfileInitialState(
  userDataPath: string,
  options: Pick<
    FirebaseProfileSnapshotOptions,
    'platform' | 'beforeRootCreate' | 'recoveryEvidencePaths' | 'afterFirstFileRead'
  > = {},
): FirebaseProfileInitialState {
  const platform = options.platform ?? process.platform
  const recoveryEvidencePaths = bindRecoveryEvidencePaths(
    options.recoveryEvidencePaths ?? [],
    platform,
  )
  ensureUserDataRoot(userDataPath, platform, options.beforeRootCreate)
  const root = captureRootIdentity(userDataPath, platform)
  const registryExisted = assertInitialRegularFile(
    path.join(root.requestedPath, FIREBASE_PERSISTENCE_REGISTRY_FILE),
    'registry',
  )
  const actualSettingsExisted = assertInitialRegularFile(
    path.join(root.requestedPath, 'settings.json'),
    'settings',
  )
  const bootstrapPath = path.join(root.requestedPath, FIREBASE_PROFILE_BOOTSTRAP_FILE)
  let freshBootstrap = false
  if (!registryExisted) {
    const resolution = readBootstrapResolution(root, platform)
    const revocation = readBootstrapRevocation(root, platform)
    if (resolution || revocation) {
      freshBootstrap = false
    } else if (optionalLstat(bootstrapPath)) {
      freshBootstrap = validateFreshBootstrapAgainstRecovery(
        root,
        platform,
        recoveryEvidencePaths,
        false,
        options.afterFirstFileRead,
      )
    } else if (!actualSettingsExisted && !hasBootstrapBlockingEvidence(
      root,
      platform,
      recoveryEvidencePaths,
    )) {
      freshBootstrap = publishFreshBootstrapEvidence(
        root,
        platform,
        recoveryEvidencePaths,
        options.afterFirstFileRead,
      )
    }
  }
  if (freshBootstrap) {
    freshBootstrap = validateFreshBootstrapAgainstRecovery(
      root,
      platform,
      recoveryEvidencePaths,
      false,
    )
  }
  // Without durable fresh proof, an absent primary is recovery/legacy evidence.
  const settingsExisted = freshBootstrap
    ? false
    : actualSettingsExisted || !registryExisted
  const bootstrapDecisionEvidence = captureBootstrapDecisionEvidence(root, platform)
  assertRootIdentity(root, platform)
  return Object.freeze({
    version: 1 as const,
    rootIdentity: Object.freeze({ ...root }),
    registryExisted,
    settingsExisted,
    freshBootstrap,
    recoveryEvidencePaths,
    bootstrapDecisionEvidence,
  })
}

function assertInitialState(
  initialState: FirebaseProfileInitialState,
  root: RootIdentity,
  platform: NodeJS.Platform,
): readonly string[] {
  if (initialState.version !== 1
    || typeof initialState.registryExisted !== 'boolean'
    || typeof initialState.settingsExisted !== 'boolean'
    || typeof initialState.freshBootstrap !== 'boolean'
    || !Array.isArray(initialState.recoveryEvidencePaths)
    || !isBootstrapDecisionEvidence(initialState.bootstrapDecisionEvidence)
    || (!initialState.registryExisted
      && !initialState.settingsExisted
      && !initialState.freshBootstrap)
    || !sameRootIdentity(initialState.rootIdentity, root, platform)) {
    throw new Error('Firebase initial profile state parent directory identity changed')
  }
  verifyBootstrapDecisionEvidence(initialState.bootstrapDecisionEvidence, root, platform)
  return bindRecoveryEvidencePaths(initialState.recoveryEvidencePaths, platform)
}

function assertRestoreProtocolQuiescent(root: RootIdentity, platform: NodeJS.Platform): void {
  assertRootIdentity(root, platform)
  const entries = fs.readdirSync(root.requestedPath)
    .map(name => comparableEntryName(name, platform))
  const restoreIntent = comparableEntryName(RESTORE_INTENT_FILE, platform)
  const restoreStaging = comparableEntryName(RESTORE_STAGING_DIR, platform)
  const restoreTombstone = comparableEntryName(RESTORE_INTENT_TOMBSTONE_PREFIX, platform)
  if (entries.includes(restoreIntent)
    || entries.includes(restoreStaging)
    || entries.some(name => name.startsWith(restoreTombstone))) {
    throw new Error('Firebase settings restore protocol is still active or awaiting cleanup')
  }
  assertRootIdentity(root, platform)
}

function verifyEligibilitySnapshot(
  snapshot: FirebaseProfileEligibilitySnapshot,
  root: RootIdentity,
  platform: NodeJS.Platform,
  afterFirstRead?: (target: string) => void,
): void {
  if (snapshot.version !== 1 || !sameRootIdentity(snapshot.rootIdentity, root, platform)) {
    throw new Error('Firebase eligibility snapshot parent directory identity changed')
  }
  if (!isBootstrapDecisionEvidence(snapshot.bootstrapDecisionEvidence)) {
    throw new Error('Firebase bootstrap decision snapshot is invalid')
  }
  verifyBootstrapDecisionEvidence(snapshot.bootstrapDecisionEvidence, root, platform)
  const settingsPath = path.join(root.requestedPath, 'settings.json')
  if (snapshot.kind === 'registry-present') {
    if (!optionalLstat(path.join(root.requestedPath, FIREBASE_PERSISTENCE_REGISTRY_FILE))) {
      throw new Error('Firebase registry disappeared after eligibility snapshot')
    }
    return
  }
  if (snapshot.kind === 'settings-invalid') {
    throw new Error('Firebase settings recovery must complete before registry publication')
  }
  assertRestoreProtocolQuiescent(root, platform)
  assertFreshBootstrapEvidence(snapshot, root, platform)
  const evidenceConfig = snapshot.legacyConfig ?? DEFAULT_FIREBASE_CONFIG
  const browserEvidence = scanBrowserPersistenceEvidence(
    root,
    platform,
    evidenceConfig,
    afterFirstRead,
  )
  if (browserEvidence.state !== snapshot.browserEvidence.state
    || browserEvidence.fingerprint !== snapshot.browserEvidence.fingerprint
    || browserEvidence.publicAuthKey !== snapshot.browserEvidence.publicAuthKey
    || browserEvidence.fnvAuthKey !== snapshot.browserEvidence.fnvAuthKey) {
    throw new Error('Firebase browser persistence evidence changed after eligibility snapshot')
  }
  verifyBootstrapDecisionEvidence(snapshot.bootstrapDecisionEvidence, root, platform)
  if (snapshot.kind === 'settings-absent') {
    if (optionalLstat(settingsPath)) {
      throw new Error('Firebase settings appeared after fresh eligibility snapshot')
    }
    assertRestoreProtocolQuiescent(root, platform)
    assertFreshBootstrapEvidence(snapshot, root, platform)
    verifyBootstrapDecisionEvidence(snapshot.bootstrapDecisionEvidence, root, platform)
    return
  }
  if (snapshot.kind === 'settings-validated-from-absence') {
    if (!snapshot.settingsIdentity || !snapshot.settingsEvidenceSha256) {
      throw new Error('Firebase post-validation settings evidence is incomplete')
    }
    const stable = readBoundedRegularFile(
      settingsPath,
      root,
      platform,
      MAX_SETTINGS_SNAPSHOT_BYTES,
    )
    if (!sameStableFileIdentity(snapshot.settingsIdentity, stable.identity)
      || sha256Bytes(stable.bytes) !== snapshot.settingsEvidenceSha256) {
      throw new Error('Firebase settings changed after strict validation')
    }
    const currentConfig = parseStrictSettingsFile(stable.bytes).config
    if (snapshot.legacyConfig
      && canonicalFirebaseConfig(currentConfig) !== canonicalFirebaseConfig(snapshot.legacyConfig)) {
      throw new Error('Firebase post-validation settings configuration changed')
    }
    assertRestoreProtocolQuiescent(root, platform)
    assertFreshBootstrapEvidence(snapshot, root, platform)
    verifyBootstrapDecisionEvidence(snapshot.bootstrapDecisionEvidence, root, platform)
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
  assertRestoreProtocolQuiescent(root, platform)
  assertFreshBootstrapEvidence(snapshot, root, platform)
  verifyBootstrapDecisionEvidence(snapshot.bootstrapDecisionEvidence, root, platform)
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
      Math.max(MAX_REGISTRY_BYTES, expectedBytes.byteLength),
    )
    if (!sameObjectIdentity(candidateIdentity, stable.identity)
      || !stable.bytes.equals(expectedBytes)) return
    const finalStats = fs.lstatSync(candidatePath)
    if (finalStats.isSymbolicLink()
      || !finalStats.isFile()
      || !sameObjectIdentity(candidateIdentity, toFileIdentity(finalStats))
      || !sameStableFileIdentity(stable.identity, toFileIdentity(finalStats))) return
    fs.unlinkSync(candidatePath)
  } catch {
    // Leave uncertain evidence in place. Unknown/foreign candidates are never scanned or removed.
  }
}

function prepareBootstrapRegistryResolution(
  document: RegistryDocument,
  snapshot: FirebaseProfileEligibilitySnapshot,
  root: RootIdentity,
  platform: NodeJS.Platform,
): {
  document: RegistryDocument
  snapshot: FirebaseProfileEligibilitySnapshot
  marker: StableReadResult | null
  needsResolution: boolean
} {
  const resolution = readBootstrapResolution(root, platform)
  const revocation = readBootstrapRevocation(root, platform)
  if (resolution) {
    const claim = resolution.document.registry.legacyClaim
    if ((claim && (!snapshot.legacyConfig
      || canonicalFirebaseConfig(snapshot.legacyConfig) !== claim.canonicalConfig))
      || (!claim && revocation)) {
      throw new Error('Firebase bootstrap resolution does not match strictly validated settings')
    }
    return {
      document: resolution.document.registry,
      snapshot,
      marker: null,
      needsResolution: false,
    }
  }

  const markerPath = path.join(root.requestedPath, FIREBASE_PROFILE_BOOTSTRAP_FILE)
  const marker = optionalLstat(markerPath)
    ? readFreshBootstrapEvidence(root, platform)
    : null
  if (revocation && !document.legacyClaim) {
    throw new Error('Firebase revoked bootstrap evidence cannot publish a fresh registry')
  }
  if (document.legacyClaim && marker && !revocation) {
    publishBootstrapRevocation(root, platform, marker)
  }
  const decisionEvidence = captureBootstrapDecisionEvidence(root, platform)
  const publicationSnapshot = document.legacyClaim && marker
    ? Object.freeze({
        ...snapshot,
        freshBootstrap: false,
        bootstrapDecisionEvidence: decisionEvidence,
      })
    : snapshot
  return {
    document,
    snapshot: publicationSnapshot,
    marker,
    needsResolution: Boolean(marker),
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
  assertRootIdentity(root, platform)
  verifyEligibilitySnapshot(snapshot, root, platform, options.afterFirstFileRead)
  const prepared = prepareBootstrapRegistryResolution(document, snapshot, root, platform)
  const publicationDocument = prepared.document
  const publicationSnapshot = prepared.snapshot
  const bytes = serializeRegistry(publicationDocument)
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
    verifyEligibilitySnapshot(publicationSnapshot, root, platform, options.afterFirstFileRead)
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
    if (sha256Bytes(serializeRegistry(winner)) !== sha256Bytes(bytes)) {
      throw new Error('Firebase registry winner conflicts with the validated bootstrap resolution')
    }
    verifyBootstrapDecisionEvidence(
      publicationSnapshot.bootstrapDecisionEvidence,
      root,
      platform,
    )
    if (prepared.needsResolution) {
      if (!prepared.marker) throw new Error('Firebase bootstrap resolution marker is missing')
      publishBootstrapResolution(root, platform, winner, prepared.marker)
      const resolved = readBootstrapResolution(root, platform)
      if (!resolved
        || resolved.document.registrySha256 !== sha256Bytes(serializeRegistry(winner))) {
        throw new Error('Firebase bootstrap registry resolution publication failed')
      }
      captureBootstrapDecisionEvidence(root, platform)
    }
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

function reconcileExistingRegistryBootstrapDecision(
  document: RegistryDocument,
  snapshot: FirebaseProfileEligibilitySnapshot,
  root: RootIdentity,
  platform: NodeJS.Platform,
  afterFirstRead?: (target: string) => void,
): void {
  verifyEligibilitySnapshot(snapshot, root, platform, afterFirstRead)
  const resolution = readBootstrapResolution(root, platform)
  const revocation = readBootstrapRevocation(root, platform)
  if (resolution) {
    if (resolution.document.registrySha256 !== sha256Bytes(serializeRegistry(document))
      || (!document.legacyClaim && revocation)) {
      throw new Error('Firebase existing registry conflicts with bootstrap decision evidence')
    }
    verifyBootstrapDecisionEvidence(snapshot.bootstrapDecisionEvidence, root, platform)
    return
  }

  const markerPath = path.join(root.requestedPath, FIREBASE_PROFILE_BOOTSTRAP_FILE)
  const marker = optionalLstat(markerPath)
    ? readFreshBootstrapEvidence(root, platform, afterFirstRead)
    : null
  if (revocation && !document.legacyClaim) {
    throw new Error('Firebase fresh registry conflicts with revoked bootstrap evidence')
  }
  if (marker || revocation) {
    if (!marker) throw new Error('Firebase bootstrap marker is missing from decision evidence')
    if (document.legacyClaim && !revocation) {
      publishBootstrapRevocation(root, platform, marker)
    }
    publishBootstrapResolution(root, platform, document, marker)
    const published = readBootstrapResolution(root, platform)
    if (!published
      || published.document.registrySha256 !== sha256Bytes(serializeRegistry(document))) {
      throw new Error('Firebase existing registry bootstrap resolution backfill failed')
    }
    captureBootstrapDecisionEvidence(root, platform)
  }
}

/**
 * Read immutable registry and legacy profile evidence. Main passes the
 * pre-constructor existence state so settings contents are read only after
 * SettingsStore has completed strict validation or verified recovery.
 */
export function detectPreexistingFirebaseProfile(
  userDataPath: string,
  options: FirebaseProfileSnapshotOptions = {},
): FirebaseProfileEligibilitySnapshot {
  const platform = options.platform ?? process.platform
  ensureUserDataRoot(userDataPath, platform, options.beforeRootCreate)
  const root = captureRootIdentity(userDataPath, platform)
  const initialRecoveryEvidencePaths = options.initialState
    ? assertInitialState(options.initialState, root, platform)
    : Object.freeze([] as string[])
  const bootstrapDecisionEvidence = options.initialState
    ? cloneBootstrapDecisionEvidence(options.initialState.bootstrapDecisionEvidence)
    : captureBootstrapDecisionEvidence(root, platform)
  const recoveryEvidencePaths = mergeRecoveryEvidencePaths(
    initialRecoveryEvidencePaths,
    options.recoveryEvidencePaths ?? [],
    platform,
  )
  const registryPath = path.join(root.requestedPath, FIREBASE_PERSISTENCE_REGISTRY_FILE)
  const registryStats = optionalLstat(registryPath)
  if (options.initialState?.registryExisted && !registryStats) {
    throw new Error('Firebase registry disappeared during settings validation')
  }
  if (registryStats) {
    const browserEvidence = Object.freeze({
      state: 'absent' as const,
      fingerprint: sha256('registry-present'),
      publicAuthKey: false,
      fnvAuthKey: false,
    })
    return Object.freeze({
      version: 1 as const,
      existed: false,
      kind: 'registry-present' as const,
      legacyConfig: null,
      settingsEvidenceSha256: null,
      rootIdentity: Object.freeze({ ...root }),
      settingsIdentity: null,
      browserEvidence,
      freshBootstrap: options.initialState?.freshBootstrap ?? false,
      recoveryEvidencePaths,
      bootstrapDecisionEvidence,
    })
  }
  const settingsPath = path.join(root.requestedPath, 'settings.json')
  const stats = optionalLstat(settingsPath)
  if (options.initialState) {
    assertRestoreProtocolQuiescent(root, platform)
    if (!stats) {
      if (options.initialState.settingsExisted) {
        throw new Error('Firebase settings disappeared during strict validation')
      }
      const browserEvidence = scanBrowserPersistenceEvidence(
        root,
        platform,
        DEFAULT_FIREBASE_CONFIG,
        options.afterFirstFileRead,
      )
      const hasBrowserClaim = browserEvidence.publicAuthKey || browserEvidence.fnvAuthKey
      return Object.freeze({
        version: 1 as const,
        existed: hasBrowserClaim,
        kind: 'settings-absent' as const,
        legacyConfig: hasBrowserClaim ? Object.freeze({ ...DEFAULT_FIREBASE_CONFIG }) : null,
        settingsEvidenceSha256: null,
        rootIdentity: Object.freeze({ ...root }),
        settingsIdentity: null,
        browserEvidence: Object.freeze({ ...browserEvidence }),
        freshBootstrap: options.initialState.freshBootstrap,
        recoveryEvidencePaths,
        bootstrapDecisionEvidence,
      })
    }

    const stable = readBoundedRegularFile(
      settingsPath,
      root,
      platform,
      MAX_SETTINGS_SNAPSHOT_BYTES,
      options.afterFirstFileRead,
    )
    const config = parseStrictSettingsFile(stable.bytes).config
    const browserEvidence = scanBrowserPersistenceEvidence(
      root,
      platform,
      config,
      options.afterFirstFileRead,
    )
    const hasBrowserClaim = browserEvidence.publicAuthKey || browserEvidence.fnvAuthKey
    if (!options.initialState.settingsExisted) {
      return Object.freeze({
        version: 1 as const,
        existed: hasBrowserClaim,
        kind: 'settings-validated-from-absence' as const,
        legacyConfig: hasBrowserClaim ? Object.freeze({ ...config }) : null,
        settingsEvidenceSha256: sha256Bytes(stable.bytes),
        rootIdentity: Object.freeze({ ...root }),
        settingsIdentity: Object.freeze({ ...stable.identity }),
        browserEvidence: Object.freeze({ ...browserEvidence }),
        freshBootstrap: options.initialState.freshBootstrap,
        recoveryEvidencePaths,
        bootstrapDecisionEvidence,
      })
    }
    return Object.freeze({
      version: 1 as const,
      existed: true,
      kind: 'settings-snapshot' as const,
      legacyConfig: Object.freeze({ ...config }),
      settingsEvidenceSha256: sha256Bytes(stable.bytes),
      rootIdentity: Object.freeze({ ...root }),
      settingsIdentity: Object.freeze({ ...stable.identity }),
      browserEvidence: Object.freeze({ ...browserEvidence }),
      freshBootstrap: options.initialState.freshBootstrap,
      recoveryEvidencePaths,
      bootstrapDecisionEvidence,
    })
  }
  if (!stats) {
    const browserEvidence = scanBrowserPersistenceEvidence(
      root,
      platform,
      DEFAULT_FIREBASE_CONFIG,
      options.afterFirstFileRead,
    )
    const hasBrowserClaim = browserEvidence.publicAuthKey || browserEvidence.fnvAuthKey
    return Object.freeze({
      version: 1 as const,
      existed: hasBrowserClaim,
      kind: 'settings-absent' as const,
      legacyConfig: hasBrowserClaim ? Object.freeze({ ...DEFAULT_FIREBASE_CONFIG }) : null,
      settingsEvidenceSha256: null,
      rootIdentity: Object.freeze({ ...root }),
      settingsIdentity: null,
      browserEvidence: Object.freeze({ ...browserEvidence }),
      freshBootstrap: false,
      recoveryEvidencePaths,
      bootstrapDecisionEvidence,
    })
  }
  const stable = readBoundedRegularFile(
    settingsPath,
    root,
    platform,
    MAX_SETTINGS_SNAPSHOT_BYTES,
    options.afterFirstFileRead,
  )
  let legacyConfig: FirebaseConfig
  try {
    legacyConfig = parseReleasedSettingsFirebase(stable.bytes)
  } catch {
    const browserEvidence = scanBrowserPersistenceEvidence(
      root,
      platform,
      DEFAULT_FIREBASE_CONFIG,
      options.afterFirstFileRead,
    )
    return Object.freeze({
      version: 1 as const,
      existed: true,
      kind: 'settings-invalid' as const,
      legacyConfig: null,
      settingsEvidenceSha256: sha256Bytes(stable.bytes),
      rootIdentity: Object.freeze({ ...root }),
      settingsIdentity: Object.freeze({ ...stable.identity }),
      browserEvidence: Object.freeze({ ...browserEvidence }),
      freshBootstrap: false,
      recoveryEvidencePaths,
      bootstrapDecisionEvidence,
    })
  }
  const browserEvidence = scanBrowserPersistenceEvidence(
    root,
    platform,
    legacyConfig,
    options.afterFirstFileRead,
  )
  return Object.freeze({
    version: 1 as const,
    existed: true,
    kind: 'settings-snapshot' as const,
    legacyConfig: Object.freeze({ ...legacyConfig }),
    settingsEvidenceSha256: sha256Bytes(stable.bytes),
    rootIdentity: Object.freeze({ ...root }),
    settingsIdentity: Object.freeze({ ...stable.identity }),
    browserEvidence: Object.freeze({ ...browserEvidence }),
    freshBootstrap: false,
    recoveryEvidencePaths,
    bootstrapDecisionEvidence,
  })
}

type StrictAppSettings = ReturnType<typeof parseAppSettingsWithLegacyDefaults>

function canonicalStrictSettings(settings: StrictAppSettings): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (!isPlainRecord(value)) return value
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = normalize(value[key])
    }
    return result
  }
  return JSON.stringify(normalize(settings))
}

function sameStrictSettings(left: StrictAppSettings, right: StrictAppSettings): boolean {
  return canonicalStrictSettings(left) === canonicalStrictSettings(right)
}

function strictSettings(value: unknown): StrictAppSettings {
  let settings: ReturnType<typeof parseAppSettingsWithLegacyDefaults>
  try {
    settings = parseAppSettingsWithLegacyDefaults(value)
  } catch {
    throw new Error('Firebase validated settings failed strict application validation')
  }
  return settings
}

function strictSettingsFirebase(value: StrictAppSettings): FirebaseConfig {
  const settings = value
  if (settings.firebase === null) {
    return parseFirebaseConfig(DEFAULT_FIREBASE_CONFIG)
  }
  try {
    return parseFirebaseConfig(settings.firebase)
  } catch {
    throw new Error('Firebase validated settings configuration is invalid')
  }
}

function parseStrictSettingsFile(bytes: Buffer): {
  config: FirebaseConfig
  settings: StrictAppSettings
} {
  let value: unknown
  try {
    const raw = bytes.toString('utf8')
    value = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
  } catch {
    throw new Error('Firebase settings file is invalid after strict validation')
  }
  let settings: StrictAppSettings
  try {
    settings = strictSettings(value)
  } catch {
    throw new Error('Firebase settings file failed strict application validation')
  }
  return { settings, config: strictSettingsFirebase(settings) }
}

function completeRecoveredEligibility(
  userDataPath: string,
  snapshot: FirebaseProfileEligibilitySnapshot,
  recoveredSettings: unknown,
  options: FirebasePersistenceRegistryOptions,
): FirebaseProfileEligibilitySnapshot {
  if (snapshot.kind !== 'settings-invalid') {
    throw new Error('Firebase settings recovery snapshot is invalid')
  }
  const platform = options.platform ?? process.platform
  const root = captureRootIdentity(userDataPath, platform)
  if (!sameRootIdentity(snapshot.rootIdentity, root, platform)) {
    throw new Error('Firebase settings recovery parent directory identity changed')
  }
  assertRestoreProtocolQuiescent(root, platform)
  const stable = readBoundedRegularFile(
    path.join(root.requestedPath, 'settings.json'),
    root,
    platform,
    MAX_SETTINGS_SNAPSHOT_BYTES,
    options.afterFirstFileRead,
  )
  const currentSettings = parseStrictSettingsFile(stable.bytes)
  const suppliedSettings = strictSettings(recoveredSettings)
  const config = currentSettings.config
  const suppliedConfig = strictSettingsFirebase(suppliedSettings)
  if (!sameStrictSettings(currentSettings.settings, suppliedSettings)) {
    throw new Error('Firebase recovered settings do not match the SettingsStore result')
  }
  if (canonicalFirebaseConfig(config) !== canonicalFirebaseConfig(suppliedConfig)) {
    throw new Error('Firebase recovered settings do not match the verified primary file')
  }
  const browserEvidence = scanBrowserPersistenceEvidence(
    root,
    platform,
    config,
    options.afterFirstFileRead,
  )
  if (browserEvidence.state !== snapshot.browserEvidence.state
    || browserEvidence.fingerprint !== snapshot.browserEvidence.fingerprint) {
    throw new Error('Firebase browser persistence changed during settings recovery')
  }
  return Object.freeze({
    version: 1 as const,
    existed: true,
    kind: 'settings-recovered' as const,
    legacyConfig: Object.freeze({ ...config }),
    settingsEvidenceSha256: sha256Bytes(stable.bytes),
    rootIdentity: Object.freeze({ ...root }),
    settingsIdentity: Object.freeze({ ...stable.identity }),
    browserEvidence: Object.freeze({ ...browserEvidence }),
    freshBootstrap: snapshot.freshBootstrap,
    recoveryEvidencePaths: snapshot.recoveryEvidencePaths,
    bootstrapDecisionEvidence: cloneBootstrapDecisionEvidence(snapshot.bootstrapDecisionEvidence),
  })
}

function completeValidatedEligibility(
  userDataPath: string,
  snapshot: FirebaseProfileEligibilitySnapshot,
  validatedSettings: unknown,
  options: FirebasePersistenceRegistryOptions,
): FirebaseProfileEligibilitySnapshot {
  if (snapshot.kind === 'settings-invalid') {
    return completeRecoveredEligibility(userDataPath, snapshot, validatedSettings, options)
  }
  const platform = options.platform ?? process.platform
  const root = captureRootIdentity(userDataPath, platform)
  if (!sameRootIdentity(snapshot.rootIdentity, root, platform)) {
    throw new Error('Firebase settings validation parent directory identity changed')
  }
  assertRestoreProtocolQuiescent(root, platform)
  const suppliedSettings = strictSettings(validatedSettings)
  const suppliedConfig = strictSettingsFirebase(suppliedSettings)
  if (snapshot.kind === 'registry-present') return snapshot
  const settingsPath = path.join(root.requestedPath, 'settings.json')
  const settingsStats = optionalLstat(settingsPath)
  if (snapshot.kind === 'settings-absent') {
    const expectedConfig = snapshot.legacyConfig ?? DEFAULT_FIREBASE_CONFIG
    if (canonicalFirebaseConfig(suppliedConfig) !== canonicalFirebaseConfig(expectedConfig)) {
      throw new Error('Firebase initially absent settings changed configuration during validation')
    }
    if (!settingsStats) return snapshot
    const stable = readBoundedRegularFile(
      settingsPath,
      root,
      platform,
      MAX_SETTINGS_SNAPSHOT_BYTES,
      options.afterFirstFileRead,
    )
    const currentSettings = parseStrictSettingsFile(stable.bytes)
    const currentConfig = currentSettings.config
    if (!sameStrictSettings(currentSettings.settings, suppliedSettings)) {
      throw new Error('Firebase settings created during validation do not match SettingsStore')
    }
    if (canonicalFirebaseConfig(currentConfig) !== canonicalFirebaseConfig(suppliedConfig)) {
      throw new Error('Firebase settings created during validation do not match SettingsStore')
    }
    return Object.freeze({
      ...snapshot,
      kind: 'settings-validated-from-absence' as const,
      settingsEvidenceSha256: sha256Bytes(stable.bytes),
      settingsIdentity: Object.freeze({ ...stable.identity }),
      browserEvidence: Object.freeze({ ...snapshot.browserEvidence }),
    })
  }
  if (snapshot.kind === 'settings-validated-from-absence') {
    if (!settingsStats || !snapshot.settingsIdentity || !snapshot.settingsEvidenceSha256) {
      throw new Error('Firebase post-validation settings snapshot is incomplete')
    }
    const stable = readBoundedRegularFile(
      settingsPath,
      root,
      platform,
      MAX_SETTINGS_SNAPSHOT_BYTES,
      options.afterFirstFileRead,
    )
    if (!sameStableFileIdentity(snapshot.settingsIdentity, stable.identity)
      || sha256Bytes(stable.bytes) !== snapshot.settingsEvidenceSha256) {
      throw new Error('Firebase settings changed after strict validation')
    }
    const currentSettings = parseStrictSettingsFile(stable.bytes)
    const currentConfig = currentSettings.config
    if (!sameStrictSettings(currentSettings.settings, suppliedSettings)) {
      throw new Error('Firebase post-validation settings do not match SettingsStore')
    }
    if (canonicalFirebaseConfig(currentConfig) !== canonicalFirebaseConfig(suppliedConfig)
      || (snapshot.legacyConfig
        && canonicalFirebaseConfig(currentConfig) !== canonicalFirebaseConfig(snapshot.legacyConfig))) {
      throw new Error('Firebase post-validation settings do not match SettingsStore')
    }
    return Object.freeze({
      ...snapshot,
      browserEvidence: Object.freeze({ ...snapshot.browserEvidence }),
    })
  }
  if (!settingsStats
    || !snapshot.settingsIdentity
    || !snapshot.settingsEvidenceSha256
    || !snapshot.legacyConfig) {
    throw new Error('Firebase validated settings snapshot is incomplete')
  }
  const stable = readBoundedRegularFile(
    settingsPath,
    root,
    platform,
    MAX_SETTINGS_SNAPSHOT_BYTES,
    options.afterFirstFileRead,
  )
  if (!sameStableFileIdentity(snapshot.settingsIdentity, stable.identity)
    || sha256Bytes(stable.bytes) !== snapshot.settingsEvidenceSha256) {
    throw new Error('Firebase settings changed after strict validation')
  }
  const currentSettings = parseStrictSettingsFile(stable.bytes)
  const currentConfig = currentSettings.config
  if (!sameStrictSettings(currentSettings.settings, suppliedSettings)) {
    throw new Error('Firebase validated settings do not match SettingsStore')
  }
  if (canonicalFirebaseConfig(currentConfig) !== canonicalFirebaseConfig(suppliedConfig)
    || canonicalFirebaseConfig(currentConfig) !== canonicalFirebaseConfig(snapshot.legacyConfig)) {
    throw new Error('Firebase strictly validated settings configuration changed')
  }
  return snapshot
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
    let document: RegistryDocument
    if (existing) {
      document = readRegistry(registryPath, root, platform, options.afterFirstFileRead)
      reconcileExistingRegistryBootstrapDecision(
        document,
        snapshot,
        root,
        platform,
        options.afterFirstFileRead,
      )
    } else {
      document = publishImmutableRegistry(
        registryPath,
        makeRegistryDocument(snapshot),
        snapshot,
        root,
        options,
      )
    }
    return new FirebasePersistenceRegistry(document)
  }

  /** Publish only after SettingsStore has finished verified corrupt-primary recovery. */
  static openAfterSettingsRecovery(
    userDataPath: string,
    snapshot: FirebaseProfileEligibilitySnapshot,
    recoveredSettings: unknown,
    options: FirebasePersistenceRegistryOptions = {},
  ): FirebasePersistenceRegistry {
    return FirebasePersistenceRegistry.openAfterSettingsValidation(
      userDataPath,
      snapshot,
      recoveredSettings,
      options,
    )
  }

  /** Publish only after SettingsStore strict validation and pair recovery have both completed. */
  static openAfterSettingsValidation(
    userDataPath: string,
    snapshot: FirebaseProfileEligibilitySnapshot,
    validatedSettings: unknown,
    options: FirebasePersistenceRegistryOptions = {},
  ): FirebasePersistenceRegistry {
    const completed = completeValidatedEligibility(
      userDataPath,
      snapshot,
      validatedSettings,
      options,
    )
    return FirebasePersistenceRegistry.open(userDataPath, completed, options)
  }

  /** Main canonicalizes the exact config and never accepts a renderer fingerprint/path. */
  claim(configValue: unknown): FirebasePersistenceClaim {
    const config = parseFirebaseConfig(configValue)
    const digest = getDigestFirebasePersistenceIdentity(config)
    const owned = this.document.legacyClaim?.canonicalConfig === digest.configIdentity
      ? this.document.legacyClaim
      : null
    if (owned?.appName === getUnreleasedFNVFirebaseAppName(config)) {
      return {
        version: 2,
        ownership: 'main-registry-fnv-evidence',
        configIdentity: digest.configIdentity,
        appName: owned.appName,
      }
    }
    return {
      version: 1,
      configIdentity: digest.configIdentity,
      appName: owned?.appName ?? digest.appName,
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
