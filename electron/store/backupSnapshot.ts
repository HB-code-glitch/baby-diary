import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { AppSettings } from '../../shared/types'
import { parseAppSettingsWithLegacyDefaults } from '../../shared/babyInfoSettingsCommit'
import { getBabyInfoMutationKey } from '../../shared/babyInfoResolver'
import { BABY_INFO_JOURNAL_FILE, BabyInfoJournal } from './babyInfoJournal'
import { atomicReplaceFileSync } from './durableFs'

export const BACKUP_MANIFEST_FILE = 'manifest.json'
export const RESTORE_INTENT_FILE = '.baby-info-pair-restore-v1.json'
export const RESTORE_STAGING_DIR = '.baby-info-pair-restore-v1'

const SETTINGS_FILE = 'settings.json'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SNAPSHOT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const DATA_PATH_PATTERN = /^data\/[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/

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
  settings: AppSettings
  settingsBytes: Buffer
  journalBytes: Buffer
  legacy: boolean
}

interface RestoreIntentFile {
  version: 1
  snapshotId: string
  settings: { size: number; sha256: string }
  journal: { size: number; sha256: string }
}

export class SettingsRecoveryError extends Error {
  readonly code = 'SETTINGS_RECOVERY_REQUIRED' as const
  readonly recoverable = true as const

