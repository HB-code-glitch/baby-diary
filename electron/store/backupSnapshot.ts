import { createHash } from 'crypto'
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
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024
const MAX_DATA_BYTES = 512 * 1024 * 1024
const MAX_TRANSACTION_BYTES = 1024 * 1024
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000
const STREAM_CHUNK_BYTES = 64 * 1024

export const DEFAULT_BACKUP_RESOURCE_LIMITS = Object.freeze({
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
  /** Tests may lower, but never raise, the production hard bounds. */
  limits?: Partial<BackupResourceLimits>
}

export interface RecoveryOptions extends BackupReadOptions {
  documentsBackupDir?: string
  durableFs?: DurableFileOps
  /** Stable for one SettingsStore construction; a new process/startup must use a new value. */
  startupId?: string
}

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
  if (DATA_PATH_PATTERN.test(relativePath)) return MAX_DATA_BYTES
  throw new Error(`file path is not allowlisted: ${relativePath}`)
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
}

interface OpenRegularFile {
  fd: number
  absolute: string
  beforeReal: string
  opened: fs.Stats
  relativePath: string
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
  const noFollow = platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0)
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow)
  try {
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error(`backup path identity changed while opening: ${relativePath}`)
    }
    if (opened.size > maximumFor(normalized)) {
      throw new Error(`backup file exceeds its size bound: ${relativePath}`)
    }
    return { fd, absolute, beforeReal, opened, relativePath }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

function assertOpenFileUnchanged(source: OpenRegularFile): void {
  const after = fs.fstatSync(source.fd)
  if (!sameFileIdentity(source.opened, after)) {
    throw new Error(`backup file changed during read: ${source.relativePath}`)
  }
  const afterReal = fs.realpathSync.native(source.absolute)
  if (afterReal !== source.beforeReal) {
    throw new Error(`backup path changed during read: ${source.relativePath}`)
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
    const buffer = Buffer.alloc(source.opened.size)
    let offset = 0
    while (offset < buffer.byteLength) {
      const count = fs.readSync(source.fd, buffer, offset, buffer.byteLength - offset, offset)
      if (!Number.isInteger(count) || count <= 0) {
        throw new Error(`backup file changed during read: ${relativePath}`)
      }
      offset += count
    }
    assertOpenFileUnchanged(source)
    return buffer
  } finally {
    fs.closeSync(source.fd)
  }
}

