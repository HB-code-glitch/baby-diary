import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

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

export class BackupManager {
  private dataDir: string
  private userDataBackupDir: string
  private documentsBackupDir: string
  private lastBackupTime: string | null = null
  private intervalHandle: ReturnType<typeof setInterval> | null = null

  constructor(userDataPath: string) {
    this.dataDir = path.join(userDataPath, 'data')
    this.userDataBackupDir = path.join(userDataPath, 'backups')
    // V4: use app.getPath('documents') instead of os.homedir()/Documents so
    // OneDrive-redirected Documents folders are resolved correctly on Windows.
    this.documentsBackupDir = path.join(app.getPath('documents'), 'BabyDiary-백업')
  }

  private async copyDataFiles(destDir: string): Promise<void> {
    if (!fs.existsSync(this.dataDir)) {
      return
    }

    fs.mkdirSync(destDir, { recursive: true })

    const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.jsonl'))
    for (const file of files) {
      const src = path.join(this.dataDir, file)
      const dest = path.join(destDir, file)
      fs.copyFileSync(src, dest)
    }
  }

  async backup(): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)

    try {
      const dest1 = path.join(this.userDataBackupDir, timestamp)
      await this.copyDataFiles(dest1)
      console.log(`[Backup] Backed up to ${dest1}`)
    } catch (err) {
      console.error('[Backup] Failed to backup to userData:', err)
    }

    try {
      const dest2 = path.join(this.documentsBackupDir, timestamp)
      await this.copyDataFiles(dest2)
      console.log(`[Backup] Backed up to ${dest2}`)
    } catch (err) {
      console.error('[Backup] Failed to backup to Documents:', err)
    }

    this.lastBackupTime = new Date().toISOString()

    // Prune old backups in userDataBackupDir only (never touch documentsBackupDir)
    try {
      if (fs.existsSync(this.userDataBackupDir)) {
        const entries = fs.readdirSync(this.userDataBackupDir)
        const toPrune = selectBackupsToPrune(entries, new Date())
        for (const name of toPrune) {
          const fullPath = path.join(this.userDataBackupDir, name)
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
