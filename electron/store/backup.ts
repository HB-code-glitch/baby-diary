import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import {
  selectVerifiedBackupsToPrune,
  stageVerifiedBackupSnapshot,
} from './backupSnapshot'

export { selectVerifiedBackupsToPrune } from './backupSnapshot'

export type BackupDestination = 'userData' | 'documents'

export interface BackupFailure {
  destination: BackupDestination
  path: string
  message: string
  code?: string
}

export interface BackupResult {
  timestamp: string
  succeeded: BackupDestination[]
  failed: BackupFailure[]
}

export class BackupAllDestinationsError extends Error {
  readonly code = 'BACKUP_ALL_DESTINATIONS_FAILED' as const

  constructor(readonly failures: BackupFailure[]) {
    super('All configured backup destinations failed')
    this.name = 'BackupAllDestinationsError'
  }
}

export function resolveBackupDirectories(
  userDataPath: string,
  documentsPath: string,
  platform: NodeJS.Platform,
) {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix
  return {
    dataDir: pathImpl.join(userDataPath, 'data'),
    userDataBackupDir: pathImpl.join(userDataPath, 'backups'),
    documentsBackupDir: pathImpl.join(documentsPath, 'BabyDiary-백업'),
  }
}

/**
 * Parse a backup folder name (format: YYYY-MM-DD_HH-MM-SS) to a Date.
 * Returns null if the name does not match the expected pattern.
 */
function parseBackupName(name: string): Date | null {
  // Pattern: 2026-07-12_14-30-00
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const [, year, month, day, hour, minute, second] = m
  const d = new Date(Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second)
  ))
  return isNaN(d.getTime()) ? null : d
}

/**
 * Pure function: given a list of backup folder names and the current time,
 * return the names that should be deleted according to retention policy:
 *   - Keep ALL backups from the last 90 days.
 *   - For backups older than 90 days: keep only the NEWEST one per calendar month.
 *
 * Only operates on names matching the YYYY-MM-DD_HH-MM-SS pattern.
 * Never throws.
 */
export function selectBackupsToPrune(names: string[], now: Date): string[] {
  const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)

  // Separate names into: recent (keep all) vs old (monthly keep-1)
  const oldCandidates: Array<{ name: string; date: Date }> = []
  for (const name of names) {
    const d = parseBackupName(name)
    if (!d) continue  // non-timestamp dirs are ignored
    if (d >= cutoff) continue  // within 90 days: keep always
    oldCandidates.push({ name, date: d })
  }

  // Group old candidates by calendar month key "YYYY-MM"
  const byMonth = new Map<string, Array<{ name: string; date: Date }>>()
  for (const entry of oldCandidates) {
    const key = `${entry.date.getUTCFullYear()}-${String(entry.date.getUTCMonth() + 1).padStart(2, '0')}`
    const group = byMonth.get(key) ?? []
    group.push(entry)
    byMonth.set(key, group)
  }

  const toPrune: string[] = []
  const groups = Array.from(byMonth.values())
  for (const group of groups) {
    // Sort newest-first; keep index 0, prune the rest
    group.sort((a: { name: string; date: Date }, b: { name: string; date: Date }) => b.date.getTime() - a.date.getTime())
    for (let i = 1; i < group.length; i++) {
      toPrune.push(group[i].name)
    }
  }

  return toPrune
}

/** Minimum age before a crash-orphaned tmp directory is eligible for sweep. */
const STALE_TMP_MIN_AGE_MS = 24 * 60 * 60 * 1000

// Staging dirs created by backupDestination(): `${timestamp}.tmp-<random>`.
const STAGING_TMP_NAME_PATTERN = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.tmp-.+$/
// Evidence spool dirs created by createEvidenceSpool() in backupSnapshot.ts:
// `.baby-info-backup.tmp-evidence-<pid>-<random>`.
const EVIDENCE_TMP_NAME_PATTERN = /^\.baby-info-backup\.tmp-evidence-(\d+)-.+$/

export interface StaleTmpSweepCandidate {
  name: string
  mtimeMs: number
}

/**
 * Pure function: given the direct children of a backup root (name + mtime),
 * decide which crash-orphaned staging/evidence tmp directories are safe to
 * delete during the retention sweep.
 *
 * This app must never lose verified backup data, so the rules are
 * deliberately conservative:
 *   - Only names that exactly match one of our own tmp-directory naming
 *     schemes are ever considered. Every other name (including verified
 *     snapshot directories, which never contain ".tmp-") is left untouched,
 *     no matter how old.
 *   - Only tmp directories older than 24h are considered, so a directory
 *     currently being written by an in-flight backup or restore is never
 *     touched.
 *   - Evidence spool directories additionally encode the owning pid. If that
 *     pid is still alive the directory is skipped even when stale, since a
 *     long-running process may legitimately still hold it open.
 * Never throws.
 */
