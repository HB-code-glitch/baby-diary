import * as fs from 'fs'
import * as path from 'path'
import { DiaryEvent, EventType } from '../../shared/types'

const VALID_TYPES: EventType[] = ['pee', 'poop', 'temp', 'breast', 'formula', 'diary', 'message']

/** F4: Validate a DiaryEvent before writing to disk. Returns null if valid, error string if invalid. */
export function validateEvent(event: unknown): string | null {
  if (!event || typeof event !== 'object') return 'event must be an object'
  const e = event as Record<string, unknown>

  if (typeof e.id !== 'string' || e.id.trim() === '') return 'id must be a non-empty string'
  if (typeof e.rev !== 'number' || !Number.isInteger(e.rev) || e.rev < 1) return 'rev must be a positive integer'
  if (typeof e.at !== 'string' || isNaN(Date.parse(e.at))) return 'at must be a valid ISO date string'
  if (typeof e.type !== 'string' || !(VALID_TYPES as string[]).includes(e.type)) return `type must be one of: ${VALID_TYPES.join(', ')}`
  if (typeof e.deleted !== 'boolean') return 'deleted must be a boolean'
  if (typeof e.createdAt !== 'string' || isNaN(Date.parse(e.createdAt))) return 'createdAt must be a valid ISO date string'
  if (typeof e.updatedAt !== 'string' || isNaN(Date.parse(e.updatedAt))) return 'updatedAt must be a valid ISO date string'

  return null
}

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

  append(event: DiaryEvent): 'ok' | 'duplicate' | 'error' {
    // F4: validate before touching the filesystem
    const validationError = validateEvent(event)
    if (validationError) {
      console.error(`[EventLog] Rejected invalid event: ${validationError}`, event)
      return 'error'
    }

    this.ensureDataDir()

    if (!this.loaded) {
      this.loadAll()
    }

    const existing = this.index.get(event.id)
    if (existing && existing.rev === event.rev) {
      return 'duplicate'
    }

    const filePath = this.getMonthFile(event.at)
    const line = JSON.stringify(event) + '\n'

    // F1: ensure the file ends with a newline before appending so a torn final
    // line (written without a trailing newline due to a crash) cannot fuse with
    // our new data and cause silent data loss on the next reload.
    // We must check with a separate stat/read before opening in append mode,
    // because 'a'-mode file descriptors are write-only on some platforms.
    try {
      const stat = fs.statSync(filePath)
      if (stat.size > 0) {
        const lastByte = Buffer.alloc(1)
        const rfd = fs.openSync(filePath, 'r')
        try {
          fs.readSync(rfd, lastByte, 0, 1, stat.size - 1)
        } finally {
          fs.closeSync(rfd)
        }
        if (lastByte[0] !== 0x0a /* '\n' */) {
          // Append the missing newline first, then the event
          const afd = fs.openSync(filePath, 'a')
          try {
            fs.writeSync(afd, '\n')
            fs.fsyncSync(afd)
          } finally {
            fs.closeSync(afd)
          }
        }
      }
    } catch {
      // File doesn't exist yet — will be created by the 'a' open below; no action needed.
    }

    try {
      const fd = fs.openSync(filePath, 'a')
      try {
        fs.writeSync(fd, line)
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      console.error('[EventLog] Failed to write event to disk:', err)
      return 'error'
    }

    if (!existing || event.rev > existing.rev) {
      this.index.set(event.id, event)
    } else if (event.rev === existing.rev) {
      if (new Date(event.updatedAt) > new Date(existing.updatedAt)) {
        this.index.set(event.id, event)
      }
    }

    return 'ok'
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
