import * as fs from 'fs'
import * as path from 'path'
import { AppSettings } from '../../shared/types'

const DEFAULT_SETTINGS: AppSettings = {
  baby: {
    name: '',
    birthdate: '',
    gender: undefined,  // P10: match AppSettings type so deep-merge never drops the field
  },
  profile: {
    uid: '',
    name: '',
    role: 'dad',
  },
  familyId: '',
  firebase: null,
}

export class SettingsStore {
  private settingsPath: string
  private settings: AppSettings = { ...DEFAULT_SETTINGS }

  constructor(userDataPath: string) {
    this.settingsPath = path.join(userDataPath, 'settings.json')
    this.load()
  }

  private load(): void {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const raw = fs.readFileSync(this.settingsPath, 'utf-8')
        const parsed = JSON.parse(raw)
        // P10: deep-merge nested objects so partial baby/profile JSON (e.g. from
        // an older version that didn't have every field) never silently yields
        // undefined sub-fields. Top-level spread is kept for unknown future keys.
        this.settings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          baby:    { ...DEFAULT_SETTINGS.baby,    ...(parsed.baby    ?? {}) },
          profile: { ...DEFAULT_SETTINGS.profile, ...(parsed.profile ?? {}) },
          firebase: parsed.firebase ?? DEFAULT_SETTINGS.firebase,
        }
      }
    } catch (err) {
      console.error('[Settings] Failed to load settings, using defaults:', err)
      this.settings = { ...DEFAULT_SETTINGS }
    }
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  save(settings: AppSettings): void {
    const tmpPath = this.settingsPath + '.tmp'
    const content = JSON.stringify(settings, null, 2)

    // P5 + F9: wrap the entire write-rename sequence so that any fs error
    // (including renameSync outside the inner try) surfaces as a structured Error
    // that IPC callers can catch and report to the user.
    try {
      // F9: fsync the tmp file before rename so the data is durable on disk
      // even if the OS crashes between the write and rename.
      const fd = fs.openSync(tmpPath, 'w')
      try {
        fs.writeSync(fd, content, 0, 'utf-8')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmpPath, this.settingsPath)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const structured = new Error(`[Settings] save failed: ${msg}`)
      ;(structured as NodeJS.ErrnoException).code = (err as NodeJS.ErrnoException).code
      throw structured
    }

    this.settings = { ...settings }
  }
}
