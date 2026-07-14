import { createHash, randomBytes, randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { AppSettings } from '../../shared/types'
import { parseAppSettingsWithLegacyDefaults } from '../../shared/babyInfoSettingsCommit'
import { getBabyInfoMutationKey } from '../../shared/babyInfoResolver'
import {
  BABY_INFO_JOURNAL_FILE,
  BabyInfoJournal,
  parseBabyInfoJournalBuffer,
} from './babyInfoJournal'
import {
  atomicReplaceFileSync,
  writeAllSync,
  type DurableFileOps,
} from './durableFs'

export const BACKUP_MANIFEST_FILE = 'manifest.json'
export const RESTORE_INTENT_FILE = '.baby-info-pair-restore-v1.json'
export const RESTORE_STAGING_DIR = '.baby-info-pair-restore-v1'
export const RESTORE_STAGE_METADATA_FILE = 'restore-transaction.json'
export const RECOVERY_FORENSICS_DIR = 'recovery-forensics'

const SETTINGS_FILE = 'settings.json'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SNAPSHOT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const LEGACY_SNAPSHOT_NAME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/
const DATA_PATH_PATTERN = /^data\/[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/
const RESTORE_INTENT_TOMBSTONE_PATTERN = /^\.baby-info-pair-restore-v1\.json\.cleanup-[0-9a-f]{32}$/i
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024
const MAX_DATA_BYTES = 512 * 1024 * 1024
const MAX_TRANSACTION_BYTES = 1024 * 1024
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const STREAM_CHUNK_BYTES = 64 * 1024
const MAX_FORENSIC_ARCHIVE_ALLOCATION_ATTEMPTS = 64
const MAX_FORENSIC_ARCHIVES = 64
const MAX_CLEANUP_RESERVATION_ATTEMPTS = 64
const LEGACY_TRANSACTION_TIMESTAMP = new Date(0).toISOString()
let forensicStreamSequence = 0

function cleanupNonce(): string {
  return randomBytes(16).toString('hex')
}

export const DEFAULT_BACKUP_RESOURCE_LIMITS = Object.freeze({
  // Auxiliary evidence is sealed and revalidated with a constant-size fd set.
  // Preserve the historical on-disk compatibility boundary.
  maxSnapshotFiles: 4_096,
  maxCandidates: 1_024,
  maxTotalSnapshotBytes: 768 * 1024 * 1024,
})

export interface BackupResourceLimits {
  maxSnapshotFiles: number
  maxCandidates: number
  maxTotalSnapshotBytes: number
}

export interface BackupManifestEntry {
  path: string
  size: number
  sha256: string
}

export interface BackupManifest {
  version: 1
  source: 'baby-diary'
  snapshotTimestamp: string
  files: BackupManifestEntry[]
}

export interface VerifiedBackupPair {
  snapshotId: string
  snapshotTimestamp: string
  snapshotPath: string
  settings: AppSettings
  settingsBytes: Buffer
  journalBytes: Buffer
  legacy: boolean
}

interface DigestDescriptor {
  size: number
  sha256: string
}

interface LegacyRestoreIntentFile {
  version: 1
  snapshotId: string
  settings: DigestDescriptor
  journal: DigestDescriptor
}

interface LegacyRestoreTransactionFile {
  version: 2
  snapshotId: string
  snapshotTimestamp: string
  settings: DigestDescriptor
  journal: DigestDescriptor
  phase: 'prepared' | 'primary-verified'
  windowsVerifiedStartups: number
  forensicArchiveId: string
}

interface RestoreTransactionFile {
  version: 3
  snapshotId: string
  snapshotTimestamp: string
  settings: DigestDescriptor
  journal: DigestDescriptor
  phase: 'allocated' | 'prepared' | 'awaiting-windows-confirmation' | 'primary-verified'
  windowsVerifiedStartups: number
  lastWindowsStartupId: string
  forensicArchiveId: string
  forensicManifest: DigestDescriptor | null
}

type ParsedRestoreIntent = LegacyRestoreIntentFile | LegacyRestoreTransactionFile | RestoreTransactionFile

export interface BackupReadOptions {
  platform?: NodeJS.Platform
  now?: Date
  /** Injectable synchronous I/O used by recovery and durability tests. */
  durableFs?: DurableFileOps
  /** Tests may lower, but never raise, the production hard bounds. */
  limits?: Partial<BackupResourceLimits>
}

export interface RecoveryOptions extends BackupReadOptions {
  documentsBackupDir?: string
  /** Stable for one SettingsStore construction; a new process/startup must use a new value. */
  startupId?: string
}

type RecoveryReadOps = DurableFileOps & {
  readSync?(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number
}

type PositionalReadSync = (
  fd: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number,
) => number

const DEFAULT_DURABLE_OPS = fs as unknown as DurableFileOps

function resourceLimits(overrides: Partial<BackupResourceLimits> | undefined): BackupResourceLimits {
  const result = { ...DEFAULT_BACKUP_RESOURCE_LIMITS, ...overrides }
  for (const key of Object.keys(DEFAULT_BACKUP_RESOURCE_LIMITS) as Array<keyof BackupResourceLimits>) {
    const value = result[key]
    if (!Number.isSafeInteger(value)
      || value < 1
      || value > DEFAULT_BACKUP_RESOURCE_LIMITS[key]) {
      throw new Error(`backup resource limit is invalid: ${key}`)
    }
  }
  return result
}

function addSnapshotBytes(total: number, size: number, maximum: number): number {
  if (!Number.isSafeInteger(total)
    || !Number.isSafeInteger(size)
    || size < 0
    || total > maximum
    || size > maximum - total) {
    throw new Error('total snapshot bytes exceed the aggregate bound')
  }
  return total + size
}

export class SettingsRecoveryError extends Error {
  readonly code = 'SETTINGS_RECOVERY_REQUIRED' as const
  readonly recoverable = true as const

  constructor(
    message: string,
    readonly rejectedSnapshots: string[] = [],
    readonly originalsPreserved = false,
    readonly restartRequired = false,
    readonly primaryUntouched = false,
  ) {
    super(message)
    this.name = 'SettingsRecoveryError'
  }
}

export class SettingsRestoreFinalizationError extends SettingsRecoveryError {
  readonly restoreApplied = true as const
  readonly localDataModified = true as const

  constructor() {
    super(
      'The verified restore pair was written locally. One final independent application restart is required before the restored data can be opened.',
      [],
      true,
      true,
      false,
    )
    this.name = 'SettingsRestoreFinalizationError'
  }
}

export class SettingsRestoreFollowUpError extends SettingsRecoveryError {
  readonly restoreApplied = true as const
  readonly recoveryFollowUpRequired = true as const
  readonly localDataModified = true as const

  constructor(message: string, originalsPreserved: boolean) {
    super(message, [], originalsPreserved, false, false)
    this.name = 'SettingsRestoreFollowUpError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index])
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function descriptor(bytes: Uint8Array): DigestDescriptor {
  return { size: bytes.byteLength, sha256: sha256(bytes) }
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}

function parseSettingsBytes(bytes: Buffer): AppSettings {
  let value: unknown
  try {
    value = JSON.parse(stripBom(bytes.toString('utf8')))
  } catch {
    throw new Error('settings JSON is invalid')
  }
  return parseAppSettingsWithLegacyDefaults(value)
}

function isLegacySettings(settings: AppSettings): boolean {
  return settings.babyInfoJournal === undefined && settings.babyInfoRevision === undefined
}

function validateProjection(settings: AppSettings, journal: BabyInfoJournal): void {
  const metadata = settings.babyInfoJournal
  if (!metadata) {
    if (!isLegacySettings(settings) || journal.hasAnyRecords()) {
      throw new Error('journal-aware settings are missing projection metadata')
    }
    return
  }
  if (metadata.projectedFamilyId !== settings.familyId) {
    throw new Error('settings family and projected family differ')
  }
  if (!settings.familyId) {
    if (metadata.projectedWinnerKey !== undefined) {
      throw new Error('unlinked settings cannot project a journal winner')
    }
    return
  }

  const summary = journal.getSummary(settings.familyId)
  const winnerKey = summary.winner ? getBabyInfoMutationKey(summary.winner) : undefined
  if (winnerKey !== metadata.projectedWinnerKey) {
    throw new Error('projected winner does not match journal winner')
  }
  if (settings.baby.name !== (summary.winner?.babyName ?? '')
    || settings.baby.birthdate !== (summary.winner?.babyBirthdate ?? '')) {
    throw new Error('visible baby pair does not match projected journal winner')
  }
}

function strictTimestamp(value: string, now: Date): Date {
  if (!SNAPSHOT_TIMESTAMP_PATTERN.test(value)) {
    throw new Error('backup snapshot timestamp is invalid')
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error('backup snapshot timestamp is invalid')
  const canonical = new Date(milliseconds).toISOString()
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z')) {
    throw new Error('backup snapshot timestamp is not canonical')
  }
  if (milliseconds > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw new Error('backup snapshot timestamp is implausibly in the future')
  }
  return new Date(milliseconds)
}

function parseLegacySnapshotTimestamp(name: string, now: Date): string {
  const match = LEGACY_SNAPSHOT_NAME_PATTERN.exec(name)
  if (!match) throw new Error('legacy backup folder name is not canonical')
  const [, year, month, day, hour, minute, second] = match
  const timestamp = new Date(Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
  ))
  const canonicalName = timestamp.toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19)
  if (canonicalName !== name) throw new Error('legacy backup folder timestamp is invalid')
  if (timestamp.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) {
    throw new Error('legacy backup timestamp is implausibly in the future')
  }
  return timestamp.toISOString()
}

function parseManifest(raw: Buffer, now: Date, limits: BackupResourceLimits): BackupManifest {
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('backup manifest JSON is invalid')
  }
  if (!isRecord(value)
    || !exactKeys(value, ['version', 'source', 'snapshotTimestamp', 'files'])
    || value.version !== 1
    || value.source !== 'baby-diary'
    || typeof value.snapshotTimestamp !== 'string'
    || !Array.isArray(value.files)) {
    throw new Error('backup manifest shape is invalid')
  }
  strictTimestamp(value.snapshotTimestamp, now)
  if (value.files.length > limits.maxSnapshotFiles) {
    throw new Error('backup snapshot file-count bound exceeded')
  }

  const files: BackupManifestEntry[] = []
  let aggregateBytes = addSnapshotBytes(0, raw.byteLength, limits.maxTotalSnapshotBytes)
  for (const item of value.files) {
    if (!isRecord(item)
      || !exactKeys(item, ['path', 'size', 'sha256'])
      || typeof item.path !== 'string'
      || !Number.isSafeInteger(item.size)
      || (item.size as number) < 0
      || typeof item.sha256 !== 'string'
      || !SHA256_PATTERN.test(item.sha256)) {
      throw new Error('backup manifest entry is invalid')
    }
    aggregateBytes = addSnapshotBytes(
      aggregateBytes,
      item.size as number,
      limits.maxTotalSnapshotBytes,
    )
    files.push({ path: item.path, size: item.size as number, sha256: item.sha256 })
  }
  if (files.length < 2
    || files[0].path !== SETTINGS_FILE
    || files[1].path !== BABY_INFO_JOURNAL_FILE) {
    throw new Error('backup manifest is missing the settings/journal pair')
  }
  const dataPaths = files.slice(2).map(item => item.path)
  if (dataPaths.some(relativePath => !DATA_PATH_PATTERN.test(relativePath))
    || dataPaths.some((relativePath, index) => index > 0 && relativePath <= dataPaths[index - 1])
    || new Set(files.map(item => item.path)).size !== files.length) {
    throw new Error('backup manifest paths are invalid')
  }
  return {
    version: 1,
    source: 'baby-diary',
    snapshotTimestamp: value.snapshotTimestamp,
    files,
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function maximumFor(relativePath: string): number {
  if (relativePath === BACKUP_MANIFEST_FILE) return MAX_MANIFEST_BYTES
  if (relativePath === SETTINGS_FILE) return MAX_SETTINGS_BYTES
  if (relativePath === BABY_INFO_JOURNAL_FILE) return MAX_JOURNAL_BYTES
  if (relativePath === RESTORE_STAGE_METADATA_FILE || relativePath === RESTORE_INTENT_FILE) {
    return MAX_TRANSACTION_BYTES
  }
  if (relativePath === EVIDENCE_SPOOL_MARKER_FILE) return MAX_TRANSACTION_BYTES
  if (RESTORE_INTENT_TOMBSTONE_PATTERN.test(relativePath)) return MAX_TRANSACTION_BYTES
  if (DATA_PATH_PATTERN.test(relativePath)) return MAX_DATA_BYTES
  throw new Error(`file path is not allowlisted: ${relativePath}`)
}

function sameNodeIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.isFile() === right.isFile()
    && left.isDirectory() === right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.isFile() && right.isFile() && sameNodeIdentity(left, right)
}

interface OpenRegularFile {
  fd: number
  ops: DurableFileOps
  absolute: string
  beforeReal: string
  opened: fs.Stats
  relativePath: string
}

interface HeldEvidence<T> {
  value: T
  assertStable(): void
  completeCleanup?(): void
  preserve?(): void
  close(): void
}

interface ExpectedOpenRegularFile {
  source: OpenRegularFile
  expected: DigestDescriptor
}

function closeOpenRegularFiles(sources: readonly OpenRegularFile[]): void {
  for (let index = sources.length - 1; index >= 0; index -= 1) {
    sources[index].ops.closeSync(sources[index].fd)
  }
}

function openRegularFileOnce(
  root: string,
  relativePath: string,
  options: BackupReadOptions,
): OpenRegularFile {
  const normalized = relativePath.replace(/\\/g, '/')
  if (normalized !== relativePath
    || normalized.startsWith('/')
    || normalized.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`unsafe relative path: ${relativePath}`)
  }
  maximumFor(normalized)
  const resolvedRoot = path.resolve(root)
  const absolute = path.resolve(root, ...normalized.split('/'))
  if (!isWithin(resolvedRoot, absolute)) throw new Error(`path escapes snapshot root: ${relativePath}`)

  const rootReal = fs.realpathSync.native(resolvedRoot)
  const before = fs.lstatSync(absolute)
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`backup path is not a regular file: ${relativePath}`)
  }
  const beforeReal = fs.realpathSync.native(absolute)
  if (!isWithin(rootReal, beforeReal)) throw new Error(`backup path resolves outside its root: ${relativePath}`)

  const platform = options.platform ?? process.platform
  const ops = options.durableFs ?? DEFAULT_DURABLE_OPS
  const noFollow = platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0)
  const fd = ops.openSync(absolute, fs.constants.O_RDONLY | noFollow)
  try {
    const opened = ops.fstatSync(fd)
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error(`backup path identity changed while opening: ${relativePath}`)
    }
    if (opened.size > maximumFor(normalized)) {
      throw new Error(`backup file exceeds its size bound: ${relativePath}`)
    }
    return { fd, ops, absolute, beforeReal, opened, relativePath }
  } catch (error) {
    ops.closeSync(fd)
    throw error
  }
}

function assertOpenFileUnchanged(source: OpenRegularFile): void {
  let after: fs.Stats
  let current: fs.Stats
  let afterReal: string
  try {
    after = source.ops.fstatSync(source.fd)
    current = fs.lstatSync(source.absolute)
    afterReal = fs.realpathSync.native(source.absolute)
  } catch {
    throw new Error(`backup file or path changed during read: ${source.relativePath}`)
  }
  if (!sameFileIdentity(source.opened, after)
    || current.isSymbolicLink()
    || !sameFileIdentity(source.opened, current)) {
    throw new Error(`backup file changed during read: ${source.relativePath}`)
  }
  if (afterReal !== source.beforeReal) {
    throw new Error(`backup path changed during read: ${source.relativePath}`)
  }
}

function positionalReadSync(options: BackupReadOptions): PositionalReadSync {
  const recoveryOps = options.durableFs as RecoveryReadOps | undefined
  return recoveryOps?.readSync
    ? recoveryOps.readSync.bind(recoveryOps)
    : fs.readSync.bind(fs)
}

function readOpenRegularFile(
  source: OpenRegularFile,
  options: BackupReadOptions,
): Buffer {
  const buffer = Buffer.alloc(source.opened.size)
  const readSync = positionalReadSync(options)
  let offset = 0
  while (offset < buffer.byteLength) {
    const requested = buffer.byteLength - offset
    const count = readSync(source.fd, buffer, offset, requested, offset)
    if (!Number.isInteger(count) || count <= 0 || count > requested) {
      throw new Error(`backup file changed during read: ${source.relativePath}`)
    }
    offset += count
  }
  return buffer
}

function hashOpenRegularFilePass(
  source: OpenRegularFile,
  options: BackupReadOptions,
): DigestDescriptor {
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(Math.min(STREAM_CHUNK_BYTES, Math.max(1, source.opened.size)))
  const readSync = positionalReadSync(options)
  let offset = 0
  while (offset < source.opened.size) {
    const requested = Math.min(chunk.byteLength, source.opened.size - offset)
    const count = readSync(source.fd, chunk, 0, requested, offset)
    if (!Number.isInteger(count) || count <= 0 || count > requested) {
      throw new Error(`backup file changed during read: ${source.relativePath}`)
    }
    hash.update(chunk.subarray(0, count))
    offset += count
  }
  return { size: source.opened.size, sha256: hash.digest('hex') }
}

function stableHashOpenRegularFile(
  source: OpenRegularFile,
  options: BackupReadOptions,
): DigestDescriptor {
  const first = hashOpenRegularFilePass(source, options)
  assertOpenFileUnchanged(source)
  const second = hashOpenRegularFilePass(source, options)
  assertOpenFileUnchanged(source)
  if (!sameDescriptor(first, second)) {
    throw new Error(`backup file changed between descriptor passes: ${source.relativePath}`)
  }
  return first
}

function assertOpenRegularFileContent(
  evidence: ExpectedOpenRegularFile,
  options: BackupReadOptions,
): void {
  const actual = hashOpenRegularFilePass(evidence.source, options)
  if (!sameDescriptor(actual, evidence.expected)) {
    throw new Error(`backup file content changed: ${evidence.source.relativePath}`)
  }
}

function assertHeldRegularFilesStable(
  evidence: readonly ExpectedOpenRegularFile[],
  options: BackupReadOptions,
): void {
  for (const item of evidence) assertOpenRegularFileContent(item, options)
  for (const item of evidence) assertOpenFileUnchanged(item.source)
}

function assertHeldRegularFileDescriptorsStable(
  evidence: readonly ExpectedOpenRegularFile[],
  options: BackupReadOptions,
): void {
  for (const item of evidence) assertOpenRegularFileContent(item, options)
  for (const item of evidence) {
    const after = item.source.ops.fstatSync(item.source.fd)
    if (!sameFileIdentity(item.source.opened, after)) {
      throw new Error(`held file descriptor changed: ${item.source.relativePath}`)
    }
  }
}

