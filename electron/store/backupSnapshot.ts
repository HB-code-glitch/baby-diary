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

interface RestoreTransactionFile {
  version: 2
  snapshotId: string
  snapshotTimestamp: string
  settings: DigestDescriptor
  journal: DigestDescriptor
  phase: 'prepared' | 'primary-verified'
  windowsVerifiedStartups: number
  forensicArchiveId: string
}

type ParsedRestoreIntent = LegacyRestoreIntentFile | RestoreTransactionFile

export interface BackupReadOptions {
  platform?: NodeJS.Platform
  now?: Date
}

export interface RecoveryOptions extends BackupReadOptions {
  documentsBackupDir?: string
  durableFs?: DurableFileOps
}

const DEFAULT_DURABLE_OPS = fs as unknown as DurableFileOps

export class SettingsRecoveryError extends Error {
  readonly code = 'SETTINGS_RECOVERY_REQUIRED' as const
  readonly recoverable = true as const

  constructor(
    message: string,
    readonly rejectedSnapshots: string[] = [],
    readonly originalsPreserved = false,
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

function parseManifest(raw: Buffer, now: Date): BackupManifest {
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

  const files: BackupManifestEntry[] = []
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

/**
 * Opens one allowlisted regular file without following links where supported,
 * validates path/handle identity, and returns the only Buffer used downstream.
 */
function readRegularFileOnce(
  root: string,
  relativePath: string,
  options: BackupReadOptions = {},
): Buffer {
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
    const buffer = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < buffer.byteLength) {
      const count = fs.readSync(fd, buffer, offset, buffer.byteLength - offset, offset)
      if (!Number.isInteger(count) || count <= 0) {
        throw new Error(`backup file changed during read: ${relativePath}`)
      }
      offset += count
    }
    const after = fs.fstatSync(fd)
    if (!sameFileIdentity(opened, after)) {
      throw new Error(`backup file changed during read: ${relativePath}`)
    }
    const afterReal = fs.realpathSync.native(absolute)
    if (afterReal !== beforeReal) throw new Error(`backup path changed during read: ${relativePath}`)
    return buffer
  } finally {
    fs.closeSync(fd)
  }
}

function assertSnapshotDirectory(snapshotDir: string): void {
  const stat = fs.lstatSync(snapshotDir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('backup snapshot root is not a regular directory')
  }
}

function actualSnapshotPaths(snapshotDir: string): string[] {
  assertSnapshotDirectory(snapshotDir)
  const top = fs.readdirSync(snapshotDir, { withFileTypes: true })
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
    for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
      const relativePath = `data/${entry.name}`
      if (!entry.isFile() || entry.isSymbolicLink() || !DATA_PATH_PATTERN.test(relativePath)) {
        throw new Error(`backup data path is invalid: ${relativePath}`)
      }
      result.push(relativePath)
    }
    result.splice(2, result.length - 2, ...result.slice(2).sort())
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
  const manifest = parseManifest(manifestBytes, now)
  const actualPaths = actualSnapshotPaths(snapshotDir)
  if (actualPaths.length !== manifest.files.length
    || actualPaths.some((relativePath, index) => relativePath !== manifest.files[index].path)) {
    throw new Error('backup manifest does not enumerate the complete staged set')
  }

