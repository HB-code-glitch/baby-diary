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
    | 'settings-snapshot'
    | 'settings-invalid'
    | 'settings-recovered'
  readonly legacyConfig: FirebaseConfig | null
  readonly settingsEvidenceSha256: string | null
  readonly rootIdentity: RootIdentity
  readonly settingsIdentity: FileIdentity | null
  readonly browserEvidence: BrowserPersistenceEvidence
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
  while (offset < bytes.length) {
    const blockOffset = offset % blockSize
    const remainingInBlock = Math.min(blockSize - blockOffset, bytes.length - offset)
    if (remainingInBlock < 7) {
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
    if (type < 1 || type > 4 || length > remainingInBlock - 7 || offset + 7 + length > bytes.length) {
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
  if (fragments) throw new Error('Firebase LevelDB fragmented record is truncated')
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

interface LevelDbSequenceRange {
  first: LevelDbSequence
  last: LevelDbSequence
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
): LevelDbSequenceRange | null {
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
  const lastSequence = count > 0 ? addLevelDbSequence(baseSequence, count - 1) : null
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
  return lastSequence ? { first: baseSequence, last: lastSequence } : null
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
  let previousWalSequence: LevelDbSequence | null = null
  for (const { name } of liveLogs) {
    const bytes = readProtected(name, MAX_LEVELDB_FILE_BYTES)
    for (const batch of readLevelDbLogRecords(bytes)) {
      const range = inspectLevelDbWriteBatch(batch, authKeys, versions)
      if (!range) continue
      if (previousWalSequence) {
        const expected = addLevelDbSequence(previousWalSequence, 1)
        if (compareLevelDbSequence(range.first, expected) !== 0) {
          throw new Error('Firebase LevelDB live WAL sequences are not contiguous and ordered')
        }
      }
      previousWalSequence = range.last
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
    || (snapshot.kind === 'settings-absent' && hasBrowserClaim)) {
    if (snapshot.legacyConfig === null) throw new Error('Firebase legacy profile eligibility is inconsistent')
    const config = parseFirebaseConfig(snapshot.legacyConfig)
    const canonicalConfig = canonicalFirebaseConfig(config)
    const fnvOnly = !snapshot.browserEvidence.publicAuthKey && snapshot.browserEvidence.fnvAuthKey
    const appName = fnvOnly ? getUnreleasedFNVFirebaseAppName(config) : LEGACY_FIREBASE_APP_NAME
    const evidenceKind = snapshot.kind === 'settings-absent'
      ? 'browser-persistence'
      : snapshot.kind === 'settings-recovered'
        ? 'settings-recovered'
        : 'settings-snapshot'
    const evidenceHash = snapshot.kind === 'settings-absent'
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
  afterFirstRead?: (target: string) => void,
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
  if (snapshot.kind === 'settings-invalid') {
    throw new Error('Firebase settings recovery must complete before registry publication')
  }
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
    verifyEligibilitySnapshot(snapshot, root, platform, options.afterFirstFileRead)
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
    verifyEligibilitySnapshot(snapshot, root, platform, options.afterFirstFileRead)
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
    })
  }
  const settingsPath = path.join(root.requestedPath, 'settings.json')
  const stats = optionalLstat(settingsPath)
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
  })
}

function recoveredSettingsFirebase(value: unknown): FirebaseConfig {
  if (!isPlainRecord(value)) throw new Error('Firebase recovered settings are invalid')
  if (!Object.prototype.hasOwnProperty.call(value, 'firebase') || value.firebase === null) {
    return parseFirebaseConfig(DEFAULT_FIREBASE_CONFIG)
  }
  try {
    return parseFirebaseConfig(value.firebase)
  } catch {
    throw new Error('Firebase recovered settings configuration is invalid')
  }
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
  if (optionalLstat(path.join(root.requestedPath, RESTORE_INTENT_FILE))
    || optionalLstat(path.join(root.requestedPath, RESTORE_STAGING_DIR))) {
    throw new Error('Firebase settings recovery protocol is still in progress')
  }
  const stable = readBoundedRegularFile(
    path.join(root.requestedPath, 'settings.json'),
    root,
    platform,
    MAX_SETTINGS_SNAPSHOT_BYTES,
    options.afterFirstFileRead,
  )
  const config = parseReleasedSettingsFirebase(stable.bytes)
  const suppliedConfig = recoveredSettingsFirebase(recoveredSettings)
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

  /** Publish only after SettingsStore has finished verified corrupt-primary recovery. */
  static openAfterSettingsRecovery(
    userDataPath: string,
    snapshot: FirebaseProfileEligibilitySnapshot,
    recoveredSettings: unknown,
    options: FirebasePersistenceRegistryOptions = {},
  ): FirebasePersistenceRegistry {
    const completed = completeRecoveredEligibility(
      userDataPath,
      snapshot,
      recoveredSettings,
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
