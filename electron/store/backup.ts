import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export class BackupManager {
  private dataDir: string
  private userDataBackupDir: string
  private documentsBackupDir: string
  private lastBackupTime: string | null = null
  private intervalHandle: ReturnType<typeof setInterval> | null = null

  constructor(userDataPath: string) {
    this.dataDir = path.join(userDataPath, 'data')
    this.userDataBackupDir = path.join(userDataPath, 'backups')
    this.documentsBackupDir = path.join(os.homedir(), 'Documents', 'BabyDiary-백업')
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