/**
 * Opens one allowlisted regular file without following links where supported,
 * validates path/handle identity, and returns the only Buffer used downstream.
 */
function readRegularFileOnce(
  root: string,
  relativePath: string,
  options: BackupReadOptions = {},
): Buffer {
  const source = openRegularFileOnce(root, relativePath, options)
  try {
    const buffer = readOpenRegularFile(source, options)
    assertOpenFileUnchanged(source)
    return buffer
  } finally {
    source.ops.closeSync(source.fd)
  }
}

function hashRegularFileOnce(
  root: string,
  relativePath: string,
  options: BackupReadOptions,
): DigestDescriptor {
  const source = openRegularFileOnce(root, relativePath, options)
  try {
    return stableHashOpenRegularFile(source, options)
  } finally {
    source.ops.closeSync(source.fd)
  }
}

interface StreamedJournalResult {
  descriptor: DigestDescriptor
  journal: BabyInfoJournal
}

function streamOpenJournal(
  source: OpenRegularFile,
  options: BackupReadOptions,
  replayOptions: {
    allowTornFinal: boolean
    requiredPrefix?: DigestDescriptor
    onChunk?: (bytes: Uint8Array) => void
  },
): StreamedJournalResult {
  const requiredPrefix = replayOptions.requiredPrefix
  if (requiredPrefix && source.opened.size < requiredPrefix.size) {
    throw new Error('primary-verified live journal does not retain the restored transaction lineage')
  }

  const fullHash = createHash('sha256')
  const prefixHash = requiredPrefix ? createHash('sha256') : undefined
  const chunk = Buffer.alloc(Math.min(STREAM_CHUNK_BYTES, Math.max(1, source.opened.size)))
  const readSync = positionalReadSync(options)
  const replay = BabyInfoJournal.createChunkReplay({ allowTornFinal: replayOptions.allowTornFinal })
  let offset = 0
  while (offset < source.opened.size) {
    const requested = Math.min(chunk.byteLength, source.opened.size - offset)
    const count = readSync(source.fd, chunk, 0, requested, offset)
    if (!Number.isInteger(count) || count <= 0 || count > requested) {
      throw new Error(`backup file changed during read: ${BABY_INFO_JOURNAL_FILE}`)
    }
    const bytes = chunk.subarray(0, count)
    replayOptions.onChunk?.(bytes)
    fullHash.update(bytes)
    if (requiredPrefix && offset < requiredPrefix.size) {
      const prefixCount = Math.min(count, requiredPrefix.size - offset)
      prefixHash!.update(bytes.subarray(0, prefixCount))
    }
    replay.push(bytes)
    offset += count
  }

  const journal = replay.finish()
  const first = { size: source.opened.size, sha256: fullHash.digest('hex') }
  assertOpenFileUnchanged(source)
  if (requiredPrefix && prefixHash!.digest('hex') !== requiredPrefix.sha256) {
    throw new Error('primary-verified live journal does not retain the restored transaction lineage')
  }
  const second = hashOpenRegularFilePass(source, options)
  assertOpenFileUnchanged(source)
  if (!sameDescriptor(first, second)) {
    throw new Error(`backup file changed between descriptor passes: ${BABY_INFO_JOURNAL_FILE}`)
  }
  return { descriptor: first, journal }
}

function streamJournalOnce(
  root: string,
  options: BackupReadOptions,
  replayOptions: {
    allowTornFinal: boolean
    requiredPrefix?: DigestDescriptor
  },
): StreamedJournalResult {
  const source = openRegularFileOnce(root, BABY_INFO_JOURNAL_FILE, options)
  try {
    return streamOpenJournal(source, options, replayOptions)
  } finally {
    source.ops.closeSync(source.fd)
  }
}

function streamRegularFileToStaging(
  sourceRoot: string,
  relativePath: string,
  destination: string,
  options: BackupReadOptions,
): DigestDescriptor {
  const source = openRegularFileOnce(sourceRoot, relativePath, options)
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(Math.min(STREAM_CHUNK_BYTES, Math.max(1, source.opened.size)))
  const readSync = positionalReadSync(options)
  let destinationFd: number | undefined
  let destinationCreated = false
  let completed = false
  try {
    destinationFd = fs.openSync(destination, 'wx', 0o600)
    destinationCreated = true
    let offset = 0
    while (offset < source.opened.size) {
      const requested = Math.min(chunk.byteLength, source.opened.size - offset)
      const count = readSync(source.fd, chunk, 0, requested, offset)
      if (!Number.isInteger(count) || count <= 0 || count > requested) {
        throw new Error(`backup file changed during read: ${relativePath}`)
      }
      const bytes = chunk.subarray(0, count)
      hash.update(bytes)
      writeAllSync(destinationFd, bytes, fs as unknown as DurableFileOps)
      offset += count
    }
    fs.fsyncSync(destinationFd)
    const first = { size: source.opened.size, sha256: hash.digest('hex') }
    assertOpenFileUnchanged(source)
    const second = hashOpenRegularFilePass(source, options)
    assertOpenFileUnchanged(source)
    if (!sameDescriptor(first, second)) {
      throw new Error(`backup file changed between copy and descriptor pass: ${relativePath}`)
    }
    completed = true
    return first
  } finally {
    if (destinationFd !== undefined) fs.closeSync(destinationFd)
    source.ops.closeSync(source.fd)
    if (destinationCreated && !completed) {
      try { fs.unlinkSync(destination) } catch { /* preserve the original failure */ }
    }
  }
}

const EVIDENCE_SPOOL_MARKER_FILE = '.baby-info-backup-evidence-v1.json'

interface ClosedRegularFileIdentity {
  absolute: string
  beforeReal: string
  opened: fs.Stats
  relativePath: string
}

interface SealedRegularEvidence {
  sourceRoot: string
  source: ClosedRegularFileIdentity
  sealedRoot: string
  sealed: ClosedRegularFileIdentity
  expected: DigestDescriptor
}

interface EvidenceSpoolMarker {
  version: 1
  spoolId: string
  snapshotId: string
  ownerPid: number
  startupId: string
  transactionDigest: string | null
  root: {
    dev: number
    ino: number
    birthtimeMs: number
  }
  state: 'active' | 'cleanup-complete'
  sealedDigest: string | null
}

interface EvidenceSpool {
  root: string
  parent: string
  parentIdentity: BoundDirectoryIdentity
  identity: BoundDirectoryIdentity
  dataIdentity?: BoundDirectoryIdentity
  platform: NodeJS.Platform
  ops: DurableFileOps
  marker: EvidenceSpoolMarker
  markerAuthority: RegularFileAuthority
  authorityRoot?: string
}

function closedIdentity(source: OpenRegularFile): ClosedRegularFileIdentity {
  return {
    absolute: source.absolute,
    beforeReal: source.beforeReal,
    opened: source.opened,
    relativePath: source.relativePath,
  }
}

function publishEvidenceMarkerDurably(
  root: string,
  bytes: Buffer,
  platform: NodeJS.Platform,
  ops: DurableFileOps,
): RegularFileAuthority {
  const target = path.join(root, EVIDENCE_SPOOL_MARKER_FILE)
  const temporary = `${target}.publish-${randomUUID()}`
  let fd: number | undefined
  let temporaryExists = false
  try {
    fd = ops.openSync(temporary, 'wx', 0o600)
    temporaryExists = true
    writeAllSync(fd, bytes, ops)
    ops.fsyncSync(fd)
    const published = ops.fstatSync(fd)
    if (!published.isFile() || published.size !== bytes.byteLength) {
      throw new Error('backup evidence marker temporary is not a regular file')
    }
    ops.closeSync(fd)
    fd = undefined
    ops.renameSync(temporary, target)
    temporaryExists = false
    syncDirectory(root, platform, ops)
    const authority = readRegularFileAuthority(root, EVIDENCE_SPOOL_MARKER_FILE, {
      platform,
      durableFs: ops,
    })
    if (!sameInodeIdentity(published, authority.opened) || !bytes.equals(authority.bytes)) {
      throw new Error('backup evidence marker authority changed during publication')
    }
    return authority
  } finally {
    if (fd !== undefined) ops.closeSync(fd)
    if (temporaryExists && ops.existsSync(temporary)) {
      try { ops.unlinkSync(temporary) } catch { /* preserve the primary failure */ }
    }
  }
}

function createEvidenceSpool(
  snapshotDir: string,
  options: BackupReadOptions,
  context?: { transactionDigest: string; authorityRoot: string },
): EvidenceSpool {
  const platform = options.platform ?? process.platform
  const ops = options.durableFs ?? DEFAULT_DURABLE_OPS
  const parent = path.resolve(path.dirname(snapshotDir))
  const parentIdentity = bindDirectChildDirectory(
    parent,
    fs.realpathSync.native(path.dirname(parent)),
    'backup evidence parent',
  )
  const root = fs.mkdtempSync(path.join(parent, `.baby-info-backup.tmp-evidence-${process.pid}-`))
  const identity = bindDirectChildDirectory(root, parentIdentity.real, 'backup evidence spool')
  const marker: EvidenceSpoolMarker = {
    version: 1,
    spoolId: path.basename(root),
    snapshotId: path.basename(snapshotDir),
    ownerPid: process.pid,
    startupId: (options as RecoveryOptions).startupId ?? '',
    transactionDigest: context?.transactionDigest ?? null,
    root: {
      dev: identity.stat.dev,
      ino: identity.stat.ino,
      birthtimeMs: identity.stat.birthtimeMs,
    },
    state: 'active',
    sealedDigest: null,
  }
  const markerAuthority = publishEvidenceMarkerDurably(
    root,
    Buffer.from(JSON.stringify(marker), 'utf8'),
    platform,
    ops,
  )
  syncDirectory(parent, platform, ops)
  return {
    root,
    parent,
    parentIdentity,
    identity,
    platform,
    ops,
    marker,
    markerAuthority,
    authorityRoot: context?.authorityRoot,
  }
}

function ensureEvidenceDataDirectory(spool: EvidenceSpool): void {
  if (spool.dataIdentity) return
  const dataPath = path.join(spool.root, 'data')
  fs.mkdirSync(dataPath)
  spool.dataIdentity = bindDirectChildDirectory(
    dataPath,
    spool.identity.real,
    'backup evidence data spool',
  )
  syncDirectory(spool.root, spool.platform, spool.ops)
}

function assertEvidenceSpoolStable(spool: EvidenceSpool): void {
  assertBoundDirectory(spool.parentIdentity)
  assertBoundDirectory(spool.identity)
  if (spool.dataIdentity) assertBoundDirectory(spool.dataIdentity)
}

function sealedEvidenceDigest(evidence: readonly SealedRegularEvidence[]): string {
  const entries = evidence.map(item => ({
    path: item.sealed.relativePath,
    size: item.expected.size,
    sha256: item.expected.sha256,
  })).sort((left, right) => left.path.localeCompare(right.path))
  return sha256(Buffer.from(JSON.stringify(entries), 'utf8'))
}

function assertSpoolTransactionUnreferenced(spool: EvidenceSpool): void {
  if (!spool.authorityRoot || !spool.marker.transactionDigest) return
  const names = [
    ...(fs.existsSync(path.join(spool.authorityRoot, RESTORE_INTENT_FILE))
      ? [RESTORE_INTENT_FILE]
      : []),
    ...intentTombstoneNames(spool.authorityRoot),
  ]
  for (const name of names) {
    const authority = readRegularFileAuthority(spool.authorityRoot, name, {
      platform: spool.platform,
      durableFs: spool.ops,
    })
    if (sha256(authority.bytes) === spool.marker.transactionDigest) {
      throw new Error('backup evidence spool is still referenced by restore authority')
    }
  }
}

function completeEvidenceSpool(
  spool: EvidenceSpool,
  evidence: readonly SealedRegularEvidence[],
): void {
  assertEvidenceSpoolStable(spool)
  assertRegularFileAuthority(
    spool.root,
    EVIDENCE_SPOOL_MARKER_FILE,
    spool.markerAuthority,
    { platform: spool.platform, durableFs: spool.ops },
  )
  assertSpoolTransactionUnreferenced(spool)
  const marker: EvidenceSpoolMarker = {
    ...spool.marker,
    state: 'cleanup-complete',
    sealedDigest: sealedEvidenceDigest(evidence),
  }
  const markerAuthority = publishEvidenceMarkerDurably(
    spool.root,
    Buffer.from(JSON.stringify(marker), 'utf8'),
    spool.platform,
    spool.ops,
  )
  spool.marker = marker
  spool.markerAuthority = markerAuthority
}

type EvidenceInventoryEntryType = 'file' | 'directory'

interface EvidenceSpoolInventory {
  rootEntries: ReadonlyMap<string, EvidenceInventoryEntryType>
  dataEntries: ReadonlyMap<string, EvidenceInventoryEntryType>
  rootFiles: readonly SealedRegularEvidence[]
  dataFiles: readonly SealedRegularEvidence[]
}

interface EvidenceCleanupReservation {
  cleanupRoot: string
  path: string
  opened: fs.Stats
}

function sameBoundDirectoryIdentity(
  left: BoundDirectoryIdentity,
  right: BoundDirectoryIdentity,
): boolean {
  return left.stat.dev === right.stat.dev
    && left.stat.ino === right.stat.ino
    && left.stat.mode === right.stat.mode
    && left.stat.birthtimeMs === right.stat.birthtimeMs
}

function evidenceSpoolInventory(
  spool: EvidenceSpool,
  evidence: readonly SealedRegularEvidence[],
): EvidenceSpoolInventory {
  const rootFiles: SealedRegularEvidence[] = []
  const dataFiles: SealedRegularEvidence[] = []
  const seen = new Set<string>()
  for (const item of evidence) {
    const relativePath = item.sealed.relativePath
    if (!sameCanonicalPath(path.resolve(item.sealedRoot), path.resolve(spool.root))
      || item.sealed.opened.size !== item.expected.size
      || seen.has(relativePath)) {
      throw new Error(`backup evidence sealed inventory is inconsistent: ${relativePath}`)
    }
    seen.add(relativePath)
    if (relativePath === BABY_INFO_JOURNAL_FILE) {
      rootFiles.push(item)
    } else if (DATA_PATH_PATTERN.test(relativePath)) {
      dataFiles.push(item)
    } else {
      throw new Error(`backup evidence sealed inventory has an unexpected path: ${relativePath}`)
    }
  }
  if (dataFiles.length > 0 && !spool.dataIdentity) {
    throw new Error('backup evidence sealed inventory is missing its data directory authority')
  }
  const rootEntries = new Map<string, EvidenceInventoryEntryType>([
    [EVIDENCE_SPOOL_MARKER_FILE, 'file'],
  ])
  for (const item of rootFiles) rootEntries.set(item.sealed.relativePath, 'file')
  if (spool.dataIdentity) rootEntries.set('data', 'directory')
  const dataEntries = new Map<string, EvidenceInventoryEntryType>()
  for (const item of dataFiles) {
    dataEntries.set(path.basename(item.sealed.relativePath), 'file')
  }
  if (rootEntries.size !== rootFiles.length + 1 + (spool.dataIdentity ? 1 : 0)
    || dataEntries.size !== dataFiles.length) {
    throw new Error('backup evidence sealed inventory contains duplicate entries')
  }
  return { rootEntries, dataEntries, rootFiles, dataFiles }
}

function assertExactEvidenceDirectoryInventory(
  directory: string,
  expected: ReadonlyMap<string, EvidenceInventoryEntryType>,
  label: string,
): void {
  const entries = boundedDirectoryEntries(directory, expected.size + 1, `${label} inventory`)
  if (entries.length !== expected.size) {
    throw new Error(`${label} inventory contains an unexpected entry`)
  }
  for (const entry of entries) {
    const expectedType = expected.get(entry.name)
    const current = fs.lstatSync(path.join(directory, entry.name))
    if (!expectedType
      || current.isSymbolicLink()
      || (expectedType === 'file' && !current.isFile())
      || (expectedType === 'directory' && !current.isDirectory())) {
      throw new Error(`${label} inventory entry changed: ${entry.name}`)
    }
  }
}

function assertRelocatedClosedRegularFileIdentity(
  root: string,
  identity: ClosedRegularFileIdentity,
  options: BackupReadOptions,
): void {
  const source = openRegularFileOnce(root, identity.relativePath, options)
  try {
    if (!sameFileIdentity(identity.opened, source.opened)) {
      throw new Error(`backup evidence sealed identity changed: ${identity.relativePath}`)
    }
    assertOpenFileUnchanged(source)
  } finally {
    source.ops.closeSync(source.fd)
  }
}