export function selectStaleTmpDirectoriesToSweep(
  entries: StaleTmpSweepCandidate[],
  now: Date,
  isPidAlive: (pid: number) => boolean,
): string[] {
  const cutoff = now.getTime() - STALE_TMP_MIN_AGE_MS
  const toSweep: string[] = []
  for (const entry of entries) {
    // Require age to strictly exceed the minimum (an exact-boundary mtime is
    // treated as still-recent) so anything possibly in-flight is preserved.
    if (entry.mtimeMs >= cutoff) continue

    const stagingMatch = entry.name.match(STAGING_TMP_NAME_PATTERN)
    if (stagingMatch) {
      if (!parseBackupName(stagingMatch[1])) continue // not our timestamp format
      toSweep.push(entry.name)
      continue
    }

    const evidenceMatch = entry.name.match(EVIDENCE_TMP_NAME_PATTERN)
    if (evidenceMatch) {
      const pid = Number(evidenceMatch[1])
      if (Number.isFinite(pid) && isPidAlive(pid)) continue // owner still running
      toSweep.push(entry.name)
      continue
    }
    // Anything else (including verified snapshot directories) is never swept.
  }
  return toSweep
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH: no such process -> dead. EPERM: process exists but we lack
    // permission to signal it -> treat as alive (do not touch its files).
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class BackupManager {
  private readonly userDataPath: string
  private userDataBackupDir: string
  private documentsBackupDir: string
  private lastBackupTime: string | null = null
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private backupInFlight: Promise<BackupResult> | null = null
  private platform: NodeJS.Platform

  constructor(
    userDataPath: string,
    options: { documentsPath?: string; platform?: NodeJS.Platform } = {},
  ) {
    this.userDataPath = userDataPath
    this.platform = options.platform ?? process.platform
    // V4: use app.getPath('documents') instead of os.homedir()/Documents so
    // OneDrive-redirected Documents folders are resolved correctly on Windows.
    const directories = resolveBackupDirectories(
      userDataPath,
      options.documentsPath ?? app.getPath('documents'),
      this.platform,
    )
    this.userDataBackupDir = directories.userDataBackupDir
    this.documentsBackupDir = directories.documentsBackupDir
  }

  private syncDirectory(directory: string): void {
    // Windows does not expose directory handles through fs.openSync. File
    // contents are still fsynced before the same-volume atomic rename.
    if (this.platform === 'win32') return
    const fd = fs.openSync(directory, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  private backupDestination(root: string, timestamp: string, snapshotTimestamp: string): string {
    fs.mkdirSync(root, { recursive: true })
    const finalPath = path.join(root, timestamp)
    if (fs.existsSync(finalPath)) {
      const collision = new Error(`Backup destination already exists: ${finalPath}`)
      ;(collision as NodeJS.ErrnoException).code = 'EEXIST'
      throw collision
    }
    const stagingPath = fs.mkdtempSync(path.join(root, `${timestamp}.tmp-`))
    try {
      stageVerifiedBackupSnapshot(
        this.userDataPath,
        stagingPath,
        snapshotTimestamp,
        this.platform,
      )
      fs.renameSync(stagingPath, finalPath)
      this.syncDirectory(root)
      return finalPath
    } catch (error) {
      try {
        if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { recursive: true, force: true })
      } catch (cleanupError) {
        console.error(`[Backup] Failed to clean staging directory ${stagingPath}:`, cleanupError)
      }
      throw error
    }
  }

  private toFailure(destination: BackupDestination, destinationPath: string, error: unknown): BackupFailure {
    return {
      destination,
      path: destinationPath,
      message: error instanceof Error ? error.message : String(error),
      code: (error as NodeJS.ErrnoException | undefined)?.code,
    }
  }

  /**
   * Sweep crash-orphaned staging/evidence tmp directories left behind by a
   * prior process that died mid-backup (crash, power loss) before it could
   * run its in-process finally-block cleanup. Runs at the start of every
   * backup cycle so these never accumulate without bound.
   * Never throws; a sweep failure must not fail the backup itself.
   */
  private sweepStaleTmpDirectories(root: string): void {
    try {
      if (!fs.existsSync(root)) return
      const dirents = fs.readdirSync(root, { withFileTypes: true })
      const candidates: StaleTmpSweepCandidate[] = []
      for (const dirent of dirents) {
        if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue
        const fullPath = path.join(root, dirent.name)
        try {
          const stat = fs.lstatSync(fullPath)
          if (!stat.isDirectory()) continue
          candidates.push({ name: dirent.name, mtimeMs: stat.mtimeMs })
        } catch {
          continue
        }
      }
      const toSweep = selectStaleTmpDirectoriesToSweep(candidates, new Date(), isPidAlive)
      for (const name of toSweep) {
        const fullPath = path.join(root, name)
        try {
          fs.rmSync(fullPath, { recursive: true, force: true })
          console.log(`[Backup] Swept stale tmp directory: ${name}`)
        } catch (rmErr) {
          console.error(`[Backup] Failed to sweep stale tmp directory ${name}:`, rmErr)
        }
      }
    } catch (sweepErr) {
      console.error('[Backup] Stale tmp sweep failed (non-fatal):', sweepErr)
    }
  }

  private pruneVerifiedBackups(root: string): void {
    try {
      if (fs.existsSync(root)) {
        const toPrune = selectVerifiedBackupsToPrune(root, new Date())
        for (const name of toPrune) {
          const fullPath = path.join(root, name)
          try {
            fs.rmSync(fullPath, { recursive: true, force: true })
            console.log(`[Backup] Pruned old backup: ${name}`)
          } catch (rmErr) {
            console.error(`[Backup] Failed to prune ${name}:`, rmErr)
          }
        }
      }
    } catch (pruneErr) {
      console.error('[Backup] Prune scan failed (non-fatal):', pruneErr)
    }
  }

  private async backupOnce(): Promise<BackupResult> {
    // Entry point of each backup cycle: sweep any crash-orphaned tmp
    // directories left over from a prior process before staging new ones.
    this.sweepStaleTmpDirectories(this.userDataBackupDir)
    this.sweepStaleTmpDirectories(this.documentsBackupDir)

    const now = new Date()
    const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    const targets: Array<{ destination: BackupDestination; root: string }> = [
      { destination: 'userData', root: this.userDataBackupDir },
      { destination: 'documents', root: this.documentsBackupDir },
    ]
    const succeeded: BackupDestination[] = []
    const failed: BackupFailure[] = []

    for (const target of targets) {
      const finalPath = path.join(target.root, timestamp)
      try {
        const durablePath = this.backupDestination(target.root, timestamp, now.toISOString())
        succeeded.push(target.destination)
        console.log(`[Backup] Backed up to ${durablePath}`)
      } catch (error) {
        failed.push(this.toFailure(target.destination, finalPath, error))
        console.error(`[Backup] Failed to backup to ${target.destination}:`, error)
      }
    }

    if (succeeded.length === 0) {
      throw new BackupAllDestinationsError(failed)
    }

    this.lastBackupTime = now.toISOString()
    // Each destination is retained independently, and only fully verified
    // snapshots may occupy the recent/monthly keep slots.
    if (succeeded.includes('userData')) this.pruneVerifiedBackups(this.userDataBackupDir)
    if (succeeded.includes('documents')) this.pruneVerifiedBackups(this.documentsBackupDir)
    return { timestamp: this.lastBackupTime, succeeded, failed }
  }

  backup(): Promise<BackupResult> {
    if (this.backupInFlight) return this.backupInFlight
    const operation = this.backupOnce()
    this.backupInFlight = operation
    const clear = () => {
      if (this.backupInFlight === operation) this.backupInFlight = null
    }
    void operation.then(clear, clear)
    return operation
  }

  start(): void {
    this.backup().catch(err => console.error('[Backup] Initial backup failed:', err))

    const SIX_HOURS = 6 * 60 * 60 * 1000
    this.intervalHandle = setInterval(() => {
      this.backup().catch(err => console.error('[Backup] Scheduled backup failed:', err))
    }, SIX_HOURS)
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  /** P21: Returns true if the periodic backup interval is currently active. */
  isRunning(): boolean {
    return this.intervalHandle !== null
  }

  getLastBackupTime(): string | null {
    return this.lastBackupTime
  }

  getBackupDir(): string {
    return this.userDataBackupDir
  }

  getDocumentsBackupDir(): string {
    return this.documentsBackupDir
  }
}