  const verifiedBuffers = new Map<string, Buffer>()
  for (const entry of manifest.files) {
    const bytes = readRegularFileOnce(snapshotDir, entry.path, options)
    if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
      throw new Error(`backup checksum mismatch: ${entry.path}`)
    }
    verifiedBuffers.set(entry.path, bytes)
  }
  return pairFromBuffers(
    path.basename(snapshotDir),
    manifest.snapshotTimestamp,
    snapshotDir,
    verifiedBuffers.get(SETTINGS_FILE)!,
    verifiedBuffers.get(BABY_INFO_JOURNAL_FILE)!,
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
): void {
  const now = new Date()
  strictTimestamp(timestamp, now)
  const buffers = new Map<string, Buffer>()
  buffers.set(SETTINGS_FILE, readRegularFileOnce(userDataPath, SETTINGS_FILE, { platform }))

  const journalPath = path.join(userDataPath, BABY_INFO_JOURNAL_FILE)
  if (fs.existsSync(journalPath)) {
    buffers.set(BABY_INFO_JOURNAL_FILE, readRegularFileOnce(userDataPath, BABY_INFO_JOURNAL_FILE, { platform }))
  } else {
    buffers.set(BABY_INFO_JOURNAL_FILE, Buffer.alloc(0))
  }

  const dataSource = path.join(userDataPath, 'data')
  if (fs.existsSync(dataSource)) {
    const dataStat = fs.lstatSync(dataSource)
    if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) {
      throw new Error('event data source is not a regular directory')
    }
    for (const entry of fs.readdirSync(dataSource, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.name.endsWith('.jsonl')) continue
      const relativePath = `data/${entry.name}`
      if (!entry.isFile() || entry.isSymbolicLink() || !DATA_PATH_PATTERN.test(relativePath)) {
        throw new Error(`event data source path is invalid: ${entry.name}`)
      }
      buffers.set(relativePath, readRegularFileOnce(userDataPath, relativePath, { platform }))
    }
  }

  writeDurably(path.join(stagingPath, SETTINGS_FILE), buffers.get(SETTINGS_FILE)!, platform)
  writeDurably(path.join(stagingPath, BABY_INFO_JOURNAL_FILE), buffers.get(BABY_INFO_JOURNAL_FILE)!, platform)
  const dataPaths = Array.from(buffers.keys()).filter(key => key.startsWith('data/')).sort()
  if (dataPaths.length > 0) {
    const dataDestination = path.join(stagingPath, 'data')
    fs.mkdirSync(dataDestination)
    for (const relativePath of dataPaths) {
      writeDurably(
        path.join(stagingPath, ...relativePath.split('/')),
        buffers.get(relativePath)!,
        platform,
      )
    }
    syncDirectory(dataDestination, platform)
  }

  const relativePaths = [SETTINGS_FILE, BABY_INFO_JOURNAL_FILE, ...dataPaths]
  const manifest: BackupManifest = {
    version: 1,
    source: 'baby-diary',
    snapshotTimestamp: timestamp,
    files: relativePaths.map(relativePath => ({
      path: relativePath,
      ...descriptor(buffers.get(relativePath)!),
    })),
  }
  writeDurably(
    path.join(stagingPath, BACKUP_MANIFEST_FILE),
    Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    platform,
  )
  syncDirectory(stagingPath, platform)
  verifyBackupSnapshot(stagingPath, { platform, now })
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
  if (value.version !== 2
    || !exactKeys(value, [
      'version', 'snapshotId', 'snapshotTimestamp', 'settings', 'journal',
      'phase', 'windowsVerifiedStartups', 'forensicArchiveId',
    ])
    || typeof value.snapshotTimestamp !== 'string'
    || (value.phase !== 'prepared' && value.phase !== 'primary-verified')
    || !Number.isInteger(value.windowsVerifiedStartups)
    || (value.windowsVerifiedStartups as number) < 0
    || (value.windowsVerifiedStartups as number) > 2
    || typeof value.forensicArchiveId !== 'string') {
    throw new Error('restore intent shape is invalid')
  }
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

function assertDescriptor(bytes: Buffer, expected: DigestDescriptor, label: string): void {
  if (bytes.byteLength !== expected.size || sha256(bytes) !== expected.sha256) {
    throw new Error(`${label} checksum mismatch`)
  }
}