function assertCleanupDestinationAbsent(target: string): void {
  try {
    fs.lstatSync(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error('backup evidence cleanup destination already exists')
}

function reserveEvidenceCleanupName(spool: EvidenceSpool): EvidenceCleanupReservation {
  assertBoundDirectory(spool.parentIdentity)
  for (let attempt = 0; attempt < MAX_CLEANUP_RESERVATION_ATTEMPTS; attempt += 1) {
    const cleanupRoot = `${spool.root}.cleanup-${cleanupNonce()}`
    const reservationPath = `${cleanupRoot}.reserve`
    let fd: number
    try {
      fd = spool.ops.openSync(reservationPath, 'wx', 0o600)
    } catch (error) {
      if (isAlreadyExistsError(error)) continue
      throw error
    }
    let opened: fs.Stats
    try {
      const bytes = Buffer.from(JSON.stringify({
        version: 1,
        source: path.basename(spool.root),
        destination: path.basename(cleanupRoot),
        ownerPid: process.pid,
      }), 'utf8')
      writeAllSync(fd, bytes, spool.ops)
      spool.ops.fsyncSync(fd)
      opened = spool.ops.fstatSync(fd)
      if (!opened.isFile() || opened.size !== bytes.byteLength) {
        throw new Error('backup evidence cleanup reservation is not a sealed regular file')
      }
    } finally {
      spool.ops.closeSync(fd)
    }
    syncDirectory(spool.parent, spool.platform, spool.ops)
    assertBoundDirectory(spool.parentIdentity)
    assertCleanupDestinationAbsent(cleanupRoot)
    return { cleanupRoot, path: reservationPath, opened }
  }
  throw new Error('could not reserve a unique backup evidence cleanup destination')
}

function assertIsolatedEvidenceSpoolStable(
  spool: EvidenceSpool,
  cleanupIdentity: BoundDirectoryIdentity,
  cleanupDataIdentity: BoundDirectoryIdentity | undefined,
  inventory: EvidenceSpoolInventory,
): void {
  const options: BackupReadOptions = { platform: spool.platform, durableFs: spool.ops }
  assertBoundDirectory(spool.parentIdentity)
  assertBoundDirectory(cleanupIdentity)
  if (cleanupDataIdentity) assertBoundDirectory(cleanupDataIdentity)
  assertExactEvidenceDirectoryInventory(
    cleanupIdentity.absolute,
    inventory.rootEntries,
    'backup evidence cleanup root',
  )
  if (cleanupDataIdentity) {
    assertExactEvidenceDirectoryInventory(
      cleanupDataIdentity.absolute,
      inventory.dataEntries,
      'backup evidence cleanup data',
    )
  }
  assertRegularFileAuthority(
    cleanupIdentity.absolute,
    EVIDENCE_SPOOL_MARKER_FILE,
    spool.markerAuthority,
    options,
  )
  for (const item of inventory.rootFiles) {
    assertRelocatedClosedRegularFileIdentity(cleanupIdentity.absolute, item.sealed, options)
  }
  for (const item of inventory.dataFiles) {
    assertRelocatedClosedRegularFileIdentity(cleanupIdentity.absolute, item.sealed, options)
  }
  // Repeat the no-follow inventory after bounded per-file checks so an entry
  // created or swapped during the walk causes preservation before any unlink.
  assertExactEvidenceDirectoryInventory(
    cleanupIdentity.absolute,
    inventory.rootEntries,
    'backup evidence cleanup root',
  )
  if (cleanupDataIdentity) {
    assertExactEvidenceDirectoryInventory(
      cleanupDataIdentity.absolute,
      inventory.dataEntries,
      'backup evidence cleanup data',
    )
  }
  assertBoundDirectory(cleanupIdentity)
  assertBoundDirectory(spool.parentIdentity)
}

function removeEvidenceSpool(
  spool: EvidenceSpool,
  evidence: readonly SealedRegularEvidence[],
): void {
  if (!fs.existsSync(spool.root)) return
  const options: BackupReadOptions = { platform: spool.platform, durableFs: spool.ops }
  const inventory = evidenceSpoolInventory(spool, evidence)
  assertEvidenceSpoolStable(spool)
  assertExactEvidenceDirectoryInventory(
    spool.root,
    inventory.rootEntries,
    'backup evidence source root',
  )
  if (spool.dataIdentity) {
    assertExactEvidenceDirectoryInventory(
      spool.dataIdentity.absolute,
      inventory.dataEntries,
      'backup evidence source data',
    )
  }
  assertRegularFileAuthority(
    spool.root,
    EVIDENCE_SPOOL_MARKER_FILE,
    spool.markerAuthority,
    options,
  )
  if (spool.marker.state === 'cleanup-complete'
    && spool.marker.sealedDigest !== sealedEvidenceDigest(evidence)) {
    throw new Error('backup evidence cleanup marker does not match its sealed inventory')
  }
  for (const item of evidence) {
    assertClosedRegularFileIdentity(item.sealedRoot, item.sealed, options)
  }

  const reservation = reserveEvidenceCleanupName(spool)
  // The reservation remains beside either source or tombstone on every
  // uncertain/error path. It is diagnostic evidence and is removed only last.
  assertEvidenceSpoolStable(spool)
  assertCleanupDestinationAbsent(reservation.cleanupRoot)
  spool.ops.renameSync(spool.root, reservation.cleanupRoot)
  syncDirectory(spool.parent, spool.platform, spool.ops)
  assertBoundDirectory(spool.parentIdentity)

  const cleanupIdentity = bindDirectChildDirectory(
    reservation.cleanupRoot,
    spool.parentIdentity.real,
    'isolated backup evidence spool',
  )
  if (!sameBoundDirectoryIdentity(cleanupIdentity, spool.identity)) {
    throw new Error('isolated backup evidence spool identity changed')
  }
  const cleanupDataIdentity = spool.dataIdentity
    ? bindDirectChildDirectory(
      path.join(reservation.cleanupRoot, 'data'),
      cleanupIdentity.real,
      'isolated backup evidence data spool',
    )
    : undefined
  if (cleanupDataIdentity
    && !sameBoundDirectoryIdentity(cleanupDataIdentity, spool.dataIdentity!)) {
    throw new Error('isolated backup evidence data spool identity changed')
  }

  assertIsolatedEvidenceSpoolStable(
    spool,
    cleanupIdentity,
    cleanupDataIdentity,
    inventory,
  )

  for (const item of inventory.dataFiles) {
    assertRelocatedClosedRegularFileIdentity(reservation.cleanupRoot, item.sealed, options)
    spool.ops.unlinkSync(path.join(reservation.cleanupRoot, ...item.sealed.relativePath.split('/')))
  }
  if (cleanupDataIdentity) {
    assertExactEvidenceDirectoryInventory(
      cleanupDataIdentity.absolute,
      new Map(),
      'emptied backup evidence cleanup data',
    )
    assertBoundDirectory(cleanupDataIdentity)
    syncDirectory(cleanupDataIdentity.absolute, spool.platform, spool.ops)
    fs.rmdirSync(cleanupDataIdentity.absolute)
    syncDirectory(cleanupIdentity.absolute, spool.platform, spool.ops)
  }
  for (const item of inventory.rootFiles) {
    assertRelocatedClosedRegularFileIdentity(reservation.cleanupRoot, item.sealed, options)
    spool.ops.unlinkSync(path.join(reservation.cleanupRoot, item.sealed.relativePath))
  }
  assertRegularFileAuthority(
    reservation.cleanupRoot,
    EVIDENCE_SPOOL_MARKER_FILE,
    spool.markerAuthority,
    options,
  )
  assertExactEvidenceDirectoryInventory(
    reservation.cleanupRoot,
    new Map([[EVIDENCE_SPOOL_MARKER_FILE, 'file']]),
    'final backup evidence cleanup root',
  )
  assertRegularFileAuthority(
    reservation.cleanupRoot,
    EVIDENCE_SPOOL_MARKER_FILE,
    spool.markerAuthority,
    options,
  )
  spool.ops.unlinkSync(path.join(reservation.cleanupRoot, EVIDENCE_SPOOL_MARKER_FILE))
  assertExactEvidenceDirectoryInventory(
    reservation.cleanupRoot,
    new Map(),
    'emptied backup evidence cleanup root',
  )
  assertBoundDirectory(cleanupIdentity)
  syncDirectory(reservation.cleanupRoot, spool.platform, spool.ops)
  fs.rmdirSync(reservation.cleanupRoot)
  syncDirectory(spool.parent, spool.platform, spool.ops)
  assertBoundDirectory(spool.parentIdentity)

  const reservationStat = fs.lstatSync(reservation.path)
  const reservationReal = fs.realpathSync.native(reservation.path)
  if (!sameFileIdentity(reservation.opened, reservationStat)
    || !sameCanonicalPath(path.dirname(reservationReal), spool.parentIdentity.real)) {
    throw new Error('backup evidence cleanup reservation identity changed')
  }
  spool.ops.unlinkSync(reservation.path)
  syncDirectory(spool.parent, spool.platform, spool.ops)
  assertBoundDirectory(spool.parentIdentity)
}

function sealOpenRegularFile(
  sourceRoot: string,
  source: OpenRegularFile,
  spool: EvidenceSpool,
  expected: DigestDescriptor,
  options: BackupReadOptions,
): SealedRegularEvidence {
  if (DATA_PATH_PATTERN.test(source.relativePath)) ensureEvidenceDataDirectory(spool)
  assertEvidenceSpoolStable(spool)
  const destination = path.join(spool.root, ...source.relativePath.split('/'))
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(Math.min(STREAM_CHUNK_BYTES, Math.max(1, source.opened.size)))
  const readSync = positionalReadSync(options)
  let destinationFd: number | undefined
  try {
    destinationFd = spool.ops.openSync(destination, 'wx', 0o600)
    let offset = 0
    while (offset < source.opened.size) {
      const requested = Math.min(chunk.byteLength, source.opened.size - offset)
      const count = readSync(source.fd, chunk, 0, requested, offset)
      if (!Number.isInteger(count) || count <= 0 || count > requested) {
        throw new Error(`backup file changed during evidence copy: ${source.relativePath}`)
      }
      const bytes = chunk.subarray(0, count)
      hash.update(bytes)
      writeAllSync(destinationFd, bytes, spool.ops)
      offset += count
    }
    spool.ops.fsyncSync(destinationFd)
    const copied = { size: source.opened.size, sha256: hash.digest('hex') }
    const sealedOpened = spool.ops.fstatSync(destinationFd)
    if (!sealedOpened.isFile() || sealedOpened.size !== source.opened.size) {
      throw new Error(`backup evidence copy is not a stable regular file: ${source.relativePath}`)
    }
    assertOpenFileUnchanged(source)
    const second = hashOpenRegularFilePass(source, options)
    assertOpenFileUnchanged(source)
    if (!sameDescriptor(copied, second) || !sameDescriptor(copied, expected)) {
      throw new Error(`backup file changed between evidence passes: ${source.relativePath}`)
    }
    spool.ops.closeSync(destinationFd)
    destinationFd = undefined
    const sealedCurrent = fs.lstatSync(destination)
    const sealedReal = fs.realpathSync.native(destination)
    if (sealedCurrent.isSymbolicLink()
      || !sameFileIdentity(sealedOpened, sealedCurrent)
      || !isWithin(spool.identity.real, sealedReal)) {
      throw new Error(`backup evidence path changed after copy: ${source.relativePath}`)
    }
    return {
      sourceRoot,
      source: closedIdentity(source),
      sealedRoot: spool.root,
      sealed: {
        absolute: destination,
        beforeReal: sealedReal,
        opened: sealedOpened,
        relativePath: source.relativePath,
      },
      expected,
    }
  } finally {
    if (destinationFd !== undefined) spool.ops.closeSync(destinationFd)
  }
}

function streamOpenJournalToSealedEvidence(
  sourceRoot: string,
  source: OpenRegularFile,
  spool: EvidenceSpool,
  expected: DigestDescriptor,
  options: BackupReadOptions,
): { journalResult: StreamedJournalResult; evidence: SealedRegularEvidence } {
  assertEvidenceSpoolStable(spool)
  const destination = path.join(spool.root, BABY_INFO_JOURNAL_FILE)
  let destinationFd: number | undefined
  try {
    destinationFd = spool.ops.openSync(destination, 'wx', 0o600)
    const journalResult = streamOpenJournal(source, options, {
      allowTornFinal: false,
      onChunk(bytes) {
        writeAllSync(destinationFd!, bytes, spool.ops)
      },
    })
    spool.ops.fsyncSync(destinationFd)
    const sealedOpened = spool.ops.fstatSync(destinationFd)
    if (!sealedOpened.isFile()
      || sealedOpened.size !== source.opened.size
      || !sameDescriptor(journalResult.descriptor, expected)) {
      throw new Error(`backup checksum mismatch: ${BABY_INFO_JOURNAL_FILE}`)
    }
    spool.ops.closeSync(destinationFd)
    destinationFd = undefined
    const sealedCurrent = fs.lstatSync(destination)
    const sealedReal = fs.realpathSync.native(destination)
    if (sealedCurrent.isSymbolicLink()
      || !sameFileIdentity(sealedOpened, sealedCurrent)
      || !isWithin(spool.identity.real, sealedReal)) {
      throw new Error(`backup evidence path changed after copy: ${BABY_INFO_JOURNAL_FILE}`)
    }
    return {
      journalResult,
      evidence: {
        sourceRoot,
        source: closedIdentity(source),
        sealedRoot: spool.root,
        sealed: {
          absolute: destination,
          beforeReal: sealedReal,
          opened: sealedOpened,
          relativePath: BABY_INFO_JOURNAL_FILE,
        },
        expected,
      },
    }
  } finally {
    if (destinationFd !== undefined) spool.ops.closeSync(destinationFd)
  }
}

function assertClosedRegularFileIdentity(
  root: string,
  identity: ClosedRegularFileIdentity,
  options: BackupReadOptions,
): void {
  const source = openRegularFileOnce(root, identity.relativePath, options)
  try {
    if (!sameFileIdentity(identity.opened, source.opened)
      || identity.beforeReal !== source.beforeReal) {
      throw new Error(`backup file identity changed: ${identity.relativePath}`)
    }
    assertOpenFileUnchanged(source)
  } finally {
    source.ops.closeSync(source.fd)
  }
}

function assertClosedRegularFileContent(
  root: string,
  identity: ClosedRegularFileIdentity,
  expected: DigestDescriptor,
  options: BackupReadOptions,
): void {
  const source = openRegularFileOnce(root, identity.relativePath, options)
  try {
    if (!sameFileIdentity(identity.opened, source.opened)
      || identity.beforeReal !== source.beforeReal) {
      throw new Error(`backup file identity changed: ${identity.relativePath}`)
    }
    const actual = hashOpenRegularFilePass(source, options)
    assertOpenFileUnchanged(source)
    if (!sameDescriptor(actual, expected)) {
      throw new Error(`backup file content changed: ${identity.relativePath}`)
    }
  } finally {
    source.ops.closeSync(source.fd)
  }
}

function assertSealedRegularFilesStable(
  evidence: readonly SealedRegularEvidence[],
  spool: EvidenceSpool,
  options: BackupReadOptions,
): void {
  assertEvidenceSpoolStable(spool)
  for (const item of evidence) {
    assertClosedRegularFileContent(item.sourceRoot, item.source, item.expected, options)
  }
  for (const item of evidence) {
    assertClosedRegularFileContent(item.sealedRoot, item.sealed, item.expected, options)
  }
  // A last identity-only sweep catches an earlier path changed while a later
  // bounded content pass was in progress without retaining one fd per file.
  for (const item of evidence) {
    assertClosedRegularFileIdentity(item.sourceRoot, item.source, options)
  }
  for (const item of evidence) {
    assertClosedRegularFileIdentity(item.sealedRoot, item.sealed, options)
  }
  assertEvidenceSpoolStable(spool)
}

function assertSnapshotDirectory(snapshotDir: string): void {
  const stat = fs.lstatSync(snapshotDir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('backup snapshot root is not a regular directory')
  }
}

function boundedDirectoryEntries(directory: string, maximum: number, label: string): fs.Dirent[] {
  const handle = fs.opendirSync(directory)
  const entries: fs.Dirent[] = []
  try {
    for (;;) {
      const entry = handle.readSync()
      if (!entry) break
      if (entries.length >= maximum) throw new Error(`${label} count exceeds its configured bound`)
      entries.push(entry)
    }
    return entries
  } finally {
    handle.closeSync()
  }
}

function actualSnapshotPaths(snapshotDir: string, limits: BackupResourceLimits): string[] {
  assertSnapshotDirectory(snapshotDir)
  const top = boundedDirectoryEntries(snapshotDir, 4, 'backup top-level entry')
  const allowedTop = new Set([SETTINGS_FILE, BABY_INFO_JOURNAL_FILE, BACKUP_MANIFEST_FILE, 'data'])
  for (const entry of top) {
    if (!allowedTop.has(entry.name) || entry.isSymbolicLink()) {
      throw new Error(`backup contains an unexpected path: ${entry.name}`)
    }
    if (entry.name === 'data' ? !entry.isDirectory() : !entry.isFile()) {
      throw new Error(`backup path has an invalid type: ${entry.name}`)
    }
  }
  const result = [SETTINGS_FILE, BABY_INFO_JOURNAL_FILE]
  const dataDir = path.join(snapshotDir, 'data')
  if (fs.existsSync(dataDir)) {
    const dataStat = fs.lstatSync(dataDir)
    if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) {
      throw new Error('backup data path is not a regular directory')
    }
    for (const entry of boundedDirectoryEntries(
      dataDir,
      Math.max(1, limits.maxSnapshotFiles - 2),
      'backup snapshot file',
    )) {
      const relativePath = `data/${entry.name}`
      if (!entry.isFile() || entry.isSymbolicLink() || !DATA_PATH_PATTERN.test(relativePath)) {
        throw new Error(`backup data path is invalid: ${relativePath}`)
      }
      result.push(relativePath)
    }
    result.splice(2, result.length - 2, ...result.slice(2).sort())
  }
  if (result.length > limits.maxSnapshotFiles) {
    throw new Error('backup snapshot file-count bound exceeded')
  }
  return result
}

function pairFromBuffers(
  snapshotId: string,
  snapshotTimestamp: string,
  snapshotPath: string,
  settingsBytes: Buffer,
  journalBytes: Buffer,
): VerifiedBackupPair {
  const settings = parseSettingsBytes(settingsBytes)
  const journal = parseBabyInfoJournalBuffer(journalBytes)
  validateProjection(settings, journal)
  return {
    snapshotId,
    snapshotTimestamp,
    snapshotPath,
    settings,
    settingsBytes,
    journalBytes,
    legacy: isLegacySettings(settings),
  }
}

function verifyPairDirectory(
  directory: string,
  transaction?: RestoreTransactionFile | LegacyRestoreIntentFile,
  options: BackupReadOptions = {},
): VerifiedBackupPair {
  assertSnapshotDirectory(directory)
  const settingsBytes = readRegularFileOnce(directory, SETTINGS_FILE, options)
  const journalBytes = readRegularFileOnce(directory, BABY_INFO_JOURNAL_FILE, options)
  if (transaction) {
    assertDescriptor(settingsBytes, transaction.settings, SETTINGS_FILE)
    assertDescriptor(journalBytes, transaction.journal, BABY_INFO_JOURNAL_FILE)
  }
  return pairFromBuffers(
    transaction?.snapshotId ?? path.basename(directory),
    transaction && 'snapshotTimestamp' in transaction
      ? transaction.snapshotTimestamp
      : new Date(0).toISOString(),
    directory,
    settingsBytes,
    journalBytes,
  )
}

export function verifyBackupSnapshot(
  snapshotDir: string,
  options: BackupReadOptions = {},
): VerifiedBackupPair {
  const now = options.now ?? new Date()
  const limits = resourceLimits(options.limits)
  const snapshotAbsolute = path.resolve(snapshotDir)
  const snapshotParentReal = fs.realpathSync.native(path.dirname(snapshotAbsolute))
  const snapshotIdentity = bindDirectChildDirectory(
    snapshotAbsolute,
    snapshotParentReal,
    'backup snapshot',
  )
  const dataPath = path.join(snapshotAbsolute, 'data')
  const dataIdentity = fs.existsSync(dataPath)
    ? bindDirectChildDirectory(dataPath, snapshotIdentity.real, 'backup data directory')
    : undefined
  const assertVerificationDirectories = () => {
    assertBoundDirectory(snapshotIdentity)
    if (dataIdentity) assertBoundDirectory(dataIdentity)
  }
  assertVerificationDirectories()
  const manifestPath = path.join(snapshotDir, BACKUP_MANIFEST_FILE)
  if (!fs.existsSync(manifestPath)) {
    const entries = boundedDirectoryEntries(snapshotDir, 2, 'legacy backup entry')
    if (entries.length !== 1
      || entries[0].name !== SETTINGS_FILE
      || !entries[0].isFile()
      || entries[0].isSymbolicLink()) {
      throw new Error('legacy backup must contain only settings.json')
    }
    const snapshotTimestamp = parseLegacySnapshotTimestamp(path.basename(snapshotDir), now)
    const settingsSource = openRegularFileOnce(snapshotDir, SETTINGS_FILE, options)
    try {
      const settingsBytes = readOpenRegularFile(settingsSource, options)
      const settings = parseSettingsBytes(settingsBytes)
      if (!isLegacySettings(settings)) throw new Error('journal-aware backup is missing its manifest')
      const afterEntries = boundedDirectoryEntries(snapshotDir, 2, 'legacy backup entry')
      if (afterEntries.length !== 1
        || afterEntries[0].name !== SETTINGS_FILE
        || !afterEntries[0].isFile()
        || afterEntries[0].isSymbolicLink()) {
        throw new Error('legacy backup changed during verification')
      }
      const settingsAfterScan = readOpenRegularFile(settingsSource, options)
      if (!settingsAfterScan.equals(settingsBytes)) {
        throw new Error('legacy backup settings changed during verification')
      }
      assertOpenFileUnchanged(settingsSource)
      assertVerificationDirectories()
      return {
        snapshotId: path.basename(snapshotDir),
        snapshotTimestamp,
        snapshotPath: snapshotDir,
        settings,
        settingsBytes,
        journalBytes: Buffer.alloc(0),
        legacy: true,
      }
    } finally {
      settingsSource.ops.closeSync(settingsSource.fd)
    }
  }

  const evidenceSources: OpenRegularFile[] = []
  const sealedEvidence: SealedRegularEvidence[] = []
  let evidenceSpool: EvidenceSpool | undefined
  let preserveEvidenceSpool = false
  try {
    const manifestSource = openRegularFileOnce(snapshotDir, BACKUP_MANIFEST_FILE, options)
    evidenceSources.push(manifestSource)
    const manifestBytes = readOpenRegularFile(manifestSource, options)
    assertOpenFileUnchanged(manifestSource)
    const manifest = parseManifest(manifestBytes, now, limits)
    const manifestPaths = manifest.files.map(entry => entry.path)
    const beforePaths = actualSnapshotPaths(snapshotDir, limits)
    if (beforePaths.length !== manifestPaths.length
      || beforePaths.some((relativePath, index) => relativePath !== manifestPaths[index])) {
      throw new Error('backup manifest does not enumerate the complete staged set')
    }
    assertVerificationDirectories()
    evidenceSpool = createEvidenceSpool(snapshotDir, options)

    const settingsEntry = manifest.files[0]
    const settingsSource = openRegularFileOnce(snapshotDir, SETTINGS_FILE, options)
    evidenceSources.push(settingsSource)
    const settingsBytes = readOpenRegularFile(settingsSource, options)
    if (!sameDescriptor(descriptor(settingsBytes), settingsEntry)) {
      throw new Error(`backup checksum mismatch: ${settingsEntry.path}`)
    }
    assertOpenFileUnchanged(settingsSource)
    let journalBytes: Buffer | undefined
    for (const entry of manifest.files.slice(1)) {
      const source = openRegularFileOnce(snapshotDir, entry.path, options)
      try {
        if (entry.path === BABY_INFO_JOURNAL_FILE) {
          const bytes = readOpenRegularFile(source, options)
          if (!sameDescriptor(descriptor(bytes), entry)) {
            throw new Error(`backup checksum mismatch: ${entry.path}`)
          }
          journalBytes = bytes
        }
        sealedEvidence.push(sealOpenRegularFile(
          snapshotDir,
          source,
          evidenceSpool,
          entry,
          options,
        ))
      } finally {
        source.ops.closeSync(source.fd)
      }
    }
    if (!journalBytes) {
      throw new Error('backup manifest did not produce a complete settings/journal pair')
    }
    const settingsAfterScan = readOpenRegularFile(settingsSource, options)
    if (!settingsAfterScan.equals(settingsBytes)) {
      throw new Error('backup settings changed while journal/data files were scanned')
    }
    const manifestAfterScan = readOpenRegularFile(manifestSource, options)
    if (!manifestAfterScan.equals(manifestBytes)) {
      throw new Error('backup manifest changed while journal/data files were scanned')
    }
    assertVerificationDirectories()
    const afterPaths = actualSnapshotPaths(snapshotDir, limits)
    if (afterPaths.length !== manifestPaths.length
      || afterPaths.some((relativePath, index) => relativePath !== manifestPaths[index])) {
      throw new Error('backup manifest set changed during verification')
    }
    assertVerificationDirectories()
    assertOpenRegularFileContent(
      { source: manifestSource, expected: descriptor(manifestBytes) },
      options,
    )
    assertSealedRegularFilesStable(sealedEvidence, evidenceSpool, options)
    for (const source of evidenceSources) assertOpenFileUnchanged(source)
    const pair = pairFromBuffers(
      path.basename(snapshotDir),
      manifest.snapshotTimestamp,
      snapshotDir,
      settingsBytes,
      journalBytes,
    )
    try {
      completeEvidenceSpool(evidenceSpool, sealedEvidence)
    } catch (error) {
      preserveEvidenceSpool = true
      throw error
    }
    return pair
  } finally {
    closeOpenRegularFiles(evidenceSources)
    if (evidenceSpool && !preserveEvidenceSpool) {
      removeEvidenceSpool(evidenceSpool, sealedEvidence)
    }
  }
}

interface VerifiedSnapshotIdentity {
  snapshotId: string
  snapshotTimestamp: string
  settingsDescriptor: DigestDescriptor
  journalDescriptor: DigestDescriptor
}

/**
 * Revalidates a complete snapshot for a completed restore without retaining
 * the journal or auxiliary files. Public backup selection still returns its
 * immutable buffers; this path needs only independently verified identity.
 */
function holdBackupSnapshotIdentity(
  snapshotDir: string,
  options: RecoveryOptions,
  context?: { transactionDigest: string; authorityRoot: string },
): HeldEvidence<VerifiedSnapshotIdentity> {
  const now = options.now ?? new Date()
  const limits = resourceLimits(options.limits)
  const snapshotAbsolute = path.resolve(snapshotDir)
  const snapshotParentReal = fs.realpathSync.native(path.dirname(snapshotAbsolute))
  const snapshotIdentity = bindDirectChildDirectory(
    snapshotAbsolute,
    snapshotParentReal,
    'verified backup snapshot',
  )
  const dataPath = path.join(snapshotAbsolute, 'data')
  const dataIdentity = fs.existsSync(dataPath)
    ? bindDirectChildDirectory(dataPath, snapshotIdentity.real, 'verified backup data directory')
    : undefined
  const assertVerificationDirectories = () => {
    assertBoundDirectory(snapshotIdentity)
    if (dataIdentity) assertBoundDirectory(dataIdentity)
  }
  assertVerificationDirectories()
  const manifestPath = path.join(snapshotDir, BACKUP_MANIFEST_FILE)
  if (!fs.existsSync(manifestPath)) {
    const entries = boundedDirectoryEntries(snapshotDir, 2, 'legacy backup entry')
    if (entries.length !== 1
      || entries[0].name !== SETTINGS_FILE
      || !entries[0].isFile()
      || entries[0].isSymbolicLink()) {
      throw new Error('legacy backup must contain only settings.json')
    }
    const settingsSource = openRegularFileOnce(snapshotDir, SETTINGS_FILE, options)
    try {
      const settingsBytes = readOpenRegularFile(settingsSource, options)
      const settings = parseSettingsBytes(settingsBytes)
      if (!isLegacySettings(settings)) throw new Error('journal-aware backup is missing its manifest')
      const afterEntries = boundedDirectoryEntries(snapshotDir, 2, 'legacy backup entry')
      if (afterEntries.length !== 1
        || afterEntries[0].name !== SETTINGS_FILE
        || !afterEntries[0].isFile()
        || afterEntries[0].isSymbolicLink()) {
        throw new Error('legacy backup changed during verification')
      }
      const settingsAfterScan = readOpenRegularFile(settingsSource, options)
      if (!settingsAfterScan.equals(settingsBytes)) {
        throw new Error('legacy backup settings changed during verification')
      }
      assertOpenFileUnchanged(settingsSource)
      assertVerificationDirectories()
      const value: VerifiedSnapshotIdentity = {
        snapshotId: path.basename(snapshotDir),
        snapshotTimestamp: parseLegacySnapshotTimestamp(path.basename(snapshotDir), now),
        settingsDescriptor: descriptor(settingsBytes),
        journalDescriptor: { size: 0, sha256: sha256(new Uint8Array(0)) },
      }
      let closed = false
      return {
        value,
        assertStable() {
          if (closed) throw new Error('legacy backup evidence is already closed')
          const current = readOpenRegularFile(settingsSource, options)
          if (!current.equals(settingsBytes)) {
            throw new Error('legacy backup settings changed before cleanup')
          }
          const currentEntries = boundedDirectoryEntries(snapshotDir, 2, 'legacy backup entry')
          if (currentEntries.length !== 1
            || currentEntries[0].name !== SETTINGS_FILE
            || !currentEntries[0].isFile()
            || currentEntries[0].isSymbolicLink()) {
            throw new Error('legacy backup changed before cleanup')
          }
          assertVerificationDirectories()
          assertOpenFileUnchanged(settingsSource)
        },
        close() {
          if (closed) return
          closed = true
          settingsSource.ops.closeSync(settingsSource.fd)
        },
      }
    } catch (error) {
      settingsSource.ops.closeSync(settingsSource.fd)
      throw error
    }
  }

  const evidenceSources: OpenRegularFile[] = []
  const expectedEvidence: ExpectedOpenRegularFile[] = []
  const sealedEvidence: SealedRegularEvidence[] = []
  let evidenceSpool: EvidenceSpool | undefined
  try {
    const manifestSource = openRegularFileOnce(snapshotDir, BACKUP_MANIFEST_FILE, options)
    evidenceSources.push(manifestSource)
    const manifestBytes = readOpenRegularFile(manifestSource, options)
    const manifestDescriptor = descriptor(manifestBytes)
    expectedEvidence.push({ source: manifestSource, expected: manifestDescriptor })
    assertOpenFileUnchanged(manifestSource)
    const manifest = parseManifest(manifestBytes, now, limits)
    const manifestPaths = manifest.files.map(entry => entry.path)
    const beforePaths = actualSnapshotPaths(snapshotDir, limits)
    if (beforePaths.length !== manifestPaths.length
      || beforePaths.some((relativePath, index) => relativePath !== manifestPaths[index])) {
      throw new Error('backup manifest does not enumerate the complete staged set')
    }
    assertVerificationDirectories()
    evidenceSpool = createEvidenceSpool(snapshotDir, options, context)

    const settingsEntry = manifest.files[0]
    const settingsSource = openRegularFileOnce(snapshotDir, SETTINGS_FILE, options)
    evidenceSources.push(settingsSource)
    expectedEvidence.push({ source: settingsSource, expected: settingsEntry })
    let settingsBytes: Buffer
    let journalResult: StreamedJournalResult | undefined
    settingsBytes = readOpenRegularFile(settingsSource, options)
    assertOpenFileUnchanged(settingsSource)
    if (!sameDescriptor(descriptor(settingsBytes), settingsEntry)) {
      throw new Error(`backup checksum mismatch: ${settingsEntry.path}`)
    }
    for (const entry of manifest.files.slice(1)) {
      const source = openRegularFileOnce(snapshotDir, entry.path, options)
      try {
        if (entry.path === BABY_INFO_JOURNAL_FILE) {
          const sealedJournal = streamOpenJournalToSealedEvidence(
            snapshotDir,
            source,
            evidenceSpool,
            entry,
            options,
          )
          journalResult = sealedJournal.journalResult
          sealedEvidence.push(sealedJournal.evidence)
        } else {
          sealedEvidence.push(sealOpenRegularFile(
            snapshotDir,
            source,
            evidenceSpool,
            entry,
            options,
          ))
        }
      } finally {
        source.ops.closeSync(source.fd)
      }
    }

    const settingsAfterScan = readOpenRegularFile(settingsSource, options)
    assertOpenFileUnchanged(settingsSource)
    if (!settingsAfterScan.equals(settingsBytes)) {
      throw new Error('backup settings changed while journal/data files were scanned')
    }
    const manifestAfterScan = readOpenRegularFile(manifestSource, options)
    if (!manifestAfterScan.equals(manifestBytes)) {
      throw new Error('backup manifest changed while journal/data files were scanned')
    }
    assertVerificationDirectories()
    const afterPaths = actualSnapshotPaths(snapshotDir, limits)
    if (afterPaths.length !== manifestPaths.length
      || afterPaths.some((relativePath, index) => relativePath !== manifestPaths[index])) {
      throw new Error('backup manifest set changed during verification')
    }
    assertVerificationDirectories()
    for (const source of evidenceSources) assertOpenFileUnchanged(source)
    for (const item of sealedEvidence) {
      assertClosedRegularFileIdentity(item.sourceRoot, item.source, options)
      assertClosedRegularFileIdentity(item.sealedRoot, item.sealed, options)
    }

    const settings = parseSettingsBytes(settingsBytes)
    validateProjection(settings, journalResult!.journal)
    const value: VerifiedSnapshotIdentity = {
      snapshotId: path.basename(snapshotDir),
      snapshotTimestamp: manifest.snapshotTimestamp,
      settingsDescriptor: descriptor(settingsBytes),
      journalDescriptor: journalResult!.descriptor,
    }
    let closed = false
    let preserveSpool = false
    const assertModernEvidenceStable = () => {
      assertHeldRegularFilesStable(expectedEvidence, options)
      assertSealedRegularFilesStable(sealedEvidence, evidenceSpool!, options)
      assertVerificationDirectories()
      const finalPaths = actualSnapshotPaths(snapshotDir, limits)
      if (finalPaths.length !== manifestPaths.length
        || finalPaths.some((relativePath, index) => relativePath !== manifestPaths[index])) {
        throw new Error('backup manifest set changed before cleanup')
      }
      assertVerificationDirectories()
      for (const source of evidenceSources) assertOpenFileUnchanged(source)
    }
    return {
      value,
      assertStable() {
        if (closed) throw new Error('backup evidence is already closed')
        assertModernEvidenceStable()
      },
      completeCleanup() {
        if (closed) throw new Error('backup evidence is already closed')
        assertModernEvidenceStable()
        completeEvidenceSpool(evidenceSpool!, sealedEvidence)
      },
      preserve() {
        preserveSpool = true
      },
      close() {
        if (closed) return
        closed = true
        closeOpenRegularFiles(evidenceSources)
        if (!preserveSpool) removeEvidenceSpool(evidenceSpool!, sealedEvidence)
      },
    }
  } catch (error) {
    closeOpenRegularFiles(evidenceSources)
    if (evidenceSpool) removeEvidenceSpool(evidenceSpool, sealedEvidence)
    throw error
  }
}

function syncDirectory(
  directory: string,
  platform: NodeJS.Platform,
  ops: DurableFileOps = DEFAULT_DURABLE_OPS,
): void {
  if (platform === 'win32') return
  const fd = ops.openSync(directory, 'r')
  try {
    ops.fsyncSync(fd)
  } finally {
    ops.closeSync(fd)
  }
}

function writeDurably(
  destination: string,
  bytes: Uint8Array,
  platform: NodeJS.Platform,
  ops: DurableFileOps = DEFAULT_DURABLE_OPS,
): void {
  atomicReplaceFileSync(destination, bytes, { platform, fs: ops })
}

/** Stages and verifies one complete snapshot. Caller performs the atomic directory rename. */
export function stageVerifiedBackupSnapshot(
  userDataPath: string,
  stagingPath: string,
  timestamp: string,
  platform: NodeJS.Platform = process.platform,
  options: BackupReadOptions = {},
): void {
  const now = new Date()
  strictTimestamp(timestamp, now)
  const limits = resourceLimits(options.limits)
  const readOptions: BackupReadOptions = { ...options, platform }
  const settingsBytes = readRegularFileOnce(userDataPath, SETTINGS_FILE, readOptions)

  const journalPath = path.join(userDataPath, BABY_INFO_JOURNAL_FILE)
  const journalBytes = fs.existsSync(journalPath)
    ? readRegularFileOnce(userDataPath, BABY_INFO_JOURNAL_FILE, readOptions)
    : Buffer.alloc(0)

  let aggregateBytes = addSnapshotBytes(0, settingsBytes.byteLength, limits.maxTotalSnapshotBytes)
  aggregateBytes = addSnapshotBytes(
    aggregateBytes,
    journalBytes.byteLength,
    limits.maxTotalSnapshotBytes,
  )

  const dataSource = path.join(userDataPath, 'data')
  const dataSources: Array<{ relativePath: string; size: number }> = []
  if (fs.existsSync(dataSource)) {
    const dataStat = fs.lstatSync(dataSource)
    if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) {
      throw new Error('event data source is not a regular directory')
    }
    for (const entry of boundedDirectoryEntries(
      dataSource,
      Math.max(1, limits.maxSnapshotFiles - 2),
      'event data source entry',
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.name.endsWith('.jsonl')) continue
      const relativePath = `data/${entry.name}`
      if (!entry.isFile() || entry.isSymbolicLink() || !DATA_PATH_PATTERN.test(relativePath)) {
        throw new Error(`event data source path is invalid: ${entry.name}`)
      }
      const stat = fs.lstatSync(path.join(dataSource, entry.name))
      if (stat.size > maximumFor(relativePath)) {
        throw new Error(`backup file exceeds its size bound: ${relativePath}`)
      }
      aggregateBytes = addSnapshotBytes(
        aggregateBytes,
        stat.size,
        limits.maxTotalSnapshotBytes,
      )
      dataSources.push({ relativePath, size: stat.size })
    }
  }
  if (dataSources.length + 2 > limits.maxSnapshotFiles) {
    throw new Error('backup snapshot file-count bound exceeded')
  }

  writeDurably(path.join(stagingPath, SETTINGS_FILE), settingsBytes, platform)
  writeDurably(path.join(stagingPath, BABY_INFO_JOURNAL_FILE), journalBytes, platform)
  const dataDescriptors = new Map<string, DigestDescriptor>()
  if (dataSources.length > 0) {
    const dataDestination = path.join(stagingPath, 'data')
    fs.mkdirSync(dataDestination)
    for (const source of dataSources) {
      const streamed = streamRegularFileToStaging(
        userDataPath,
        source.relativePath,
        path.join(stagingPath, ...source.relativePath.split('/')),
        readOptions,
      )
      if (streamed.size !== source.size) throw new Error(`event data source changed: ${source.relativePath}`)
      dataDescriptors.set(source.relativePath, streamed)
    }
    syncDirectory(dataDestination, platform)
  }

  const dataPaths = dataSources.map(source => source.relativePath)
  const manifest: BackupManifest = {
    version: 1,
    source: 'baby-diary',
    snapshotTimestamp: timestamp,
    files: [
      { path: SETTINGS_FILE, ...descriptor(settingsBytes) },
      { path: BABY_INFO_JOURNAL_FILE, ...descriptor(journalBytes) },
      ...dataPaths.map(relativePath => ({ path: relativePath, ...dataDescriptors.get(relativePath)! })),
    ],
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
  addSnapshotBytes(aggregateBytes, manifestBytes.byteLength, limits.maxTotalSnapshotBytes)
  writeDurably(
    path.join(stagingPath, BACKUP_MANIFEST_FILE),
    manifestBytes,
    platform,
  )
  syncDirectory(stagingPath, platform)
  verifyBackupSnapshot(stagingPath, { ...readOptions, now })
}

function validDigestDescriptor(value: unknown): value is DigestDescriptor {
  return isRecord(value)
    && exactKeys(value, ['size', 'sha256'])
    && Number.isSafeInteger(value.size)
    && (value.size as number) >= 0
    && typeof value.sha256 === 'string'
    && SHA256_PATTERN.test(value.sha256)
}

function parseRestoreIntent(bytes: Buffer): ParsedRestoreIntent {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('restore intent JSON is invalid')
  }
  if (!isRecord(value) || typeof value.snapshotId !== 'string'
    || value.snapshotId.length < 1 || value.snapshotId.length > 255
    || /[\u0000-\u001f\u007f]/.test(value.snapshotId)
    || !validDigestDescriptor(value.settings)
    || !validDigestDescriptor(value.journal)) {
    throw new Error('restore intent shape is invalid')
  }
  if (value.version === 1
    && exactKeys(value, ['version', 'snapshotId', 'settings', 'journal'])) {
    return {
      version: 1,
      snapshotId: value.snapshotId,
      settings: value.settings,
      journal: value.journal,
    }
  }
  if (value.version === 2
    && exactKeys(value, [
      'version', 'snapshotId', 'snapshotTimestamp', 'settings', 'journal',
      'phase', 'windowsVerifiedStartups', 'forensicArchiveId',
    ])
    && typeof value.snapshotTimestamp === 'string'
    && (value.phase === 'prepared' || value.phase === 'primary-verified')
    && Number.isInteger(value.windowsVerifiedStartups)
    && (value.windowsVerifiedStartups as number) >= 0
    && (value.windowsVerifiedStartups as number) <= 2
    && typeof value.forensicArchiveId === 'string') {
    strictTimestamp(value.snapshotTimestamp, new Date())
    return {
      version: 2,
      snapshotId: value.snapshotId,
      snapshotTimestamp: value.snapshotTimestamp,
      settings: value.settings,
      journal: value.journal,
      phase: value.phase,
      windowsVerifiedStartups: value.windowsVerifiedStartups as number,
      forensicArchiveId: value.forensicArchiveId,
    }
  }

  if (value.version !== 3
    || !exactKeys(value, [
      'version', 'snapshotId', 'snapshotTimestamp', 'settings', 'journal',
      'phase', 'windowsVerifiedStartups', 'lastWindowsStartupId',
      'forensicArchiveId', 'forensicManifest',
    ])
    || typeof value.snapshotTimestamp !== 'string'
    || (value.phase !== 'allocated'
      && value.phase !== 'prepared'
      && value.phase !== 'awaiting-windows-confirmation'
      && value.phase !== 'primary-verified')
    || !Number.isInteger(value.windowsVerifiedStartups)
    || (value.windowsVerifiedStartups as number) < 0
    || (value.windowsVerifiedStartups as number) > 2
    || typeof value.lastWindowsStartupId !== 'string'
    || value.lastWindowsStartupId.length > 128
    || /[\u0000-\u001f\u007f]/.test(value.lastWindowsStartupId)
    || typeof value.forensicArchiveId !== 'string'
    || (value.forensicManifest !== null && !validDigestDescriptor(value.forensicManifest))) {
    throw new Error('restore intent shape is invalid')
  }
  strictTimestamp(value.snapshotTimestamp, new Date())
  return {
    version: 3,
    snapshotId: value.snapshotId,
    snapshotTimestamp: value.snapshotTimestamp,
    settings: value.settings,
    journal: value.journal,
    phase: value.phase,
    windowsVerifiedStartups: value.windowsVerifiedStartups as number,
    lastWindowsStartupId: value.lastWindowsStartupId,
    forensicArchiveId: value.forensicArchiveId,
    forensicManifest: value.forensicManifest,
  }
}