  constructor(message: string, readonly rejectedSnapshots: string[] = []) {
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
  const expectedName = summary.winner?.babyName ?? ''
  const expectedBirthdate = summary.winner?.babyBirthdate ?? ''
  if (settings.baby.name !== expectedName || settings.baby.birthdate !== expectedBirthdate) {
    throw new Error('visible baby pair does not match projected journal winner')
  }
}

function parseManifest(raw: Buffer): BackupManifest {
  let value: unknown
  try { value = JSON.parse(raw.toString('utf8')) } catch { throw new Error('backup manifest JSON is invalid') }
  if (!isRecord(value)
    || !exactKeys(value, ['version', 'source', 'snapshotTimestamp', 'files'])
    || value.version !== 1
    || value.source !== 'baby-diary'
    || typeof value.snapshotTimestamp !== 'string'
    || !SNAPSHOT_TIMESTAMP_PATTERN.test(value.snapshotTimestamp)
    || !Number.isFinite(Date.parse(value.snapshotTimestamp))
    || !Array.isArray(value.files)) {
    throw new Error('backup manifest shape is invalid')
  }

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
  const expectedPrefix = [SETTINGS_FILE, BABY_INFO_JOURNAL_FILE]
  if (files.length < expectedPrefix.length
    || files[0].path !== expectedPrefix[0]
    || files[1].path !== expectedPrefix[1]) {
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

function actualSnapshotPaths(snapshotDir: string): string[] {
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
    const dataEntries = fs.readdirSync(dataDir, { withFileTypes: true })
    for (const entry of dataEntries) {
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

function verifyPairDirectory(directory: string): VerifiedBackupPair {
  const settingsPath = path.join(directory, SETTINGS_FILE)
  const journalPath = path.join(directory, BABY_INFO_JOURNAL_FILE)
  if (!fs.existsSync(settingsPath) || !fs.statSync(settingsPath).isFile()
    || !fs.existsSync(journalPath) || !fs.statSync(journalPath).isFile()) {
    throw new Error('settings/journal pair is incomplete')
  }
  const settingsBytes = fs.readFileSync(settingsPath)
  const journalBytes = fs.readFileSync(journalPath)
  const settings = parseSettingsBytes(settingsBytes)
  const journal = new BabyInfoJournal(directory, { strict: true })
  validateProjection(settings, journal)
  return {
    snapshotId: path.basename(directory),
    settings,
    settingsBytes,
    journalBytes,
    legacy: isLegacySettings(settings),
  }
}

export function verifyBackupSnapshot(snapshotDir: string): VerifiedBackupPair {
  const manifestPath = path.join(snapshotDir, BACKUP_MANIFEST_FILE)
  if (!fs.existsSync(manifestPath)) {
    const settingsPath = path.join(snapshotDir, SETTINGS_FILE)
    if (!fs.existsSync(settingsPath) || fs.existsSync(path.join(snapshotDir, BABY_INFO_JOURNAL_FILE))) {
      throw new Error('legacy backup pair is incomplete')
    }
    const settingsBytes = fs.readFileSync(settingsPath)
    const settings = parseSettingsBytes(settingsBytes)
    if (!isLegacySettings(settings)) throw new Error('journal-aware backup is missing its manifest')
    return {
      snapshotId: path.basename(snapshotDir),
      settings,
      settingsBytes,
      journalBytes: Buffer.alloc(0),
      legacy: true,
    }
  }

  const manifest = parseManifest(fs.readFileSync(manifestPath))
  const actualPaths = actualSnapshotPaths(snapshotDir)
  if (actualPaths.length !== manifest.files.length
    || actualPaths.some((relativePath, index) => relativePath !== manifest.files[index].path)) {
    throw new Error('backup manifest does not enumerate the complete staged set')
  }
  for (const entry of manifest.files) {
    const absolute = path.join(snapshotDir, ...entry.path.split('/'))
    const bytes = fs.readFileSync(absolute)
    if (bytes.byteLength !== entry.size || sha256(bytes) !== entry.sha256) {
      throw new Error(`backup checksum mismatch: ${entry.path}`)
    }
  }
  return verifyPairDirectory(snapshotDir)
}

function copyFileDurably(source: string, destination: string): void {
  fs.copyFileSync(source, destination)
  const fd = fs.openSync(destination, 'r+')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function writeEmptyFileDurably(destination: string): void {
  const fd = fs.openSync(destination, 'wx', 0o600)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function syncDirectory(directory: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') return
  const fd = fs.openSync(directory, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

function makeManifest(snapshotDir: string, timestamp: string): BackupManifest {
  const files = actualSnapshotPaths(snapshotDir).map(relativePath => {
    const bytes = fs.readFileSync(path.join(snapshotDir, ...relativePath.split('/')))
    return { path: relativePath, size: bytes.byteLength, sha256: sha256(bytes) }
  })
  return { version: 1, source: 'baby-diary', snapshotTimestamp: timestamp, files }
}

/** Stages and verifies one complete snapshot. Caller performs the atomic directory rename. */
export function stageVerifiedBackupSnapshot(
  userDataPath: string,
  stagingPath: string,
  timestamp: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const settingsSource = path.join(userDataPath, SETTINGS_FILE)
  if (!fs.existsSync(settingsSource) || !fs.statSync(settingsSource).isFile()) {
    throw new Error('settings.json is required for backup')
  }
  copyFileDurably(settingsSource, path.join(stagingPath, SETTINGS_FILE))

  const journalSource = path.join(userDataPath, BABY_INFO_JOURNAL_FILE)
  const journalDestination = path.join(stagingPath, BABY_INFO_JOURNAL_FILE)
  if (fs.existsSync(journalSource) && fs.statSync(journalSource).isFile()) {
    copyFileDurably(journalSource, journalDestination)
  } else if (fs.existsSync(journalSource)) {
    throw new Error('baby info journal source is not a file')
  } else {
    writeEmptyFileDurably(journalDestination)
  }

  const dataSource = path.join(userDataPath, 'data')
  if (fs.existsSync(dataSource)) {
    if (!fs.statSync(dataSource).isDirectory()) throw new Error('event data source is not a directory')
    const names = fs.readdirSync(dataSource, { withFileTypes: true })
      .filter(entry => entry.name.endsWith('.jsonl'))
      .sort((left, right) => left.name.localeCompare(right.name))
    if (names.length > 0) {
      const dataDestination = path.join(stagingPath, 'data')
      fs.mkdirSync(dataDestination)
      for (const entry of names) {
        if (!entry.isFile() || entry.isSymbolicLink()
          || !DATA_PATH_PATTERN.test(`data/${entry.name}`)) {
          throw new Error(`event data source path is invalid: ${entry.name}`)
        }
        copyFileDurably(path.join(dataSource, entry.name), path.join(dataDestination, entry.name))
      }
      syncDirectory(dataDestination, platform)
    }
  }

  const manifest = makeManifest(stagingPath, timestamp)
  atomicReplaceFileSync(
    path.join(stagingPath, BACKUP_MANIFEST_FILE),
    Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    { platform },
  )
  syncDirectory(stagingPath, platform)
  verifyBackupSnapshot(stagingPath)
}

function validDigestDescriptor(value: unknown): value is { size: number; sha256: string } {
  return isRecord(value)
    && exactKeys(value, ['size', 'sha256'])
    && Number.isSafeInteger(value.size)
    && (value.size as number) >= 0
    && typeof value.sha256 === 'string'
    && SHA256_PATTERN.test(value.sha256)
}

function parseRestoreIntent(bytes: Buffer): RestoreIntentFile {
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('restore intent JSON is invalid') }
  if (!isRecord(value)
    || !exactKeys(value, ['version', 'snapshotId', 'settings', 'journal'])
    || value.version !== 1
    || typeof value.snapshotId !== 'string'
    || value.snapshotId.length < 1
    || value.snapshotId.length > 255
    || /[\u0000-\u001f\u007f]/.test(value.snapshotId)
    || !validDigestDescriptor(value.settings)
    || !validDigestDescriptor(value.journal)) {
    throw new Error('restore intent shape is invalid')
  }
  return {
    version: 1,
    snapshotId: value.snapshotId,
    settings: value.settings,
    journal: value.journal,
  }
}

function assertDescriptor(bytes: Buffer, descriptor: { size: number; sha256: string }, label: string): void {
  if (bytes.byteLength !== descriptor.size || sha256(bytes) !== descriptor.sha256) {
    throw new Error(`restore staging ${label} checksum mismatch`)
  }
}

function cleanupRestoreTransaction(userDataPath: string): void {
  const intentPath = path.join(userDataPath, RESTORE_INTENT_FILE)
  const stagingPath = path.join(userDataPath, RESTORE_STAGING_DIR)
  if (fs.existsSync(intentPath)) fs.unlinkSync(intentPath)
  if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { recursive: true, force: true })
  syncDirectory(userDataPath, process.platform)
}

function resumeRestoreIntent(userDataPath: string): boolean {
  const intentPath = path.join(userDataPath, RESTORE_INTENT_FILE)
  if (!fs.existsSync(intentPath)) return false
  try {
    const intent = parseRestoreIntent(fs.readFileSync(intentPath))
    const stagingPath = path.join(userDataPath, RESTORE_STAGING_DIR)
    const pair = verifyPairDirectory(stagingPath)
    assertDescriptor(pair.settingsBytes, intent.settings, SETTINGS_FILE)
    assertDescriptor(pair.journalBytes, intent.journal, BABY_INFO_JOURNAL_FILE)

    // Idempotent on every retry. An app never observes the temporary mixed
    // boundary because startup cannot continue while the intent exists.
    atomicReplaceFileSync(path.join(userDataPath, SETTINGS_FILE), pair.settingsBytes)
    atomicReplaceFileSync(path.join(userDataPath, BABY_INFO_JOURNAL_FILE), pair.journalBytes)
    const liveSettings = fs.readFileSync(path.join(userDataPath, SETTINGS_FILE))
    const liveJournal = fs.readFileSync(path.join(userDataPath, BABY_INFO_JOURNAL_FILE))
    assertDescriptor(liveSettings, intent.settings, `live ${SETTINGS_FILE}`)
    assertDescriptor(liveJournal, intent.journal, `live ${BABY_INFO_JOURNAL_FILE}`)
    verifyPairDirectory(userDataPath)
    cleanupRestoreTransaction(userDataPath)
    return true
  } catch (error) {
    throw new SettingsRecoveryError(
      `Unable to resume the settings/journal restore transaction: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function livePairIsReadable(userDataPath: string): boolean {
  const settingsPath = path.join(userDataPath, SETTINGS_FILE)
  const journalPath = path.join(userDataPath, BABY_INFO_JOURNAL_FILE)
  if (!fs.existsSync(settingsPath) && !fs.existsSync(journalPath)) return true
  if (!fs.existsSync(settingsPath) || !fs.statSync(settingsPath).isFile()) return false
  let settings: AppSettings
  try { settings = parseSettingsBytes(fs.readFileSync(settingsPath)) } catch { return false }
  if (!fs.existsSync(journalPath)) return isLegacySettings(settings)
  if (!fs.statSync(journalPath).isFile()) return false
  try {
    // Live journals retain their established torn-tail recovery behavior. A
    // complete-record mismatch is repaired later from the journal winner.
    new BabyInfoJournal(userDataPath)
    return true
  } catch {
    return false
  }
}

function preserveOriginal(pathname: string, suffix: string): void {
  if (!fs.existsSync(pathname) || !fs.statSync(pathname).isFile()) return
  try { copyFileDurably(pathname, `${pathname}.corrupt-${suffix}.bak`) } catch {
    // Recovery remains fail-closed even if a secondary forensic copy fails.
  }
}

function newestVerifiedBackup(userDataPath: string): { pair?: VerifiedBackupPair; rejected: string[] } {
  const root = path.join(userDataPath, 'backups')
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { rejected: [] }
  const rejected: string[] = []
  const names = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.includes('.tmp-'))
    .map(entry => entry.name)
    .sort()
    .reverse()
  for (const name of names) {
    try { return { pair: verifyBackupSnapshot(path.join(root, name)), rejected } } catch {
      rejected.push(name)
    }
  }
  return { rejected }
}

function prepareRestoreIntent(userDataPath: string, pair: VerifiedBackupPair): void {
  const stagingPath = path.join(userDataPath, RESTORE_STAGING_DIR)
  if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { recursive: true, force: true })
  fs.mkdirSync(stagingPath)
  atomicReplaceFileSync(path.join(stagingPath, SETTINGS_FILE), pair.settingsBytes)
  atomicReplaceFileSync(path.join(stagingPath, BABY_INFO_JOURNAL_FILE), pair.journalBytes)
  verifyPairDirectory(stagingPath)
  const intent: RestoreIntentFile = {
    version: 1,
    snapshotId: pair.snapshotId,
    settings: { size: pair.settingsBytes.byteLength, sha256: sha256(pair.settingsBytes) },
    journal: { size: pair.journalBytes.byteLength, sha256: sha256(pair.journalBytes) },
  }
  atomicReplaceFileSync(
    path.join(userDataPath, RESTORE_INTENT_FILE),
    Buffer.from(JSON.stringify(intent, null, 2), 'utf8'),
  )
}

/** Runs before SettingsStore exposes either member of the persisted pair. */
export function recoverSettingsAndJournalPair(userDataPath: string): void {
  if (resumeRestoreIntent(userDataPath)) return
  const staleStaging = path.join(userDataPath, RESTORE_STAGING_DIR)
  if (fs.existsSync(staleStaging)) fs.rmSync(staleStaging, { recursive: true, force: true })
  if (livePairIsReadable(userDataPath)) return

  const suffix = new Date().toISOString().replace(/[:.]/g, '-')
  preserveOriginal(path.join(userDataPath, SETTINGS_FILE), suffix)
  preserveOriginal(path.join(userDataPath, BABY_INFO_JOURNAL_FILE), suffix)

  const selected = newestVerifiedBackup(userDataPath)
  if (!selected.pair) {
    throw new SettingsRecoveryError(
      'Settings and baby-info history are damaged, and no fully verified backup pair is available.',
      selected.rejected,
    )
  }
  try {
    prepareRestoreIntent(userDataPath, selected.pair)
    resumeRestoreIntent(userDataPath)
  } catch (error) {
    if (error instanceof SettingsRecoveryError) throw error
    throw new SettingsRecoveryError(
      `Unable to restore the verified settings/journal pair: ${error instanceof Error ? error.message : String(error)}`,
      selected.rejected,
    )
  }
}