function transactionFromLegacy(intent: LegacyRestoreIntentFile): RestoreTransactionFile {
  return {
    version: 2,
    snapshotId: intent.snapshotId,
    snapshotTimestamp: new Date(0).toISOString(),
    settings: intent.settings,
    journal: intent.journal,
    phase: 'prepared',
    windowsVerifiedStartups: 0,
    forensicArchiveId: '',
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
    )
  }
  try {
    const parsedIntent = readTransactionFile(userDataPath, RESTORE_INTENT_FILE, { platform })
    let transaction = parsedIntent.version === 1 ? transactionFromLegacy(parsedIntent) : parsedIntent
    const pair = verifyPairDirectory(stagingPath, transaction, { platform })

    const metadataPath = path.join(stagingPath, RESTORE_STAGE_METADATA_FILE)
    if (fs.existsSync(metadataPath)) {
      const stageMetadata = readTransactionFile(stagingPath, RESTORE_STAGE_METADATA_FILE, { platform })
      if (stageMetadata.version !== 2
        || stageMetadata.snapshotId !== transaction.snapshotId
        || stageMetadata.settings.sha256 !== transaction.settings.sha256
        || stageMetadata.journal.sha256 !== transaction.journal.sha256) {
        throw new Error('restore intent and staging metadata differ')
      }
      transaction = stageMetadata
    } else {
      writeDurably(metadataPath, transactionBytes(transaction), platform, ops)
    }

    // Every retry rewrites both members from the same already-verified buffers.
    writeDurably(path.join(userDataPath, SETTINGS_FILE), pair.settingsBytes, platform, ops)
    writeDurably(path.join(userDataPath, BABY_INFO_JOURNAL_FILE), pair.journalBytes, platform, ops)
    verifyPairDirectory(userDataPath, transaction, { platform })

    transaction = { ...transaction, phase: 'primary-verified', windowsVerifiedStartups: 0 }
    writeDurably(metadataPath, transactionBytes(transaction), platform, ops)
    writeDurably(intentPath, transactionBytes(transaction), platform, ops)
    removeIntentDurably(userDataPath, platform, ops)

    // POSIX can commit the directory-entry removal with parent fsync. Windows
    // keeps the verified recovery copy for two later verified startups.
    if (platform !== 'win32') removeStagingDurably(userDataPath, platform, ops)
    return true
  } catch (error) {
    if (error instanceof SettingsRecoveryError) throw error
    throw new SettingsRecoveryError(
      `Unable to resume the settings/journal restore transaction: ${error instanceof Error ? error.message : String(error)}`,
      [],
      false,
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
    throw new SettingsRecoveryError(
      'Restore staging survived without either an intent or transaction metadata.',
      [],
      false,
    )
  }
  try {
    const parsed = readTransactionFile(stagingPath, RESTORE_STAGE_METADATA_FILE, { platform })
    if (parsed.version !== 2) throw new Error('orphan staging metadata is obsolete')
    const pair = verifyPairDirectory(stagingPath, parsed, { platform })

    if (parsed.phase === 'primary-verified'
      && livePairMatches(userDataPath, parsed, pair, { platform })) {
      if (platform === 'win32' && parsed.windowsVerifiedStartups < 1) {
        writeDurably(
          metadataPath,
          transactionBytes({ ...parsed, windowsVerifiedStartups: parsed.windowsVerifiedStartups + 1 }),
          platform,
          ops,
        )
      } else {
        removeStagingDurably(userDataPath, platform, ops)
      }
      return true
    }

    const prepared: RestoreTransactionFile = {
      ...parsed,
      phase: 'prepared',
      windowsVerifiedStartups: 0,
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

function preserveOriginals(
  userDataPath: string,
  options: RecoveryOptions,
): { archiveId: string; preserved: true } {
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
  return { archiveId, preserved: true }
}

function listSnapshotCandidates(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const rootStat = fs.lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return []
  return fs.readdirSync(root, { withFileTypes: true })
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
  const verified: Array<{ pair: VerifiedBackupPair; destinationRank: number }> = []
  roots.forEach((root, destinationRank) => {
    for (const candidate of listSnapshotCandidates(root)) {
      try {
        verified.push({
          pair: verifyBackupSnapshot(candidate, options),
          destinationRank,
        })
      } catch {
        rejected.push(candidate)
      }
    }
  })
  verified.sort((left, right) => {
    const byTimestamp = Date.parse(right.pair.snapshotTimestamp) - Date.parse(left.pair.snapshotTimestamp)
    if (byTimestamp !== 0) return byTimestamp
    if (left.destinationRank !== right.destinationRank) return left.destinationRank - right.destinationRank
    return path.resolve(left.pair.snapshotPath).localeCompare(path.resolve(right.pair.snapshotPath))
  })
  return { pair: verified[0]?.pair, rejected }
}

function prepareRestoreIntent(
  userDataPath: string,
  pair: VerifiedBackupPair,
  forensicArchiveId: string,
  options: RecoveryOptions,
): void {
  const platform = options.platform ?? process.platform
  const ops = options.durableFs ?? DEFAULT_DURABLE_OPS
  const stagingPath = path.join(userDataPath, RESTORE_STAGING_DIR)
  if (fs.existsSync(stagingPath)) {
    throw new Error('restore staging already exists and was not garbage-collected')
  }
  fs.mkdirSync(stagingPath)
  syncDirectory(userDataPath, platform, ops)
  writeDurably(path.join(stagingPath, SETTINGS_FILE), pair.settingsBytes, platform, ops)
  writeDurably(path.join(stagingPath, BABY_INFO_JOURNAL_FILE), pair.journalBytes, platform, ops)
  verifyPairDirectory(stagingPath, undefined, { platform })

  const transaction: RestoreTransactionFile = {
    version: 2,
    snapshotId: pair.snapshotId,
    snapshotTimestamp: pair.snapshotTimestamp,
    settings: descriptor(pair.settingsBytes),
    journal: descriptor(pair.journalBytes),
    phase: 'prepared',
    windowsVerifiedStartups: 0,
    forensicArchiveId,
  }
  writeDurably(
    path.join(stagingPath, RESTORE_STAGE_METADATA_FILE),
    transactionBytes(transaction),
    platform,
    ops,
  )
  syncDirectory(stagingPath, platform, ops)
  writeDurably(
    path.join(userDataPath, RESTORE_INTENT_FILE),
    transactionBytes(transaction),
    platform,
    ops,
  )
}

/** Runs before SettingsStore exposes either member of the persisted pair. */
export function recoverSettingsAndJournalPair(
  userDataPath: string,
  options: RecoveryOptions = {},
): void {
  if (resumeRestoreIntent(userDataPath, options)) return
  if (handleOrphanStaging(userDataPath, options)) return
  if (livePairIsReadable(userDataPath, options)) return

  let forensicArchiveId = ''
  try {
    forensicArchiveId = preserveOriginals(userDataPath, options).archiveId
  } catch (error) {
    throw new SettingsRecoveryError(
      `Recovery stopped before overwrite because forensic preservation failed: ${error instanceof Error ? error.message : String(error)}`,
      [],
      false,
    )
  }

  const selected = newestVerifiedBackup(userDataPath, options)
  if (!selected.pair) {
    throw new SettingsRecoveryError(
      'Settings and baby-info history are damaged, and no fully verified backup pair is available.',
      selected.rejected,
      true,
    )
  }
  try {
    prepareRestoreIntent(userDataPath, selected.pair, forensicArchiveId, options)
    resumeRestoreIntent(userDataPath, options)
  } catch (error) {
    if (error instanceof SettingsRecoveryError) {
      throw new SettingsRecoveryError(error.message, selected.rejected, true)
    }
    throw new SettingsRecoveryError(
      `Unable to restore the verified settings/journal pair: ${error instanceof Error ? error.message : String(error)}`,
      selected.rejected,
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
  const verified: VerifiedBackupPair[] = []
  for (const candidate of listSnapshotCandidates(root)) {
    try {
      verified.push(verifyBackupSnapshot(candidate, { now }))
    } catch {
      // Invalid folders are never silently deleted by retention.
    }
  }
  const cutoff = now.getTime() - 90 * 24 * 60 * 60 * 1000
  const monthly = new Map<string, VerifiedBackupPair[]>()
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
    items.sort((left: VerifiedBackupPair, right: VerifiedBackupPair) => Date.parse(right.snapshotTimestamp) - Date.parse(left.snapshotTimestamp)
      || path.resolve(left.snapshotPath).localeCompare(path.resolve(right.snapshotPath)))
    result.push(...items.slice(1).map((pair: VerifiedBackupPair) => path.basename(pair.snapshotPath)))
  }
  return result.sort()
}