function assertDescriptor(bytes: Buffer, expected: DigestDescriptor, label: string): void {
  if (bytes.byteLength !== expected.size || sha256(bytes) !== expected.sha256) {
    throw new Error(`${label} checksum mismatch`)
  }
}

function normalizeTransaction(intent: ParsedRestoreIntent): RestoreTransactionFile {
  if (intent.version === 3) return intent
  return {
    version: 3,
    snapshotId: intent.snapshotId,
    snapshotTimestamp: intent.version === 1 ? LEGACY_TRANSACTION_TIMESTAMP : intent.snapshotTimestamp,
    settings: intent.settings,
    journal: intent.journal,
    phase: intent.version === 1 ? 'prepared' : intent.phase,
    windowsVerifiedStartups: intent.version === 1 ? 0 : intent.windowsVerifiedStartups,
    lastWindowsStartupId: '',
    forensicArchiveId: intent.version === 1 ? '' : intent.forensicArchiveId,
    forensicManifest: null,
  }
}

function transactionBytes(transaction: RestoreTransactionFile): Buffer {
  return Buffer.from(JSON.stringify(transaction, null, 2), 'utf8')
}

function readTransactionFile(root: string, relativePath: string, options: BackupReadOptions): ParsedRestoreIntent {
  return parseRestoreIntent(readRegularFileOnce(root, relativePath, options))
}

