import * as fs from 'fs'
import * as path from 'path'
import { DiaryEvent } from '../../shared/types'

export interface EventLogOptions {
  dataDir: string
}

export class EventLog {
  private dataDir: string
  private index: Map<string, DiaryEvent> = new Map()
  private loaded = false

  constructor(options: EventLogOptions) {
    this.dataDir = options.dataDir
  }

  private getMonthFile(isoDate: string): string {
    const d = new Date(isoDate)
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    return path.join(this.dataDir, `events-${yyyy}-${mm}.jsonl`)
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true })
    }
  }

  loadAll(): DiaryEvent[] {
    this.ensureDataDir()
    this.index.clear()

    let files: string[] = []
    try {
      files = fs.readdirSync(this.dataDir).filter(f => f.match(/^events-\d{4}-\d{2}\.jsonl$/))
    } catch {
      return []
    }

    for (const file of files) {
      const filePath = path.join(this.dataDir, file)
      let content = ''
      try {
        content = fs.readFileSync(filePath, 'utf-8')
      } catch (err) {
        console.error(`[EventLog] Failed to read file ${filePath}:`, err)
        continue
      }

      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) continue

        const isFinalLine = i === lines.length - 1

        let event: DiaryEvent
        try {
          event = JSON.parse(line) as DiaryEvent
        } catch (err) {
          if (isFinalLine) {
            console.warn(`[EventLog] Skipping truncated final line in ${file} (line ${i + 1}):`, err)
          } else {
            console.error(`[EventLog] Skipping malformed line in ${file} (line ${i + 1}):`, err)
          }
          continue
        }

        const existing = this.index.get(event.id)
        if (!existing) {
          this.index.set(event.id, event)
        } else if (event.rev > existing.rev) {
          this.index.set(event.id, event)
        } else if (event.rev === existing.rev) {
          if (new Date(event.updatedAt) > new Date(existing.updatedAt)) {
            this.index.set(event.id, event)
          }
        }
      }
    }

    this.loaded = true
    return Array.from(this.index.values())
  }

  append(event: DiaryEvent): boolean {
    this.ensureDataDir()

    if (!this.loaded) {
      this.loadAll()
    }

    const existing = this.index.get(event.id)
    if (existing && existing.rev === event.rev) {
      return false
    }

    const filePath = this.getMonthFile(event.at)
    const line = JSON.stringify(event) + '\n'

    const fd = fs.openSync(filePath, 'a')
    try {
      fs.writeSync(fd, line)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }

    if (!existing || event.rev > existing.rev) {
      this.index.set(event.id, event)
    } else if (event.rev === existing.rev) {
      if (new Date(event.updatedAt) > new Date(existing.updatedAt)) {
        this.index.set(event.id, event)
      }
    }

    return true
  }

  getAll(): DiaryEvent[] {
    if (!this.loaded) {
      this.loadAll()
    }
    return Array.from(this.index.values())
  }

  getCount(): number {
    if (!this.loaded) {
      this.loadAll()
    }
    return Array.from(this.index.values()).filter(e => !e.deleted).length
  }
}