function hashRegularFileOnce(
  root: string,
  relativePath: string,
  options: BackupReadOptions,
): DigestDescriptor {
  const source = openRegularFileOnce(root, relativePath, options)
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(Math.min(STREAM_CHUNK_BYTES, Math.max(1, source.opened.size)))
  try {
    let offset = 0
    while (offset < source.opened.size) {
      const requested = Math.min(chunk.byteLength, source.opened.size - offset)
      const count = fs.readSync(source.fd, chunk, 0, requested, offset)
      if (!Number.isInteger(count) || count <= 0) {
        throw new Error(`backup file changed during read: ${relativePath}`)
      }
      hash.update(chunk.subarray(0, count))
      offset += count
    }
    assertOpenFileUnchanged(source)
    return { size: source.opened.size, sha256: hash.digest('hex') }
  } finally {
    fs.closeSync(source.fd)
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
  let destinationFd: number | undefined
  let destinationCreated = false
  let completed = false
  try {
    destinationFd = fs.openSync(destination, 'wx', 0o600)
    destinationCreated = true
    let offset = 0
    while (offset < source.opened.size) {
      const requested = Math.min(chunk.byteLength, source.opened.size - offset)
      const count = fs.readSync(source.fd, chunk, 0, requested, offset)
      if (!Number.isInteger(count) || count <= 0) {
        throw new Error(`backup file changed during read: ${relativePath}`)
      }
      const bytes = chunk.subarray(0, count)
      hash.update(bytes)
      writeAllSync(destinationFd, bytes, fs as unknown as DurableFileOps)
      offset += count
    }
    fs.fsyncSync(destinationFd)
    assertOpenFileUnchanged(source)
    completed = true
    return { size: source.opened.size, sha256: hash.digest('hex') }
  } finally {
    if (destinationFd !== undefined) fs.closeSync(destinationFd)
    fs.closeSync(source.fd)
    if (destinationCreated && !completed) {
      try { fs.unlinkSync(destination) } catch { /* preserve the original failure */ }
    }
  }
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
  assertSnapshotDirectory(snapshotDir)
  const manifestPath = path.join(snapshotDir, BACKUP_MANIFEST_FILE)
  if (!fs.existsSync(manifestPath)) {
    const entries = fs.readdirSync(snapshotDir, { withFileTypes: true })
    if (entries.length !== 1
      || entries[0].name !== SETTINGS_FILE
      || !entries[0].isFile()
      || entries[0].isSymbolicLink()) {
      throw new Error('legacy backup must contain only settings.json')
    }
    const snapshotTimestamp = parseLegacySnapshotTimestamp(path.basename(snapshotDir), now)
    const settingsBytes = readRegularFileOnce(snapshotDir, SETTINGS_FILE, options)
    const settings = parseSettingsBytes(settingsBytes)
    if (!isLegacySettings(settings)) throw new Error('journal-aware backup is missing its manifest')
    return {
      snapshotId: path.basename(snapshotDir),
      snapshotTimestamp,
      snapshotPath: snapshotDir,
      settings,
      settingsBytes,
      journalBytes: Buffer.alloc(0),
      legacy: true,
    }
  }

  const manifestBytes = readRegularFileOnce(snapshotDir, BACKUP_MANIFEST_FILE, options)
  const manifest = parseManifest(manifestBytes, now, limits)
  const actualPaths = actualSnapshotPaths(snapshotDir, limits)
  if (actualPaths.length !== manifest.files.length
    || actualPaths.some((relativePath, index) => relativePath !== manifest.files[index].path)) {
    throw new Error('backup manifest does not enumerate the complete staged set')
  }

  let settingsBytes: Buffer | undefined
  let journalBytes: Buffer | undefined
  for (const entry of manifest.files) {
    if (DATA_PATH_PATTERN.test(entry.path)) {
      const actual = hashRegularFileOnce(snapshotDir, entry.path, options)
      if (!sameDescriptor(actual, entry)) {
        throw new Error(`backup checksum mismatch: ${entry.path}`)
      }
      continue
    }
    const bytes = readRegularFileOnce(snapshotDir, entry.path, options)
    if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
      throw new Error(`backup checksum mismatch: ${entry.path}`)
    }
    if (entry.path === SETTINGS_FILE) settingsBytes = bytes
    else if (entry.path === BABY_INFO_JOURNAL_FILE) journalBytes = bytes
  }
  return pairFromBuffers(
    path.basename(snapshotDir),
    manifest.snapshotTimestamp,
    snapshotDir,
    settingsBytes!,
    journalBytes!,
  )
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
    snapshotTimestamp: intent.version === 1 ? new Date(0).toISOString() : intent.snapshotTimestamp,
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

function removeIntentDurably(
  userDataPath: string,
  platform: NodeJS.Platform,
  ops: DurableFileOps,
): void {
  const intentPath = path.join(userDataPath, RESTORE_INTENT_FILE)
  if (ops.existsSync(intentPath)) ops.unlinkSync(intentPath)
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

function livePairMatches(
  userDataPath: string,
  transaction: RestoreTransactionFile,
  stagedPair: VerifiedBackupPair,
  options: BackupReadOptions,
): boolean {
  try {
    const pair = verifyPairDirectory(userDataPath, transaction, options)
    return pair.settingsBytes.equals(stagedPair.settingsBytes)
      && pair.journalBytes.equals(stagedPair.journalBytes)
  } catch {
    return false
  }
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

function windowsRestartError(message: string): SettingsRecoveryError {
  return new SettingsRecoveryError(message, [], false, true, true)
}

function resumeRestoreIntent(userDataPath: string, options: RecoveryOptions): boolean {
  const platform = options.platform ?? process.platform
  const ops = options.durableFs ?? DEFAULT_DURABLE_OPS
  const intentPath = path.join(userDataPath, RESTORE_INTENT_FILE)
  if (!fs.existsSync(intentPath)) return false
  const stagingPath = path.join(userDataPath, RESTORE_STAGING_DIR)
  if (!fs.existsSync(stagingPath)) {
    throw new SettingsRecoveryError(
      'Restore intent survived but its verified staging directory is missing.',
      [],
      false,
      false,
      true,
    )
  }
  let primaryWriteStarted = false
  let forensicConfirmed = platform !== 'win32'
  try {
    const parsedIntent = readTransactionFile(userDataPath, RESTORE_INTENT_FILE, { platform })
    const intentTransaction = normalizeTransaction(parsedIntent)
    let transaction = intentTransaction
    let pair = verifyPairDirectory(stagingPath, intentTransaction, { platform })

    const metadataPath = path.join(stagingPath, RESTORE_STAGE_METADATA_FILE)
    if (fs.existsSync(metadataPath)) {
      const stageMetadata = normalizeTransaction(
        readTransactionFile(stagingPath, RESTORE_STAGE_METADATA_FILE, { platform }),
      )
      if (!sameTransactionIdentity(stageMetadata, intentTransaction)) {
        throw new Error('restore intent and staging metadata differ')
      }
      transaction = stageMetadata
      pair = verifyPairDirectory(stagingPath, transaction, { platform })
    } else {
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
      writeDurably(intentPath, transactionBytes(transaction), platform, ops)
    }

    if (platform === 'win32' && transaction.phase !== 'primary-verified') {
      verifyForensicEvidence(userDataPath, transaction, { platform, now: options.now })
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
        writeDurably(intentPath, transactionBytes(transaction), platform, ops)
      }
      forensicConfirmed = transaction.windowsVerifiedStartups >= 2
      if (!forensicConfirmed) {
        throw windowsRestartError(
          'Windows recovery evidence is verified but requires another independent application restart before primary overwrite.',
        )
      }
      transaction = { ...transaction, phase: 'prepared' }
      writeDurably(metadataPath, transactionBytes(transaction), platform, ops)
      writeDurably(intentPath, transactionBytes(transaction), platform, ops)
    } else if (platform !== 'win32' && transaction.phase === 'awaiting-windows-confirmation') {
      transaction = { ...transaction, phase: 'prepared' }
      writeDurably(metadataPath, transactionBytes(transaction), platform, ops)
      writeDurably(intentPath, transactionBytes(transaction), platform, ops)
    }

    // Every retry rewrites both members from the same already-verified buffers.
    primaryWriteStarted = true
    writeDurably(path.join(userDataPath, SETTINGS_FILE), pair.settingsBytes, platform, ops)
    writeDurably(path.join(userDataPath, BABY_INFO_JOURNAL_FILE), pair.journalBytes, platform, ops)
    verifyPairDirectory(userDataPath, transaction, { platform })

    transaction = { ...transaction, phase: 'primary-verified', windowsVerifiedStartups: 0 }
    writeDurably(metadataPath, transactionBytes(transaction), platform, ops)
    writeDurably(intentPath, transactionBytes(transaction), platform, ops)
    removeIntentDurably(userDataPath, platform, ops)

    // POSIX can commit the directory-entry removal with parent fsync. Windows
    // retains completed staging until a later independent startup verifies the
    // primary pair and garbage-collects it.
    if (platform !== 'win32') removeStagingDurably(userDataPath, platform, ops)
    return true
  } catch (error) {
    if (error instanceof SettingsRecoveryError) throw error
    throw new SettingsRecoveryError(
      `Unable to resume the settings/journal restore transaction: ${error instanceof Error ? error.message : String(error)}`,
      [],
      forensicConfirmed,
      platform === 'win32' && !primaryWriteStarted,
      !primaryWriteStarted,
    )
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
  try {
    const parsed = normalizeTransaction(
      readTransactionFile(stagingPath, RESTORE_STAGE_METADATA_FILE, { platform }),
    )
    if (parsed.phase === 'allocated') {
      removeStagingDurably(userDataPath, platform, ops)
      return false
    }
    const pair = verifyPairDirectory(stagingPath, parsed, { platform })

    if (parsed.phase === 'primary-verified'
      && livePairMatches(userDataPath, parsed, pair, { platform })) {
      if (platform === 'win32') verifyForensicEvidence(userDataPath, parsed, { platform, now: options.now })
      removeStagingDurably(userDataPath, platform, ops)
      return true
    }

    const prepared: RestoreTransactionFile = {
      ...parsed,
      settings: descriptor(pair.settingsBytes),
      journal: descriptor(pair.journalBytes),
    }
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
    throw new SettingsRecoveryError(
      `Unable to recover orphan restore staging: ${error instanceof Error ? error.message : String(error)}`,
      [],
      false,
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

interface ForensicEvidence {
  archiveId: string
  manifest: DigestDescriptor
  /** True only when the archive directory entry was confirmed across the platform boundary. */
  preserved: boolean
}

function preserveOriginals(
  userDataPath: string,
  options: RecoveryOptions,
): ForensicEvidence {
  const platform = options.platform ?? process.platform
  const ops = options.durableFs ?? DEFAULT_DURABLE_OPS
  const now = options.now ?? new Date()
  const archivedAt = now.toISOString()
  const originals = new Map<string, Buffer>()
  for (const relativePath of [SETTINGS_FILE, BABY_INFO_JOURNAL_FILE]) {
    if (fs.existsSync(path.join(userDataPath, relativePath))) {
      originals.set(relativePath, readRegularFileOnce(userDataPath, relativePath, { platform }))
    }
  }
  if (originals.size === 0) {
    throw new Error('no regular primary files were available for forensic preservation')
  }

  const forensicsRoot = path.join(userDataPath, RECOVERY_FORENSICS_DIR)
  if (!ops.existsSync(forensicsRoot)) {
    ops.mkdirSync(forensicsRoot, { recursive: true })
    syncDirectory(userDataPath, platform, ops)
  }
  const forensicsStat = fs.lstatSync(forensicsRoot)
  if (forensicsStat.isSymbolicLink() || !forensicsStat.isDirectory()) {
    throw new Error('forensic preservation root is not a regular directory')
  }
  const evidenceDigest = sha256(Buffer.concat(Array.from(originals.entries()).flatMap(
    ([name, bytes]) => [Buffer.from(name, 'utf8'), bytes],
  ))).slice(0, 16)
  const baseId = `${archivedAt.replace(/[:.]/g, '-')}-${evidenceDigest}`
  let archiveId = baseId
  let suffix = 0
  while (ops.existsSync(path.join(forensicsRoot, archiveId))) {
    suffix += 1
    archiveId = `${baseId}-${suffix}`
  }
  const archiveDir = path.join(forensicsRoot, archiveId)
  ops.mkdirSync(archiveDir, { recursive: true })
  syncDirectory(forensicsRoot, platform, ops)

  const entries: BackupManifestEntry[] = []
  for (const [relativePath, bytes] of Array.from(originals.entries())) {
    writeDurably(path.join(archiveDir, relativePath), bytes, platform, ops)
    entries.push({ path: relativePath, ...descriptor(bytes) })
  }
  const manifest: ForensicManifest = {
    version: 1,
    source: 'baby-diary-recovery',
    archivedAt,
    files: entries,
  }
  const forensicManifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
  writeDurably(
    path.join(archiveDir, BACKUP_MANIFEST_FILE),
    forensicManifestBytes,
    platform,
    ops,
  )
  syncDirectory(archiveDir, platform, ops)

  // Confirm the durable archive from one-handle reads before any primary write.
  for (const entry of entries) {
    assertDescriptor(readRegularFileOnce(archiveDir, entry.path, { platform }), entry, `forensic ${entry.path}`)
  }
  const manifestBytes = readRegularFileOnce(archiveDir, BACKUP_MANIFEST_FILE, { platform })
  if (!manifestBytes.equals(forensicManifestBytes)) {
    throw new Error('forensic preservation manifest bytes changed before confirmation')
  }
  const verifiedManifest = JSON.parse(manifestBytes.toString('utf8')) as ForensicManifest
  if (verifiedManifest.source !== 'baby-diary-recovery'
    || verifiedManifest.files.length !== entries.length) {
    throw new Error('forensic preservation manifest verification failed')
  }
  return {
    archiveId,
    manifest: descriptor(forensicManifestBytes),
    preserved: platform !== 'win32',
  }
}

function verifyForensicEvidence(
  userDataPath: string,
  transaction: RestoreTransactionFile,
  options: BackupReadOptions,
): void {
  if (!transaction.forensicArchiveId
    || transaction.forensicArchiveId.length > 255
    || transaction.forensicArchiveId === '.'
    || transaction.forensicArchiveId === '..'
    || /[\\/\u0000-\u001f\u007f]/.test(transaction.forensicArchiveId)) {
    throw new Error('forensic preservation identity is missing or invalid')
  }
  const forensicRoot = path.join(userDataPath, RECOVERY_FORENSICS_DIR)
  const rootStat = fs.lstatSync(forensicRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('forensic preservation root is not a regular directory')
  }
  const archiveDir = path.join(forensicRoot, transaction.forensicArchiveId)
  const archiveStat = fs.lstatSync(archiveDir)
  if (archiveStat.isSymbolicLink() || !archiveStat.isDirectory()) {
    throw new Error('forensic preservation archive is not a regular directory')
  }

  const manifestBytes = readRegularFileOnce(archiveDir, BACKUP_MANIFEST_FILE, options)
  if (transaction.forensicManifest) {
    assertDescriptor(manifestBytes, transaction.forensicManifest, 'forensic manifest')
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
    assertDescriptor(
      readRegularFileOnce(archiveDir, entry.path, options),
      { size: entry.size as number, sha256: entry.sha256 as string },
      `forensic ${entry.path}`,
    )
  }
  const actualNames = fs.readdirSync(archiveDir).sort()
  const manifestNames = [BACKUP_MANIFEST_FILE, ...Array.from(seen)].sort()
  if (actualNames.length !== manifestNames.length
    || actualNames.some((name, index) => name !== manifestNames[index])) {
    throw new Error('forensic preservation archive contains an unexpected entry')
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
    lastWindowsStartupId: options.startupId ?? '',
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

  const selected = newestVerifiedBackup(userDataPath, options)
  if (!selected.pair) {
    throw new SettingsRecoveryError(
      'Settings and baby-info history are damaged, and no fully verified backup pair is available.',
      selected.rejected,
      forensic.preserved,
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
    resumeRestoreIntent(userDataPath, options)
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
      forensic.preserved,
      false,
      true,
    )
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