interface RegularFileAuthority {
  opened: fs.Stats
  bytes: Buffer
}

function sameInodeIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.birthtimeMs === right.birthtimeMs
}

function readRegularFileAuthority(
  root: string,
  relativePath: string,
  options: BackupReadOptions,
): RegularFileAuthority {
  const source = openRegularFileOnce(root, relativePath, options)
  try {
    const bytes = readOpenRegularFile(source, options)
    assertOpenFileUnchanged(source)
    return { opened: source.opened, bytes }
  } finally {
    source.ops.closeSync(source.fd)
  }
}

function assertRegularFileAuthority(
  root: string,
  relativePath: string,
  authority: RegularFileAuthority,
  options: BackupReadOptions,
): void {
  const current = readRegularFileAuthority(root, relativePath, options)
  if (!sameInodeIdentity(authority.opened, current.opened)
    || !authority.bytes.equals(current.bytes)) {
    throw new Error(`restore intent authority changed: ${relativePath}`)
  }
}

function intentTombstoneNames(userDataPath: string): string[] {
  const handle = fs.opendirSync(userDataPath)
  const names: string[] = []
  try {
    for (;;) {
      const entry = handle.readSync()
      if (!entry) break
      if (!entry.name.startsWith(`${RESTORE_INTENT_FILE}.cleanup-`)) continue
      if (!RESTORE_INTENT_TOMBSTONE_PATTERN.test(entry.name)
        || entry.isSymbolicLink()
        || !entry.isFile()) {
        throw new Error('restore intent tombstone has an invalid name or type')
      }
      names.push(entry.name)
      if (names.length > 1) {
        throw new Error('multiple restore intent tombstones require manual reconciliation')
      }
    }
    return names
  } finally {
    handle.closeSync()
  }
}

function reconcileIntentTombstone(
  userDataPath: string,
  options: RecoveryOptions,
): void {
  const tombstones = intentTombstoneNames(userDataPath)
  if (tombstones.length === 0) return
  const platform = options.platform ?? process.platform
  const ops = options.durableFs ?? DEFAULT_DURABLE_OPS
  const readOptions: BackupReadOptions = { ...options, platform, durableFs: ops }
  const tombstoneName = tombstones[0]
  const tombstonePath = path.join(userDataPath, tombstoneName)
  const intentPath = path.join(userDataPath, RESTORE_INTENT_FILE)
  const tombstone = readRegularFileAuthority(userDataPath, tombstoneName, readOptions)

  if (ops.existsSync(intentPath)) {
    const canonical = readRegularFileAuthority(userDataPath, RESTORE_INTENT_FILE, readOptions)
    if (!sameInodeIdentity(tombstone.opened, canonical.opened)
      || !tombstone.bytes.equals(canonical.bytes)) {
      throw new Error('canonical restore intent conflicts with its crash tombstone')
    }
  } else {
    // A same-directory hard link is an atomic no-replace publication. If the
    // process stops after this point, both paths identify the same inode and
    // the next startup can finish the reconciliation without ambiguity.
    fs.linkSync(tombstonePath, intentPath)
    syncDirectory(userDataPath, platform, ops)
    assertRegularFileAuthority(userDataPath, RESTORE_INTENT_FILE, tombstone, readOptions)
  }

  ops.unlinkSync(tombstonePath)
  syncDirectory(userDataPath, platform, ops)
}

function removeMatchingIntentDurably(
  userDataPath: string,
  expectedBytes: Buffer,
  platform: NodeJS.Platform,
  ops: DurableFileOps,
): void {
  const intentPath = path.join(userDataPath, RESTORE_INTENT_FILE)
  const options: BackupReadOptions = { platform, durableFs: ops }
  const authority = readRegularFileAuthority(userDataPath, RESTORE_INTENT_FILE, options)
  if (!authority.bytes.equals(expectedBytes)) {
    throw new Error('canonical restore intent no longer matches cleanup authority')
  }
  const tombstoneName = `${RESTORE_INTENT_FILE}.cleanup-${cleanupNonce()}`
  const tombstonePath = path.join(userDataPath, tombstoneName)
  ops.renameSync(intentPath, tombstonePath)
  syncDirectory(userDataPath, platform, ops)
  assertRegularFileAuthority(userDataPath, tombstoneName, authority, options)
  // Re-open immediately before unlink so a swapped path is preserved rather
  // than deleting a newer or foreign recovery authority.
  assertRegularFileAuthority(userDataPath, tombstoneName, authority, options)
  ops.unlinkSync(tombstonePath)
  syncDirectory(userDataPath, platform, ops)
}

function removeStagingDurably(
  userDataPath: string,
  platform: NodeJS.Platform,
  ops: DurableFileOps = DEFAULT_DURABLE_OPS,
): void {
  const stagingPath = path.join(userDataPath, RESTORE_STAGING_DIR)
  if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { recursive: true, force: true })
  syncDirectory(userDataPath, platform, ops)
}

function sameDescriptor(left: DigestDescriptor, right: DigestDescriptor): boolean {
  return left.size === right.size && left.sha256 === right.sha256
}

function sameTransactionIdentity(left: RestoreTransactionFile, right: RestoreTransactionFile): boolean {
  return left.snapshotId === right.snapshotId
    && left.snapshotTimestamp === right.snapshotTimestamp
    && sameDescriptor(left.settings, right.settings)
    && sameDescriptor(left.journal, right.journal)
    && left.forensicArchiveId === right.forensicArchiveId
    && (left.forensicManifest === null
      ? right.forensicManifest === null
      : right.forensicManifest !== null
        && sameDescriptor(left.forensicManifest, right.forensicManifest))
}

function sameTransactionControls(left: RestoreTransactionFile, right: RestoreTransactionFile): boolean {
  return left.phase === right.phase
    && left.windowsVerifiedStartups === right.windowsVerifiedStartups
    && left.lastWindowsStartupId === right.lastWindowsStartupId
}

function holdTransactionVerifiedBackup(
  userDataPath: string,
  transaction: RestoreTransactionFile,
  options: RecoveryOptions,
  allowLegacyTimestamp = false,
): HeldEvidence<VerifiedSnapshotIdentity> {
  const roots = [path.join(userDataPath, 'backups')]
  if (options.documentsBackupDir
    && path.resolve(options.documentsBackupDir) !== path.resolve(roots[0])) {
    roots.push(options.documentsBackupDir)
  }
  const limits = resourceLimits(options.limits)
  const budget: CandidateBudget = { entriesSeen: 0 }
  for (const root of roots) {
    for (const candidate of listSnapshotCandidates(root, limits, budget)) {
      let held: HeldEvidence<VerifiedSnapshotIdentity> | undefined
      try {
        held = holdBackupSnapshotIdentity(candidate, options, {
          transactionDigest: sha256(transactionBytes(transaction)),
          authorityRoot: userDataPath,
        })
        const identity = held.value
        if (identity.snapshotId === transaction.snapshotId
          && (identity.snapshotTimestamp === transaction.snapshotTimestamp
            || (allowLegacyTimestamp
              && transaction.snapshotTimestamp === LEGACY_TRANSACTION_TIMESTAMP))
          && sameDescriptor(identity.settingsDescriptor, transaction.settings)
          && sameDescriptor(identity.journalDescriptor, transaction.journal)) {
          const matched = held
          held = undefined
          return matched
        }
      } catch { /* only an independently verified exact identity can match */ }
      finally { held?.close() }
    }
  }
  throw new Error('primary-verified transaction identity does not match an exact verified backup')
}

function holdVerifiedStreamedPair(
  directory: string,
  transaction: RestoreTransactionFile,
  options: RecoveryOptions,
  allowTornFinal: boolean,
): HeldEvidence<{
  settingsDescriptor: DigestDescriptor
  journalDescriptor: DigestDescriptor
}> {
  const absolute = path.resolve(directory)
  const parentReal = fs.realpathSync.native(path.dirname(absolute))
  const directoryIdentity = bindDirectChildDirectory(
    absolute,
    parentReal,
    'settings/journal verification directory',
  )
  const settingsSource = openRegularFileOnce(directory, SETTINGS_FILE, options)
  const evidenceSources: OpenRegularFile[] = [settingsSource]
  let journalSource: OpenRegularFile | undefined
  try {
    const settingsBytes = readOpenRegularFile(settingsSource, options)
    assertOpenFileUnchanged(settingsSource)
    const settings = parseSettingsBytes(settingsBytes)
    journalSource = openRegularFileOnce(directory, BABY_INFO_JOURNAL_FILE, options)
    evidenceSources.push(journalSource)
    const journalResult = streamOpenJournal(journalSource, options, {
      allowTornFinal,
      requiredPrefix: transaction.journal,
    })
    const settingsAfterJournal = readOpenRegularFile(settingsSource, options)
    assertOpenFileUnchanged(settingsSource)
    if (!settingsAfterJournal.equals(settingsBytes)) {
      throw new Error('settings changed while the journal was scanned')
    }
    assertOpenFileUnchanged(journalSource)
    assertBoundDirectory(directoryIdentity)
    validateProjection(settings, journalResult.journal)
    const value = {
      settingsDescriptor: descriptor(settingsBytes),
      journalDescriptor: journalResult.descriptor,
    }
    let closed = false
    return {
      value,
      assertStable() {
        if (closed) throw new Error('settings/journal evidence is already closed')
        const finalSettings = readOpenRegularFile(settingsSource, options)
        if (!sameDescriptor(descriptor(finalSettings), value.settingsDescriptor)
          || !finalSettings.equals(settingsBytes)) {
          throw new Error('settings changed before cleanup')
        }
        const finalJournal = hashOpenRegularFilePass(journalSource!, options)
        if (!sameDescriptor(finalJournal, value.journalDescriptor)) {
          throw new Error('journal changed before cleanup')
        }
        assertBoundDirectory(directoryIdentity)
        for (const source of evidenceSources) assertOpenFileUnchanged(source)
      },
      close() {
        if (closed) return
        closed = true
        closeOpenRegularFiles(evidenceSources)
      },
    }
  } catch (error) {
    closeOpenRegularFiles(evidenceSources)
    throw error
  }
}

function verifyStreamedPair(
  directory: string,
  transaction: RestoreTransactionFile,
  options: RecoveryOptions,
  allowTornFinal: boolean,
): {
  settingsDescriptor: DigestDescriptor
  journalDescriptor: DigestDescriptor
} {
  const held = holdVerifiedStreamedPair(directory, transaction, options, allowTornFinal)
  try {
    return held.value
  } finally {
    held.close()
  }
}

function verifyCompletedRestoreStaging(
  stagingPath: string,
  transaction: RestoreTransactionFile,
  options: RecoveryOptions,
): void {
  const pair = verifyStreamedPair(stagingPath, transaction, options, false)
  if (!sameDescriptor(pair.settingsDescriptor, transaction.settings)
    || !sameDescriptor(pair.journalDescriptor, transaction.journal)) {
    throw new Error('primary-verified staging pair checksum mismatch')
  }
}

