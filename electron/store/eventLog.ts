import * as fs from 'fs'
import * as path from 'path'
import { DiaryEvent } from '../../shared/types'
import { compareEventMutations, getEventStorageKey, validateDiaryEvent } from '../../shared/eventResolver'
import {
  appendDurableFileSync,
  isDurableAppendCommittedError,
  type DurableFileOps,
  type DurableWriteOptions,
} from './durableFs'

/** Validate a DiaryEvent before crossing the append-only storage boundary. */
export function validateEvent(event: unknown): string | null {
  return validateDiaryEvent(event)
}

export interface EventLogOptions {
  dataDir: string
  /** Fault-injection seam shared with the durable sidecar writer tests. */
  fileOps?: DurableFileOps
  platform?: NodeJS.Platform
}

export class EventLog {
  private dataDir: string
  private index: Map<string, DiaryEvent> = new Map()
  /** One entry per immutable mutation physically present in the append-only log. */
  private mutations: Map<string, DiaryEvent> = new Map()
  private loaded = false
  private readonly durableWriteOptions: DurableWriteOptions

  constructor(options: EventLogOptions) {
    this.dataDir = options.dataDir
    this.durableWriteOptions = {
      fs: options.fileOps,
      platform: options.platform,
    }
  }

  private getMonthFile(isoDate: string): string {
    const d = new Date(isoDate)
    const yyyy = String(d.getUTCFullYear()).padStart(4, '0')
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
    return path.join(this.dataDir, `events-${yyyy}-${mm}.jsonl`)
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true })
  }

  private updateResolvedIndex(event: DiaryEvent): void {
    const existing = this.index.get(event.id)
    if (!existing || compareEventMutations(event, existing) > 0) {
      this.index.set(event.id, event)
    }
  }

  loadAll(): DiaryEvent[] {
    this.ensureDataDir()
    this.index.clear()
    this.mutations.clear()

    let files: string[] = []
    try {
      // Accept old non-padded early-year filenames while all new writes use four digits.
      files = fs.readdirSync(this.dataDir).filter(file => /^events-\d{1,4}-\d{2}\.jsonl$/.test(file))
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

        const validationError = validateEvent(event)
        if (validationError) {
          console.error(`[EventLog] Skipping invalid event in ${file} (line ${i + 1}): ${validationError}`)
          continue
        }

        const mutationKey = getEventStorageKey(event)
        const existingMutation = this.mutations.get(mutationKey)
        if (!existingMutation || compareEventMutations(event, existingMutation) > 0) {
          this.mutations.set(mutationKey, event)
        }
        this.updateResolvedIndex(event)
      }
    }

    this.loaded = true
    return Array.from(this.index.values())
  }

  append(event: DiaryEvent): 'ok' | 'duplicate' | 'error' {
    const validationError = validateEvent(event)
    if (validationError) {
      console.error(`[EventLog] Rejected invalid event: ${validationError}`, event)
      return 'error'
    }

    this.ensureDataDir()
    if (!this.loaded) this.loadAll()

    const mutationKey = getEventStorageKey(event)
    if (this.mutations.has(mutationKey)) return 'duplicate'

    const filePath = this.getMonthFile(event.at)
    const line = JSON.stringify(event) + '\n'

    // A torn final write without a newline must not fuse with the next record.
    try {
      const stat = fs.statSync(filePath)
      if (stat.size > 0) {
        const lastByte = Buffer.alloc(1)
        const readFd = fs.openSync(filePath, 'r')
        try {
          fs.readSync(readFd, lastByte, 0, 1, stat.size - 1)
        } finally {
          fs.closeSync(readFd)
        }
        if (lastByte[0] !== 0x0a) {
          try {
            appendDurableFileSync(filePath, Buffer.from('\n', 'utf8'), this.durableWriteOptions)
          } catch (err) {
            if (!isDurableAppendCommittedError(err)) {
              console.error('[EventLog] Failed to repair torn newline before append:', err)
              return 'error'
            }
            // The separator byte reached disk and was fsynced before a later
            // step (fd close / directory fsync) failed. Treat it as durable
            // and continue appending the record onto the now-separated file.
          }
        }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    try {
      appendDurableFileSync(filePath, Buffer.from(line, 'utf8'), this.durableWriteOptions)
    } catch (err) {
      if (!isDurableAppendCommittedError(err)) {
        console.error('[EventLog] Failed to write event to disk:', err)
        return 'error'
      }
      // The record bytes reached disk and were fsynced before a later step
      // (fd close / directory fsync for a newly created month file) failed.
      // The append is durably committed on disk; report success and keep
      // the in-memory index/mutations in sync with what is now on disk.
    }

    this.mutations.set(mutationKey, event)
    this.updateResolvedIndex(event)
    return 'ok'
  }

  /** Resolved visible view: exactly one deterministic winner per event id. */
  getAll(): DiaryEvent[] {
    if (!this.loaded) this.loadAll()
    return Array.from(this.index.values())
  }

  /** Every immutable record, used by sync reconciliation to avoid data loss. */
  getAllMutations(): DiaryEvent[] {
    if (!this.loaded) this.loadAll()
    return Array.from(this.mutations.values()).sort((left, right) => {
      if (left.id !== right.id) return left.id < right.id ? -1 : 1
      return compareEventMutations(left, right)
    })
  }

  getCount(): number {
    if (!this.loaded) this.loadAll()
    return Array.from(this.index.values()).filter(event => !event.deleted).length
  }
}