function holdCompletedRestoreLiveState(
  userDataPath: string,
  transaction: RestoreTransactionFile,
  options: RecoveryOptions,
  onForensicVerified?: () => void,
  existingLive?: HeldEvidence<{
    settingsDescriptor: DigestDescriptor
    journalDescriptor: DigestDescriptor
  }>,
  allowLegacyWithoutForensic = false,
): HeldEvidence<'exact-restored' | 'valid-advancement'> {
  const platform = options.platform ?? process.platform
  const hasForensicArchive = transaction.forensicArchiveId.length > 0
  const isLegacyWithoutForensic = allowLegacyWithoutForensic
    && transaction.snapshotTimestamp === LEGACY_TRANSACTION_TIMESTAMP
    && !hasForensicArchive
    && transaction.forensicManifest === null
  if (transaction.phase !== 'primary-verified'
    || transaction.windowsVerifiedStartups !== 0
    || (!hasForensicArchive && !isLegacyWithoutForensic)
    || (transaction.forensicManifest !== null && !hasForensicArchive)
    || (platform === 'win32'
      && transaction.lastWindowsStartupId.length === 0
      && !isLegacyWithoutForensic)
    || (platform !== 'win32' && transaction.lastWindowsStartupId.length !== 0)) {
    throw new Error('primary-verified transaction identity does not match an exact verified backup')
  }

  let backup: HeldEvidence<VerifiedSnapshotIdentity> | undefined
  let forensic: HeldEvidence<ForensicArchiveAuthority> | undefined
  let live: HeldEvidence<{
    settingsDescriptor: DigestDescriptor
    journalDescriptor: DigestDescriptor
  }> | undefined = existingLive
  try {
    backup = holdTransactionVerifiedBackup(
      userDataPath,
      transaction,
      options,
      isLegacyWithoutForensic,
    )
    if (hasForensicArchive) {
      forensic = holdForensicEvidence(userDataPath, transaction, options)
      onForensicVerified?.()
    }
    live ??= holdVerifiedStreamedPair(userDataPath, transaction, options, true)
    const value = sameDescriptor(live.value.settingsDescriptor, transaction.settings)
      && sameDescriptor(live.value.journalDescriptor, transaction.journal)
      ? 'exact-restored' as const
      : 'valid-advancement' as const
    let closed = false
    return {
      value,
      assertStable() {
        if (closed) throw new Error('completed restore evidence is already closed')
        backup!.assertStable()
        forensic?.assertStable()
        live!.assertStable()
      },
      completeCleanup() {
        if (closed) throw new Error('completed restore evidence is already closed')
        backup!.completeCleanup?.()
      },
      preserve() {
        backup!.preserve?.()
      },
      close() {
        if (closed) return
        closed = true
        live!.close()
        forensic?.close()
        backup!.close()
      },
    }
  } catch (error) {
    live?.close()
    forensic?.close()
    backup?.close()
    throw new Error(
      `primary-verified live settings/journal pair is neither exact nor a valid advancement: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function stagingIsExactlyOnePublicationAhead(
  intent: RestoreTransactionFile,
  staging: RestoreTransactionFile,
  platform: NodeJS.Platform,
): boolean {
  if (intent.phase === 'allocated'
    && staging.phase === (platform === 'win32' ? 'awaiting-windows-confirmation' : 'prepared')) {
    return staging.windowsVerifiedStartups === intent.windowsVerifiedStartups
      && staging.lastWindowsStartupId === intent.lastWindowsStartupId
  }
  if (platform === 'win32'
    && intent.phase === 'awaiting-windows-confirmation'
    && staging.phase === 'awaiting-windows-confirmation') {
    return staging.windowsVerifiedStartups === intent.windowsVerifiedStartups + 1
      && staging.windowsVerifiedStartups <= 2
      && staging.lastWindowsStartupId.length > 0
      && staging.lastWindowsStartupId !== intent.lastWindowsStartupId
  }
  if (intent.phase === 'awaiting-windows-confirmation'
    && staging.phase === 'prepared') {
    return staging.windowsVerifiedStartups === intent.windowsVerifiedStartups
      && staging.lastWindowsStartupId === intent.lastWindowsStartupId
      && (platform !== 'win32' || staging.windowsVerifiedStartups === 2)
  }
  if (intent.phase === 'prepared' && staging.phase === 'primary-verified') {
    return staging.windowsVerifiedStartups === 0
      && staging.lastWindowsStartupId === intent.lastWindowsStartupId
  }
  return false
}

function windowsRestartError(message: string): SettingsRecoveryError {
  return new SettingsRecoveryError(message, [], false, true, true)
}

interface HeldPreparedRestoreEvidence {
  hasForensicEvidence: boolean
  assertPrecommitStable(): void
  assertRecoveryStable(): void
  releaseLiveSourcesForPublication(): void
  originalsArePreserved(): boolean
  close(): void
}

function holdPreparedRestoreEvidence(
  userDataPath: string,
  transaction: RestoreTransactionFile,
  options: RecoveryOptions,
  existingForensicLease?: HeldForensicEvidenceLease,
): HeldPreparedRestoreEvidence {
  let stagedBackup: HeldEvidence<{
    settingsDescriptor: DigestDescriptor
    journalDescriptor: DigestDescriptor
  }> | undefined
  let forensic = existingForensicLease
  const ownsForensic = !existingForensicLease
  try {
    stagedBackup = holdVerifiedStreamedPair(
      path.join(userDataPath, RESTORE_STAGING_DIR),
      transaction,
      options,
      false,
    )
    if (!sameDescriptor(stagedBackup.value.settingsDescriptor, transaction.settings)
      || !sameDescriptor(stagedBackup.value.journalDescriptor, transaction.journal)) {
      throw new Error('held staged backup does not match restore transaction')
    }
    if (transaction.forensicArchiveId) {
      forensic ??= holdForensicEvidenceLease(userDataPath, transaction, options)
      if (forensic.authority.archiveId !== transaction.forensicArchiveId
        || (transaction.forensicManifest
          && !sameDescriptor(forensic.authority.manifest, transaction.forensicManifest))) {
        throw new Error('held forensic preservation authority does not match restore transaction')
      }
    } else if (forensic) {
      throw new Error('legacy restore cannot adopt unrelated forensic preservation authority')
    }

    let closed = false
    const assertPrecommitStable = () => {
      if (closed) throw new Error('prepared restore evidence is already closed')
      stagedBackup!.assertStable()
      forensic?.assertPrecommitStable()
      stagedBackup!.assertStable()
    }
    const assertRecoveryStable = () => {
      if (closed) throw new Error('prepared restore evidence is already closed')
      stagedBackup!.assertStable()
      forensic?.assertArchiveStable()
      forensic?.assertSourceDescriptorsStable()
      stagedBackup!.assertStable()
    }
    assertPrecommitStable()
    return {
      hasForensicEvidence: Boolean(forensic),
      assertPrecommitStable,
      assertRecoveryStable,
      releaseLiveSourcesForPublication() {
        if (closed) throw new Error('prepared restore evidence is already closed')
        forensic?.releaseSourceDescriptorsForPublication()
      },
      originalsArePreserved() {
        if (!forensic || closed) return false
        try {
          forensic.assertArchiveStable()
          return true
        } catch {
          return false
        }
      },
      close() {
        if (closed) return
        closed = true
        if (ownsForensic) forensic?.close()
        stagedBackup!.close()
      },
    }
  } catch (error) {
    if (ownsForensic) forensic?.close()
    stagedBackup?.close()
    throw error
  }
}

function resumeRestoreIntent(
  userDataPath: string,
  options: RecoveryOptions,
  existingForensicLease?: HeldForensicEvidenceLease,
): boolean {
  const platform = options.platform ?? process.platform
  const ops = options.durableFs ?? DEFAULT_DURABLE_OPS
  const intentPath = path.join(userDataPath, RESTORE_INTENT_FILE)
  if (!fs.existsSync(intentPath)) return false
  const stagingPath = path.join(userDataPath, RESTORE_STAGING_DIR)
  let primaryWriteStarted = false
  let completedRestoreWasPublished = false
  let forensicConfirmed = false
  let precommitEvidence: HeldPreparedRestoreEvidence | undefined
  try {
    const readOptions: BackupReadOptions = { ...options, platform, durableFs: ops }
    let expectedIntentBytes = readRegularFileOnce(userDataPath, RESTORE_INTENT_FILE, readOptions)
    const parsedIntent = parseRestoreIntent(expectedIntentBytes)
    const writeIntentDurably = (transaction: RestoreTransactionFile): void => {
      const bytes = transactionBytes(transaction)
      writeDurably(intentPath, bytes, platform, ops)
      expectedIntentBytes = bytes
    }
    const isLegacyIntent = parsedIntent.version === 1
    const intentTransaction = normalizeTransaction(parsedIntent)
    if (isLegacyIntent && !intentTransaction.forensicArchiveId) forensicConfirmed = false
    if (intentTransaction.phase === 'primary-verified') {
      primaryWriteStarted = true
      completedRestoreWasPublished = true
    }
    if (!fs.existsSync(stagingPath)) {
      if (intentTransaction.phase !== 'primary-verified' && !isLegacyIntent) {
        throw new SettingsRecoveryError(
          'Restore intent survived but its verified staging directory is missing.',
          [],
          false,
          false,
          true,
        )
      }

      primaryWriteStarted = true
      completedRestoreWasPublished = true
      const completedTransaction: RestoreTransactionFile = isLegacyIntent
        ? { ...intentTransaction, phase: 'primary-verified' }
        : intentTransaction
      const held = holdCompletedRestoreLiveState(userDataPath, completedTransaction, options, () => {
        forensicConfirmed = true
      }, undefined, isLegacyIntent)
      let cleanupComplete = false
      try {
        held.assertStable()
        removeMatchingIntentDurably(userDataPath, expectedIntentBytes, platform, ops)
        held.completeCleanup?.()
        cleanupComplete = true
      } finally {
        if (!cleanupComplete) held.preserve?.()
        held.close()
      }
      return true
    }
    let transaction = intentTransaction
    const metadataPath = path.join(stagingPath, RESTORE_STAGE_METADATA_FILE)
    const metadataExists = fs.existsSync(metadataPath)
    if (metadataExists) {
      const stageMetadata = normalizeTransaction(
        readTransactionFile(stagingPath, RESTORE_STAGE_METADATA_FILE, readOptions),
      )
      if (!sameTransactionIdentity(stageMetadata, intentTransaction)) {
        throw new Error('restore intent and staging metadata differ')
      }
      if (sameTransactionControls(stageMetadata, intentTransaction)) {
        transaction = intentTransaction
      } else if (stagingIsExactlyOnePublicationAhead(intentTransaction, stageMetadata, platform)) {
        transaction = stageMetadata
      } else {
        throw new Error('restore intent and staging transaction controls diverge')
      }
    }

    if (transaction.phase === 'primary-verified') {
      primaryWriteStarted = true
      completedRestoreWasPublished = true
      verifyCompletedRestoreStaging(stagingPath, transaction, options)
      if (!metadataExists) {
        // A surviving exact outer intent is the only authority allowed to
        // reconstruct missing stage metadata.
        writeDurably(metadataPath, transactionBytes(transaction), platform, ops)
      }
      const held = holdCompletedRestoreLiveState(userDataPath, transaction, options, () => {
        forensicConfirmed = true
      }, undefined, isLegacyIntent)
      let cleanupComplete = false
      try {
        held.assertStable()
        removeStagingDurably(userDataPath, platform, ops)
        held.assertStable()
        removeMatchingIntentDurably(userDataPath, expectedIntentBytes, platform, ops)
        held.completeCleanup?.()
        cleanupComplete = true
      } finally {
        if (!cleanupComplete) held.preserve?.()
        held.close()
      }
      return true
    }

    const pair = verifyPairDirectory(stagingPath, transaction, readOptions)
    if (!metadataExists) {
      // A surviving exact outer intent is the only authority allowed to
      // reconstruct missing stage metadata.
      writeDurably(metadataPath, transactionBytes(transaction), platform, ops)
    }

    if (transaction.phase === 'allocated') {
      transaction = {
        ...transaction,
        phase: platform === 'win32' ? 'awaiting-windows-confirmation' : 'prepared',
      }
      writeDurably(metadataPath, transactionBytes(transaction), platform, ops)
      writeIntentDurably(transaction)
    }

    if (platform === 'win32' && transaction.phase !== 'primary-verified') {
      verifyForensicEvidence(userDataPath, transaction, { ...options, platform })
      const startupId = options.startupId ?? ''
      if (startupId
        && startupId !== transaction.lastWindowsStartupId
        && transaction.windowsVerifiedStartups < 2) {
        transaction = {
          ...transaction,
          windowsVerifiedStartups: transaction.windowsVerifiedStartups + 1,
          lastWindowsStartupId: startupId,
        }
        writeDurably(metadataPath, transactionBytes(transaction), platform, ops)
        writeIntentDurably(transaction)
      }
      forensicConfirmed = transaction.windowsVerifiedStartups >= 2
      if (!forensicConfirmed) {
        throw windowsRestartError(
          'Windows recovery evidence is verified but requires another independent application restart before primary overwrite.',
        )
      }
      transaction = { ...transaction, phase: 'prepared' }
      writeDurably(metadataPath, transactionBytes(transaction), platform, ops)
      writeIntentDurably(transaction)
    } else if (platform !== 'win32' && transaction.phase === 'awaiting-windows-confirmation') {
      transaction = { ...transaction, phase: 'prepared' }
      writeDurably(metadataPath, transactionBytes(transaction), platform, ops)
      writeIntentDurably(transaction)
    }

    // Keep the selected backup, the durable forensic archive, and the exact
    // pre-restore live sources held as one authority until pair publication
    // and every rollback/follow-up decision has completed.
    forensicConfirmed = false
    precommitEvidence = holdPreparedRestoreEvidence(
      userDataPath,
      transaction,
      options,
      existingForensicLease,
    )
    forensicConfirmed = precommitEvidence.originalsArePreserved()
    const primaryTargets = new Set([
      path.resolve(userDataPath, SETTINGS_FILE),
      path.resolve(userDataPath, BABY_INFO_JOURNAL_FILE),
    ])
    let primaryPublications = 0
    const guardedPrimaryOps: DurableFileOps = {
      ...ops,
      renameSync(source, destination) {
        if (primaryTargets.has(path.resolve(String(destination)))) {
          if (primaryPublications === 0) {
            precommitEvidence!.assertPrecommitStable()
            // Windows does not permit replacing a path while its old inode is
            // open. The durable forensic archive remains held; release only
            // the just-revalidated live source handles at the commit seam.
            precommitEvidence!.releaseLiveSourcesForPublication()
            precommitEvidence!.assertRecoveryStable()
          } else {
            precommitEvidence!.assertRecoveryStable()
          }
          forensicConfirmed = precommitEvidence!.originalsArePreserved()
          // From this point a delegated rename may commit and then lose its
          // response, so reporting the primary as untouched would be unsafe.
          primaryWriteStarted = true
          ops.renameSync(source, destination)
          primaryPublications += 1
          return
        }
        ops.renameSync(source, destination)
      },
    }
    writeDurably(
      path.join(userDataPath, SETTINGS_FILE),
      pair.settingsBytes,
      platform,
      guardedPrimaryOps,
    )
    writeDurably(
      path.join(userDataPath, BABY_INFO_JOURNAL_FILE),
      pair.journalBytes,
      platform,
      guardedPrimaryOps,
    )
    precommitEvidence.assertRecoveryStable()
    const publicationLive = holdVerifiedStreamedPair(userDataPath, transaction, options, false)
    try {
      if (!sameDescriptor(publicationLive.value.settingsDescriptor, transaction.settings)
        || !sameDescriptor(publicationLive.value.journalDescriptor, transaction.journal)) {
        throw new Error('published live settings/journal pair checksum mismatch')
      }

      transaction = { ...transaction, phase: 'primary-verified', windowsVerifiedStartups: 0 }
      writeDurably(metadataPath, transactionBytes(transaction), platform, ops)
      // A parsed v1 outer intent is the provenance marker for the narrow
      // no-forensic compatibility path; retain it as the last authority.
      if (!isLegacyIntent) writeIntentDurably(transaction)
      if (platform === 'win32') {
        publicationLive.assertStable()
        throw new SettingsRestoreFinalizationError()
      }
      completedRestoreWasPublished = true
      const held = holdCompletedRestoreLiveState(userDataPath, transaction, options, () => {
        forensicConfirmed = true
      }, publicationLive, isLegacyIntent)
      let cleanupComplete = false
      try {
        held.assertStable()
        removeStagingDurably(userDataPath, platform, ops)
        held.assertStable()
        removeMatchingIntentDurably(userDataPath, expectedIntentBytes, platform, ops)
        held.completeCleanup?.()
        cleanupComplete = true
      } finally {
        if (!cleanupComplete) held.preserve?.()
        held.close()
      }
      return true
    } finally {
      publicationLive.close()
    }
  } catch (error) {
    if (error instanceof SettingsRecoveryError) throw error
    if (precommitEvidence) {
      forensicConfirmed = precommitEvidence.originalsArePreserved()
    } else if (existingForensicLease) {
      try {
        existingForensicLease.assertArchiveStable()
        forensicConfirmed = true
      } catch {
        forensicConfirmed = false
      }
    }
    const message = `Unable to resume the settings/journal restore transaction: ${error instanceof Error ? error.message : String(error)}`
    if (completedRestoreWasPublished) {
      throw new SettingsRestoreFollowUpError(message, forensicConfirmed)
    }
    throw new SettingsRecoveryError(
      message,
      [],
      forensicConfirmed,
      platform === 'win32' && !primaryWriteStarted,
      !primaryWriteStarted,
    )
  } finally {
    precommitEvidence?.close()
  }
}

function handleOrphanStaging(userDataPath: string, options: RecoveryOptions): boolean {
  const platform = options.platform ?? process.platform
  const ops = options.durableFs ?? DEFAULT_DURABLE_OPS
  const stagingPath = path.join(userDataPath, RESTORE_STAGING_DIR)
  if (!fs.existsSync(stagingPath)) return false
  const metadataPath = path.join(stagingPath, RESTORE_STAGE_METADATA_FILE)
  if (!fs.existsSync(metadataPath)) {
    // A directory created before its allocation marker is not a source of
    // truth. Removing it makes the next decision from the readable live pair
    // or from a separately verified backup and cannot create a startup loop.
    removeStagingDurably(userDataPath, platform, ops)
    return false
  }
  let completedRestoreWasPublished = false
  let forensicConfirmed = false
  let preparedForVerification: RestoreTransactionFile | undefined
  try {
    const parsed = normalizeTransaction(
      readTransactionFile(stagingPath, RESTORE_STAGE_METADATA_FILE, { platform }),
    )
    if (parsed.phase === 'allocated') {
      removeStagingDurably(userDataPath, platform, ops)
      return false
    }
    if (parsed.phase === 'primary-verified') {
      completedRestoreWasPublished = true
      const held = holdCompletedRestoreLiveState(userDataPath, parsed, options, () => {
        forensicConfirmed = true
      })
      let cleanupComplete = false
      try {
        held.assertStable()
        removeStagingDurably(userDataPath, platform, ops)
        held.assertStable()
        held.completeCleanup?.()
        cleanupComplete = true
      } finally {
        if (!cleanupComplete) held.preserve?.()
        held.close()
      }
      return true
    }

    const pair = verifyPairDirectory(stagingPath, parsed, { platform })
    const prepared: RestoreTransactionFile = platform === 'win32'
      ? {
          ...parsed,
          settings: descriptor(pair.settingsBytes),
          journal: descriptor(pair.journalBytes),
          phase: 'awaiting-windows-confirmation',
          windowsVerifiedStartups: 0,
          lastWindowsStartupId: options.startupId ?? '',
        }
      : {
          ...parsed,
          settings: descriptor(pair.settingsBytes),
          journal: descriptor(pair.journalBytes),
          phase: 'prepared',
          windowsVerifiedStartups: 0,
          lastWindowsStartupId: '',
        }
    preparedForVerification = prepared
    verifyForensicEvidence(userDataPath, prepared, { platform, now: options.now })
    forensicConfirmed = true
    writeDurably(metadataPath, transactionBytes(prepared), platform, ops)
    writeDurably(
      path.join(userDataPath, RESTORE_INTENT_FILE),
      transactionBytes(prepared),
      platform,
      ops,
    )
    return resumeRestoreIntent(userDataPath, options)
  } catch (error) {
    if (error instanceof SettingsRecoveryError) throw error
    const message = `Unable to recover orphan restore staging: ${error instanceof Error ? error.message : String(error)}`
    if (completedRestoreWasPublished) {
      throw new SettingsRestoreFollowUpError(message, forensicConfirmed)
    }
    // A failure here (e.g. writing the staging metadata or intent marker)
    // must not overwrite a forensic confirmation already obtained above:
    // re-derive the truth at report time instead of assuming failure.
    if (preparedForVerification) {
      try {
        verifyForensicEvidence(userDataPath, preparedForVerification, { platform, now: options.now })
        forensicConfirmed = true
      } catch {
        forensicConfirmed = false
      }
    }
    throw new SettingsRecoveryError(
      message,
      [],
      forensicConfirmed,
      platform === 'win32',
      false,
    )
  }
}

function livePairIsReadable(userDataPath: string, options: BackupReadOptions): boolean {
  const settingsPath = path.join(userDataPath, SETTINGS_FILE)
  const journalPath = path.join(userDataPath, BABY_INFO_JOURNAL_FILE)
  if (!fs.existsSync(settingsPath) && !fs.existsSync(journalPath)) return true
  let settings: AppSettings
  try {
    settings = parseSettingsBytes(readRegularFileOnce(userDataPath, SETTINGS_FILE, options))
  } catch {
    return false
  }
  if (!fs.existsSync(journalPath)) return isLegacySettings(settings)
  try {
    // Live journals retain their established final-torn-record repair behavior.
    new BabyInfoJournal('', {
      sourceBuffer: readRegularFileOnce(userDataPath, BABY_INFO_JOURNAL_FILE, options),
    })
    return true
  } catch {
    return false
  }
}

interface ForensicManifest {
  version: 1
  source: 'baby-diary-recovery'
  archivedAt: string
  files: BackupManifestEntry[]
}

interface ForensicIdentity {
  archiveId: string
  manifest: DigestDescriptor
  /** True only when the archive directory entry was confirmed across the platform boundary. */
  preserved: boolean
}

interface ForensicArchiveAuthority {
  archiveId: string
  manifest: DigestDescriptor
  entries: ReadonlyMap<string, DigestDescriptor>
}

interface HeldForensicEvidenceLease {
  authority: ForensicArchiveAuthority
  assertPrecommitStable(): void
  assertArchiveStable(): void
  assertSourceDescriptorsStable(): void
  releaseSourceDescriptorsForPublication(): void
  close(): void
}

interface ForensicEvidence extends ForensicIdentity {
  lease: HeldForensicEvidenceLease
}

interface HeldOriginalEvidence extends ExpectedOpenRegularFile {
  relativePath: string
}

function hashForensicSourceSet(
  sources: readonly OpenRegularFile[],
  options: BackupReadOptions,
): { evidenceDigest: string; originals: HeldOriginalEvidence[] } {
  const aggregate = createHash('sha256')
  aggregate.update(Buffer.from('baby-diary-forensic-v1\0', 'utf8'))
  const originals: HeldOriginalEvidence[] = []
  const readSync = positionalReadSync(options)
  for (const source of sources) {
    const nameBytes = Buffer.from(source.relativePath, 'utf8')
    const frame = Buffer.alloc(12)
    frame.writeUInt32BE(nameBytes.byteLength, 0)
    frame.writeBigUInt64BE(BigInt(source.opened.size), 4)
    aggregate.update(frame)
    aggregate.update(nameBytes)

    const content = createHash('sha256')
    const chunk = Buffer.alloc(Math.min(STREAM_CHUNK_BYTES, Math.max(1, source.opened.size)))
    let offset = 0
    while (offset < source.opened.size) {
      const requested = Math.min(chunk.byteLength, source.opened.size - offset)
      const count = readSync(source.fd, chunk, 0, requested, offset)
      if (!Number.isInteger(count) || count <= 0 || count > requested) {
        throw new Error(`forensic source changed during read: ${source.relativePath}`)
      }
      const bytes = chunk.subarray(0, count)
      content.update(bytes)
      aggregate.update(bytes)
      offset += count
    }
    assertOpenFileUnchanged(source)
    originals.push({
      relativePath: source.relativePath,
      source,
      expected: { size: source.opened.size, sha256: content.digest('hex') },
    })
  }
  for (const source of sources) assertOpenFileUnchanged(source)
  return { evidenceDigest: aggregate.digest('hex').slice(0, 16), originals }
}

function streamOpenForensicSourceDurably(
  original: HeldOriginalEvidence,
  destination: string,
  options: RecoveryOptions,
): void {
  const ops = options.durableFs ?? DEFAULT_DURABLE_OPS
  const temporary = `${destination}.tmp-${process.pid}-${forensicStreamSequence++}`
  const readSync = positionalReadSync(options)
  const content = createHash('sha256')
  const chunk = Buffer.alloc(Math.min(
    STREAM_CHUNK_BYTES,
    Math.max(1, original.source.opened.size),
  ))
  let fd: number | undefined
  let renamed = false
  try {
    fd = ops.openSync(temporary, 'wx', 0o600)
    let offset = 0
    while (offset < original.source.opened.size) {
      const requested = Math.min(chunk.byteLength, original.source.opened.size - offset)
      const count = readSync(original.source.fd, chunk, 0, requested, offset)
      if (!Number.isInteger(count) || count <= 0 || count > requested) {
        throw new Error(`forensic source changed during copy: ${original.relativePath}`)
      }
      const bytes = chunk.subarray(0, count)
      content.update(bytes)
      writeAllSync(fd, bytes, ops)
      offset += count
    }
    ops.fsyncSync(fd)
    ops.closeSync(fd)
    fd = undefined
    const copied = { size: original.source.opened.size, sha256: content.digest('hex') }
    assertOpenFileUnchanged(original.source)
    if (!sameDescriptor(copied, original.expected)) {
      throw new Error(`forensic source changed between hash and copy: ${original.relativePath}`)
    }
    ops.renameSync(temporary, destination)
    renamed = true
  } finally {
    if (fd !== undefined) ops.closeSync(fd)
    if (!renamed && ops.existsSync(temporary)) {
      try { ops.unlinkSync(temporary) } catch { /* preserve the original failure */ }
    }
  }
}

interface BoundDirectoryIdentity {
  absolute: string
  real: string
  parentReal: string
  stat: fs.Stats
  label: string
}

function sameCanonicalPath(left: string, right: string): boolean {
  return path.relative(left, right) === '' && path.relative(right, left) === ''
}

function bindDirectChildDirectory(
  directory: string,
  parentReal: string,
  label: string,
): BoundDirectoryIdentity {
  const absolute = path.resolve(directory)
  const stat = fs.lstatSync(absolute)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a regular directory`)
  }
  const real = fs.realpathSync.native(absolute)
  if (!sameCanonicalPath(path.dirname(real), parentReal)) {
    throw new Error(`${label} resolves outside its expected parent`)
  }
  return { absolute, real, parentReal, stat, label }
}

function assertBoundDirectory(identity: BoundDirectoryIdentity): void {
  const stat = fs.lstatSync(identity.absolute)
  if (stat.isSymbolicLink()
    || !stat.isDirectory()
    || stat.dev !== identity.stat.dev
    || stat.ino !== identity.stat.ino
    || stat.mode !== identity.stat.mode
    || stat.birthtimeMs !== identity.stat.birthtimeMs) {
    throw new Error(`${identity.label} identity changed`)
  }
  const real = fs.realpathSync.native(identity.absolute)
  if (!sameCanonicalPath(real, identity.real)
    || !sameCanonicalPath(path.dirname(real), identity.parentReal)) {
    throw new Error(`${identity.label} escaped its expected parent`)
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as NodeJS.ErrnoException).code === 'EEXIST'
}

function tryReuseForensicEvidence(
  forensicsRoot: string,
  rootIdentity: BoundDirectoryIdentity,
  archiveId: string,
  originals: readonly HeldOriginalEvidence[],
  options: BackupReadOptions,
): ForensicIdentity | undefined {
  try {
    const archiveDir = path.join(forensicsRoot, archiveId)
    const archiveIdentity = bindDirectChildDirectory(
      archiveDir,
      rootIdentity.real,
      'reusable forensic preservation archive',
    )
    const assertForensicDirectories = () => {
      assertBoundDirectory(rootIdentity)
      assertBoundDirectory(archiveIdentity)
    }
    assertForensicDirectories()

    const expectedNames = [
      BACKUP_MANIFEST_FILE,
      ...originals.map(original => original.relativePath),
    ].sort()
    const actualEntries = boundedDirectoryEntries(
      archiveDir,
      3,
      'forensic archive entry',
    )
    const actualNames = actualEntries.map(entry => entry.name).sort()
    if (actualNames.length !== expectedNames.length
      || actualNames.some((name, index) => name !== expectedNames[index])
      || actualEntries.some(entry => !entry.isFile())) {
      return undefined
    }

    assertForensicDirectories()
    const manifestBytes = readRegularFileOnce(archiveDir, BACKUP_MANIFEST_FILE, options)
    let raw: unknown
    try {
      raw = JSON.parse(manifestBytes.toString('utf8'))
    } catch {
      return undefined
    }
    if (!isRecord(raw)
      || !exactKeys(raw, ['version', 'source', 'archivedAt', 'files'])
      || raw.version !== 1
      || raw.source !== 'baby-diary-recovery'
      || typeof raw.archivedAt !== 'string'
      || !Array.isArray(raw.files)
      || raw.files.length !== originals.length) {
      return undefined
    }
    strictTimestamp(raw.archivedAt, options.now ?? new Date())

    const originalsByPath = new Map(
      originals.map(original => [original.relativePath, original] as const),
    )
    const seen = new Set<string>()
    for (const value of raw.files) {
      if (!isRecord(value)
        || !exactKeys(value, ['path', 'size', 'sha256'])
        || typeof value.path !== 'string'
        || seen.has(value.path)
        || !validDigestDescriptor({ size: value.size, sha256: value.sha256 })) {
        return undefined
      }
      const original = originalsByPath.get(value.path)
      if (!original) return undefined
      if (value.size !== original.expected.size || value.sha256 !== original.expected.sha256) {
        return undefined
      }
      assertForensicDirectories()
      const archived = hashRegularFileOnce(archiveDir, value.path, options)
      if (!sameDescriptor(archived, original.expected)) return undefined
      seen.add(value.path)
    }
    if (seen.size !== originals.length) return undefined
    assertForensicDirectories()
    const afterEntries = boundedDirectoryEntries(
      archiveDir,
      3,
      'forensic archive entry',
    )
    const afterNames = afterEntries.map(entry => entry.name).sort()
    if (afterNames.length !== expectedNames.length
      || afterNames.some((name, index) => name !== expectedNames[index])
      || afterEntries.some(entry => entry.isSymbolicLink() || !entry.isFile())) {
      return undefined
    }
    assertForensicDirectories()
    return {
      archiveId,
      manifest: descriptor(manifestBytes),
      preserved: true,
    }
  } catch {
    return undefined
  }
}

function preserveOriginals(
  userDataPath: string,
  options: RecoveryOptions,
): ForensicEvidence {
  const platform = options.platform ?? process.platform
  const ops = options.durableFs ?? DEFAULT_DURABLE_OPS
  const now = options.now ?? new Date()
  const archivedAt = now.toISOString()
  const sourceFiles: OpenRegularFile[] = []
  let sourceOwnershipTransferred = false
  try {
    for (const relativePath of [SETTINGS_FILE, BABY_INFO_JOURNAL_FILE]) {
      if (fs.existsSync(path.join(userDataPath, relativePath))) {
        sourceFiles.push(openRegularFileOnce(userDataPath, relativePath, options))
      }
    }
    if (sourceFiles.length === 0) {
      throw new Error('no regular primary files were available for forensic preservation')
    }
    for (const source of sourceFiles) assertOpenFileUnchanged(source)
    const { evidenceDigest, originals } = hashForensicSourceSet(sourceFiles, options)
    const sourceRootIdentity = bindDirectChildDirectory(
      path.resolve(userDataPath),
      fs.realpathSync.native(path.dirname(path.resolve(userDataPath))),
      'forensic original source root',
    )
    const sourceNames = new Set(originals.map(original => original.relativePath))
    const absentSourceNames = [SETTINGS_FILE, BABY_INFO_JOURNAL_FILE]
      .filter(relativePath => !sourceNames.has(relativePath))
    const finalizeIdentity = (identity: ForensicIdentity): ForensicEvidence => {
      const archive = holdForensicEvidence(userDataPath, {
        forensicArchiveId: identity.archiveId,
        forensicManifest: identity.manifest,
      }, options)
      const sources = originalSourceLease(
        originals,
        options,
        () => {
          assertBoundDirectory(sourceRootIdentity)
          for (const relativePath of absentSourceNames) {
            if (fs.existsSync(path.join(userDataPath, relativePath))) {
              throw new Error(`absent live ${relativePath} appeared before primary publication`)
            }
          }
          assertBoundDirectory(sourceRootIdentity)
        },
        () => closeOpenRegularFiles(sourceFiles),
      )
      const lease = composeForensicEvidenceLease(archive, sources)
      sourceOwnershipTransferred = true
      return { ...identity, lease }
    }

    const forensicsRoot = path.join(userDataPath, RECOVERY_FORENSICS_DIR)
  let forensicsRootCreated = false
  try {
    ops.mkdirSync(forensicsRoot)
    forensicsRootCreated = true
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error
  }
  if (forensicsRootCreated) {
    syncDirectory(userDataPath, platform, ops)
  }
  const userDataReal = fs.realpathSync.native(path.resolve(userDataPath))
  const rootIdentity = bindDirectChildDirectory(
    forensicsRoot,
    userDataReal,
    'forensic preservation root',
  )
  assertBoundDirectory(rootIdentity)
  const existingArchives = boundedDirectoryEntries(
    forensicsRoot,
    MAX_FORENSIC_ARCHIVES,
    'forensic archive entry',
  )
  const digestSuffix = new RegExp(`-${evidenceDigest}(?:-\\d+)?$`)
  for (const entry of existingArchives) {
    if (!entry.isDirectory() || !digestSuffix.test(entry.name)) continue
    const reused = tryReuseForensicEvidence(
      forensicsRoot,
      rootIdentity,
      entry.name,
      originals,
      { ...options, platform, now },
    )
    if (reused) {
      assertHeldRegularFilesStable(originals, options)
      return finalizeIdentity(reused)
    }
  }
  assertBoundDirectory(rootIdentity)
  if (existingArchives.length >= MAX_FORENSIC_ARCHIVES) {
    throw new Error('forensic archive capacity is exhausted')
  }
  const baseId = `${archivedAt.replace(/[:.]/g, '-')}-${evidenceDigest}`
  let archiveId: string | undefined
  let archiveIdentity: BoundDirectoryIdentity | undefined
  for (let suffix = 0; suffix < MAX_FORENSIC_ARCHIVE_ALLOCATION_ATTEMPTS; suffix += 1) {
    const candidate = suffix === 0 ? baseId : `${baseId}-${suffix}`
    const candidatePath = path.join(forensicsRoot, candidate)
    try {
      ops.mkdirSync(candidatePath)
      archiveId = candidate
      archiveIdentity = bindDirectChildDirectory(
        candidatePath,
        rootIdentity.real,
        'forensic preservation archive',
      )
      break
    } catch (error) {
      if (isAlreadyExistsError(error)) continue
      throw error
    }
  }
  if (!archiveId || !archiveIdentity) {
    throw new Error('forensic archive allocation attempts exhausted')
  }
  const archiveDir = path.join(forensicsRoot, archiveId)
  assertBoundDirectory(rootIdentity)
  assertBoundDirectory(archiveIdentity)
  syncDirectory(forensicsRoot, platform, ops)
  assertBoundDirectory(rootIdentity)
  assertBoundDirectory(archiveIdentity)

  const assertForensicDirectories = () => {
    assertBoundDirectory(rootIdentity)
    assertBoundDirectory(archiveIdentity!)
  }

  const entries: BackupManifestEntry[] = []
  for (const original of originals) {
    assertForensicDirectories()
    streamOpenForensicSourceDurably(
      original,
      path.join(archiveDir, original.relativePath),
      options,
    )
    assertForensicDirectories()
    entries.push({ path: original.relativePath, ...original.expected })
  }
  const manifest: ForensicManifest = {
    version: 1,
    source: 'baby-diary-recovery',
    archivedAt,
    files: entries,
  }
  const forensicManifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
  assertForensicDirectories()
  writeDurably(
    path.join(archiveDir, BACKUP_MANIFEST_FILE),
    forensicManifestBytes,
    platform,
    ops,
  )
  assertForensicDirectories()
  syncDirectory(archiveDir, platform, ops)
  assertForensicDirectories()

  const expectedNames = [BACKUP_MANIFEST_FILE, ...entries.map(entry => entry.path)].sort()
  const assertExactForensicSet = () => {
    const actualEntries = boundedDirectoryEntries(
      archiveDir,
      3,
      'forensic archive entry',
    )
    const actualNames = actualEntries.map(entry => entry.name).sort()
    if (actualNames.length !== expectedNames.length
      || actualNames.some((name, index) => name !== expectedNames[index])
      || actualEntries.some(entry => entry.isSymbolicLink() || !entry.isFile())) {
      throw new Error('forensic preservation archive contains an unexpected entry')
    }
  }
  assertExactForensicSet()
  assertForensicDirectories()

  // Confirm the durable archive from one-handle reads before any primary write.
  for (const entry of entries) {
    assertForensicDirectories()
    const archived = hashRegularFileOnce(archiveDir, entry.path, { ...options, platform })
    if (!sameDescriptor(archived, entry)) {
      throw new Error(`forensic ${entry.path} checksum mismatch`)
    }
  }
  assertForensicDirectories()
  const manifestBytes = readRegularFileOnce(
    archiveDir,
    BACKUP_MANIFEST_FILE,
    { ...options, platform },
  )
  if (!manifestBytes.equals(forensicManifestBytes)) {
    throw new Error('forensic preservation manifest bytes changed before confirmation')
  }
  const verifiedManifest = JSON.parse(manifestBytes.toString('utf8')) as ForensicManifest
  if (verifiedManifest.source !== 'baby-diary-recovery'
    || verifiedManifest.files.length !== entries.length) {
    throw new Error('forensic preservation manifest verification failed')
  }
  assertExactForensicSet()
  assertForensicDirectories()
    assertHeldRegularFilesStable(originals, options)
    return finalizeIdentity({
      archiveId,
      manifest: descriptor(forensicManifestBytes),
      preserved: platform !== 'win32',
    })
  } finally {
    if (!sourceOwnershipTransferred) closeOpenRegularFiles(sourceFiles)
  }
}

function holdForensicEvidence(
  userDataPath: string,
  transaction: Pick<RestoreTransactionFile, 'forensicArchiveId' | 'forensicManifest'>,
  options: BackupReadOptions,
): HeldEvidence<ForensicArchiveAuthority> {
  if (!transaction.forensicArchiveId
    || transaction.forensicArchiveId.length > 255
    || transaction.forensicArchiveId === '.'
    || transaction.forensicArchiveId === '..'
    || /[\\/\u0000-\u001f\u007f]/.test(transaction.forensicArchiveId)) {
    throw new Error('forensic preservation identity is missing or invalid')
  }
  const forensicRoot = path.join(userDataPath, RECOVERY_FORENSICS_DIR)
  const userDataReal = fs.realpathSync.native(path.resolve(userDataPath))
  const rootIdentity = bindDirectChildDirectory(
    forensicRoot,
    userDataReal,
    'forensic preservation root',
  )
  const archiveDir = path.join(forensicRoot, transaction.forensicArchiveId)
  const archiveIdentity = bindDirectChildDirectory(
    archiveDir,
    rootIdentity.real,
    'forensic preservation archive',
  )
  const assertForensicDirectories = () => {
    assertBoundDirectory(rootIdentity)
    assertBoundDirectory(archiveIdentity)
  }
  assertForensicDirectories()

  const evidenceSources: OpenRegularFile[] = []
  const expectedEvidence: ExpectedOpenRegularFile[] = []
  try {
    const manifestSource = openRegularFileOnce(archiveDir, BACKUP_MANIFEST_FILE, options)
    evidenceSources.push(manifestSource)
    const manifestBytes = readOpenRegularFile(manifestSource, options)
    const manifestDescriptor = descriptor(manifestBytes)
    expectedEvidence.push({ source: manifestSource, expected: manifestDescriptor })
    assertOpenFileUnchanged(manifestSource)
    if (transaction.forensicManifest
      && !sameDescriptor(manifestDescriptor, transaction.forensicManifest)) {
      throw new Error('forensic manifest checksum mismatch')
    }
    let raw: unknown
    try {
      raw = JSON.parse(manifestBytes.toString('utf8'))
    } catch {
      throw new Error('forensic preservation manifest JSON is invalid')
    }
    if (!isRecord(raw)
      || !exactKeys(raw, ['version', 'source', 'archivedAt', 'files'])
      || raw.version !== 1
      || raw.source !== 'baby-diary-recovery'
      || typeof raw.archivedAt !== 'string'
      || !Array.isArray(raw.files)
      || raw.files.length < 1
      || raw.files.length > 2) {
      throw new Error('forensic preservation manifest shape is invalid')
    }
    strictTimestamp(raw.archivedAt, options.now ?? new Date())

    const expectedNames = new Set([SETTINGS_FILE, BABY_INFO_JOURNAL_FILE])
    const seen = new Set<string>()
    const entries = new Map<string, DigestDescriptor>()
    for (const entry of raw.files) {
      if (!isRecord(entry)
        || !exactKeys(entry, ['path', 'size', 'sha256'])
        || typeof entry.path !== 'string'
        || !expectedNames.has(entry.path)
        || seen.has(entry.path)
        || !validDigestDescriptor({ size: entry.size, sha256: entry.sha256 })) {
        throw new Error('forensic preservation manifest entry is invalid')
      }
      seen.add(entry.path)
      entries.set(entry.path, { size: entry.size as number, sha256: entry.sha256 as string })
    }
    const manifestNames = [BACKUP_MANIFEST_FILE, ...Array.from(seen)].sort()
    const assertExactForensicSet = () => {
      const actualEntries = boundedDirectoryEntries(
        archiveDir,
        3,
        'forensic archive entry',
      )
      const actualNames = actualEntries.map(entry => entry.name).sort()
      if (actualNames.length !== manifestNames.length
        || actualNames.some((name, index) => name !== manifestNames[index])
        || actualEntries.some(entry => entry.isSymbolicLink() || !entry.isFile())) {
        throw new Error('forensic preservation archive contains an unexpected entry')
      }
    }

    assertExactForensicSet()
    assertForensicDirectories()
    const settingsEntry = entries.get(SETTINGS_FILE)
    const settingsSource = settingsEntry
      ? openRegularFileOnce(archiveDir, SETTINGS_FILE, options)
      : undefined
    let settingsBytes: Buffer | undefined
    if (settingsSource && settingsEntry) {
      evidenceSources.push(settingsSource)
      expectedEvidence.push({ source: settingsSource, expected: settingsEntry })
      settingsBytes = readOpenRegularFile(settingsSource, options)
      assertOpenFileUnchanged(settingsSource)
      if (!sameDescriptor(descriptor(settingsBytes), settingsEntry)) {
        throw new Error(`forensic ${SETTINGS_FILE} checksum mismatch`)
      }
    }
    const journalEntry = entries.get(BABY_INFO_JOURNAL_FILE)
    if (journalEntry) {
      const journalSource = openRegularFileOnce(archiveDir, BABY_INFO_JOURNAL_FILE, options)
      evidenceSources.push(journalSource)
      expectedEvidence.push({ source: journalSource, expected: journalEntry })
      const actual = stableHashOpenRegularFile(journalSource, options)
      if (!sameDescriptor(actual, journalEntry)) {
        throw new Error(`forensic ${BABY_INFO_JOURNAL_FILE} checksum mismatch`)
      }
    }
    if (settingsSource && settingsBytes) {
      const settingsAfterScan = readOpenRegularFile(settingsSource, options)
      assertOpenFileUnchanged(settingsSource)
      if (!settingsAfterScan.equals(settingsBytes)) {
        throw new Error('forensic settings changed while journal evidence was scanned')
      }
    }
    const manifestAfterScan = readOpenRegularFile(manifestSource, options)
    if (!manifestAfterScan.equals(manifestBytes)) {
      throw new Error('forensic manifest changed while evidence files were scanned')
    }
    assertForensicDirectories()
    assertExactForensicSet()
    assertForensicDirectories()
    for (const source of evidenceSources) assertOpenFileUnchanged(source)

    let closed = false
    return {
      value: {
        archiveId: transaction.forensicArchiveId,
        manifest: manifestDescriptor,
        entries: new Map(entries),
      },
      assertStable() {
        if (closed) throw new Error('forensic evidence is already closed')
        assertHeldRegularFilesStable(expectedEvidence, options)
        assertForensicDirectories()
        assertExactForensicSet()
        assertForensicDirectories()
        for (const source of evidenceSources) assertOpenFileUnchanged(source)
      },
      close() {
        if (closed) return
        closed = true
        closeOpenRegularFiles(evidenceSources)
      },
    }
  } catch (error) {
    closeOpenRegularFiles(evidenceSources)
    throw error
  }
}

function verifyForensicEvidence(
  userDataPath: string,
  transaction: RestoreTransactionFile,
  options: BackupReadOptions,
): void {
  const held = holdForensicEvidence(userDataPath, transaction, options)
  try {
    held.assertStable()
  } finally {
    held.close()
  }
}

interface HeldOriginalSourceLease {
  assertPrecommitStable(): void
  assertDescriptorsStable(): void
  release(): void
  close(): void
}

function originalSourceLease(
  evidence: readonly ExpectedOpenRegularFile[],
  options: BackupReadOptions,
  assertPathSetStable: () => void,
  close: () => void,
): HeldOriginalSourceLease {
  let closed = false
  return {
    assertPrecommitStable() {
      if (closed) throw new Error('forensic original source evidence is already closed')
      assertPathSetStable()
      assertHeldRegularFilesStable(evidence, options)
      assertPathSetStable()
    },
    assertDescriptorsStable() {
      if (closed) throw new Error('forensic original source evidence is already closed')
      assertHeldRegularFileDescriptorsStable(evidence, options)
    },
    release() {
      if (closed) return
      closed = true
      close()
    },
    close() {
      if (closed) return
      closed = true
      close()
    },
  }
}

function holdLiveForensicSources(
  userDataPath: string,
  entries: ReadonlyMap<string, DigestDescriptor>,
  options: BackupReadOptions,
  publication?: Pick<RestoreTransactionFile, 'settings' | 'journal'>,
): HeldOriginalSourceLease {
  const userDataIdentity = bindDirectChildDirectory(
    path.resolve(userDataPath),
    fs.realpathSync.native(path.dirname(path.resolve(userDataPath))),
    'forensic live source root',
  )
  const sources: OpenRegularFile[] = []
  const evidence: ExpectedOpenRegularFile[] = []
  const absent = new Set<string>()
  try {
    for (const relativePath of [SETTINGS_FILE, BABY_INFO_JOURNAL_FILE]) {
      const originalExpected = entries.get(relativePath)
      const publicationExpected = relativePath === SETTINGS_FILE
        ? publication?.settings
        : publication?.journal
      if (!fs.existsSync(path.join(userDataPath, relativePath))) {
        if (originalExpected) {
          throw new Error(`live ${relativePath} vanished after forensic preservation`)
        }
        absent.add(relativePath)
        continue
      }
      const source = openRegularFileOnce(userDataPath, relativePath, options)
      sources.push(source)
      const actual = stableHashOpenRegularFile(source, options)
      if ((!originalExpected || !sameDescriptor(actual, originalExpected))
        && (!publicationExpected || !sameDescriptor(actual, publicationExpected))) {
        throw new Error(`live ${relativePath} matches neither forensic nor restore authority`)
      }
      evidence.push({ source, expected: actual })
    }
    const assertPathSetStable = () => {
      assertBoundDirectory(userDataIdentity)
      for (const relativePath of Array.from(absent)) {
        if (fs.existsSync(path.join(userDataPath, relativePath))) {
          throw new Error(`absent live ${relativePath} appeared before primary publication`)
        }
      }
      assertBoundDirectory(userDataIdentity)
    }
    const lease = originalSourceLease(
      evidence,
      options,
      assertPathSetStable,
      () => closeOpenRegularFiles(sources),
    )
    lease.assertPrecommitStable()
    return lease
  } catch (error) {
    closeOpenRegularFiles(sources)
    throw error
  }
}

function composeForensicEvidenceLease(
  archive: HeldEvidence<ForensicArchiveAuthority>,
  sources: HeldOriginalSourceLease,
): HeldForensicEvidenceLease {
  let closed = false
  let sourcesReleased = false
  return {
    authority: archive.value,
    assertPrecommitStable() {
      if (closed) throw new Error('forensic preservation lease is already closed')
      sources.assertPrecommitStable()
      archive.assertStable()
      sources.assertPrecommitStable()
    },
    assertArchiveStable() {
      if (closed) throw new Error('forensic preservation lease is already closed')
      archive.assertStable()
    },
    assertSourceDescriptorsStable() {
      if (closed) throw new Error('forensic preservation lease is already closed')
      if (!sourcesReleased) sources.assertDescriptorsStable()
    },
    releaseSourceDescriptorsForPublication() {
      if (closed) throw new Error('forensic preservation lease is already closed')
      if (sourcesReleased) return
      sources.assertDescriptorsStable()
      sources.release()
      sourcesReleased = true
    },
    close() {
      if (closed) return
      closed = true
      if (!sourcesReleased) sources.close()
      archive.close()
    },
  }
}

function holdForensicEvidenceLease(
  userDataPath: string,
  transaction: RestoreTransactionFile,
  options: BackupReadOptions,
): HeldForensicEvidenceLease {
  const archive = holdForensicEvidence(userDataPath, transaction, options)
  let sources: HeldOriginalSourceLease | undefined
  try {
    sources = holdLiveForensicSources(userDataPath, archive.value.entries, options, transaction)
    const lease = composeForensicEvidenceLease(archive, sources)
    lease.assertPrecommitStable()
    return lease
  } catch (error) {
    sources?.close()
    archive.close()
    throw error
  }
}

interface CandidateBudget {
  entriesSeen: number
}

function listSnapshotCandidates(
  root: string,
  limits: BackupResourceLimits,
  budget: CandidateBudget,
): string[] {
  if (!fs.existsSync(root)) return []
  const rootStat = fs.lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return []
  const remaining = limits.maxCandidates - budget.entriesSeen
  const entries = boundedDirectoryEntries(root, Math.max(0, remaining), 'backup candidate')
  budget.entriesSeen += entries.length
  return entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.includes('.tmp-'))
    .map(entry => path.join(root, entry.name))
}

function newestVerifiedBackup(
  userDataPath: string,
  options: RecoveryOptions,
): { pair?: VerifiedBackupPair; rejected: string[] } {
  const roots = [path.join(userDataPath, 'backups')]
  if (options.documentsBackupDir
    && path.resolve(options.documentsBackupDir) !== path.resolve(roots[0])) {
    roots.push(options.documentsBackupDir)
  }
  const rejected: string[] = []
  const limits = resourceLimits(options.limits)
  const budget: CandidateBudget = { entriesSeen: 0 }
  let best: { pair: VerifiedBackupPair; destinationRank: number } | undefined
  roots.forEach((root, destinationRank) => {
    for (const candidate of listSnapshotCandidates(root, limits, budget)) {
      try {
        const current = { pair: verifyBackupSnapshot(candidate, options), destinationRank }
        if (!best) {
          best = current
          continue
        }
        const byTimestamp = Date.parse(current.pair.snapshotTimestamp) - Date.parse(best.pair.snapshotTimestamp)
        const currentWins = byTimestamp > 0
          || (byTimestamp === 0 && current.destinationRank < best.destinationRank)
          || (byTimestamp === 0
            && current.destinationRank === best.destinationRank
            && path.resolve(current.pair.snapshotPath).localeCompare(path.resolve(best.pair.snapshotPath)) < 0)
        if (currentWins) best = current
      } catch {
        rejected.push(candidate)
      }
    }
  })
  return { pair: best?.pair, rejected }
}

function prepareRestoreIntent(
  userDataPath: string,
  pair: VerifiedBackupPair,
  forensic: ForensicEvidence,
  options: RecoveryOptions,
): RestoreTransactionFile {
  const platform = options.platform ?? process.platform
  const ops = options.durableFs ?? DEFAULT_DURABLE_OPS
  const stagingPath = path.join(userDataPath, RESTORE_STAGING_DIR)
  if (fs.existsSync(stagingPath)) {
    throw new Error('restore staging already exists and was not garbage-collected')
  }
  ops.mkdirSync(stagingPath, { recursive: true })
  syncDirectory(userDataPath, platform, ops)

  let transaction: RestoreTransactionFile = {
    version: 3,
    snapshotId: pair.snapshotId,
    snapshotTimestamp: pair.snapshotTimestamp,
    settings: descriptor(pair.settingsBytes),
    journal: descriptor(pair.journalBytes),
    phase: 'allocated',
    windowsVerifiedStartups: 0,
    lastWindowsStartupId: platform === 'win32' ? options.startupId ?? '' : '',
    forensicArchiveId: forensic.archiveId,
    forensicManifest: forensic.manifest,
  }
  const metadataPath = path.join(stagingPath, RESTORE_STAGE_METADATA_FILE)
  // The allocation marker is the first published child. Any crash before it
  // leaves a metadata-free directory that startup can safely discard.
  writeDurably(metadataPath, transactionBytes(transaction), platform, ops)
  writeDurably(path.join(stagingPath, SETTINGS_FILE), pair.settingsBytes, platform, ops)
  writeDurably(path.join(stagingPath, BABY_INFO_JOURNAL_FILE), pair.journalBytes, platform, ops)
  verifyPairDirectory(stagingPath, transaction, { platform })

  transaction = {
    ...transaction,
    phase: platform === 'win32' ? 'awaiting-windows-confirmation' : 'prepared',
  }
  writeDurably(metadataPath, transactionBytes(transaction), platform, ops)
  syncDirectory(stagingPath, platform, ops)
  writeDurably(
    path.join(userDataPath, RESTORE_INTENT_FILE),
    transactionBytes(transaction),
    platform,
    ops,
  )
  return transaction
}

/** Runs before SettingsStore exposes either member of the persisted pair. */
export function recoverSettingsAndJournalPair(
  userDataPath: string,
  options: RecoveryOptions = {},
): void {
  try {
    reconcileIntentTombstone(userDataPath, options)
  } catch (error) {
    throw new SettingsRecoveryError(
      `Restore intent tombstone reconciliation stopped safely: ${error instanceof Error ? error.message : String(error)}`,
      [],
      false,
      false,
      true,
    )
  }
  if (resumeRestoreIntent(userDataPath, options)) return
  if (handleOrphanStaging(userDataPath, options)) return
  if (livePairIsReadable(userDataPath, options)) return

  let forensic: ForensicEvidence
  try {
    forensic = preserveOriginals(userDataPath, options)
  } catch (error) {
    throw new SettingsRecoveryError(
      `Recovery stopped before overwrite because forensic preservation failed: ${error instanceof Error ? error.message : String(error)}`,
      [],
      false,
      false,
      true,
    )
  }

  try {
    const originalsArePreserved = () => {
      if (!forensic.preserved) return false
      try {
        forensic.lease.assertArchiveStable()
        return true
      } catch {
        return false
      }
    }
    const selected = newestVerifiedBackup(userDataPath, options)
    if (!selected.pair) {
      throw new SettingsRecoveryError(
        'Settings and baby-info history are damaged, and no fully verified backup pair is available.',
        selected.rejected,
        originalsArePreserved(),
        false,
        true,
      )
    }
    try {
      prepareRestoreIntent(userDataPath, selected.pair, forensic, options)
      if ((options.platform ?? process.platform) === 'win32') {
        throw windowsRestartError(
          'Windows recovery evidence was prepared without modifying the primary files. Restart the application twice so independent startups can confirm it before restore.',
        )
      }
      resumeRestoreIntent(userDataPath, options, forensic.lease)
    } catch (error) {
      if (error instanceof SettingsRecoveryError) {
        throw new SettingsRecoveryError(
          error.message,
          selected.rejected,
          error.originalsPreserved,
          error.restartRequired,
          error.primaryUntouched,
        )
      }
      throw new SettingsRecoveryError(
        `Unable to restore the verified settings/journal pair: ${error instanceof Error ? error.message : String(error)}`,
        selected.rejected,
        originalsArePreserved(),
        false,
        true,
      )
    }
  } finally {
    forensic.lease.close()
  }
}

/**
 * Retention is computed only from fully verified snapshots. Invalid entries are
 * deliberately preserved for explicit reporting/quarantine and never occupy a
 * monthly keep slot.
 */
export function selectVerifiedBackupsToPrune(root: string, now: Date): string[] {
  interface RetentionDescriptor { snapshotTimestamp: string; snapshotPath: string }
  const verified: RetentionDescriptor[] = []
  const limits = resourceLimits(undefined)
  const budget: CandidateBudget = { entriesSeen: 0 }
  for (const candidate of listSnapshotCandidates(root, limits, budget)) {
    try {
      const pair = verifyBackupSnapshot(candidate, { now })
      verified.push({
        snapshotTimestamp: pair.snapshotTimestamp,
        snapshotPath: pair.snapshotPath,
      })
    } catch {
      // Invalid folders are never silently deleted by retention.
    }
  }
  const cutoff = now.getTime() - 90 * 24 * 60 * 60 * 1000
  const monthly = new Map<string, RetentionDescriptor[]>()
  for (const pair of verified) {
    const timestamp = Date.parse(pair.snapshotTimestamp)
    if (timestamp >= cutoff) continue
    const date = new Date(timestamp)
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
    const items = monthly.get(key) ?? []
    items.push(pair)
    monthly.set(key, items)
  }
  const result: string[] = []
  for (const items of Array.from(monthly.values())) {
    items.sort((left: RetentionDescriptor, right: RetentionDescriptor) => Date.parse(right.snapshotTimestamp) - Date.parse(left.snapshotTimestamp)
      || path.resolve(left.snapshotPath).localeCompare(path.resolve(right.snapshotPath)))
    result.push(...items.slice(1).map((pair: RetentionDescriptor) => path.basename(pair.snapshotPath)))
  }
  return result.sort()
}
