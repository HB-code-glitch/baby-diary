import * as fs from 'fs'
import * as path from 'path'
import { AppSettings } from '../../shared/types'

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

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

/** Strip UTF-8 BOM (EF BB BF) that old Windows tools sometimes prepend to JSON files. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s
}

/** Attempt to parse a JSON string into AppSettings after stripping BOM. Returns null on failure. */
function tryParse(raw: string): AppSettings | null {
  try {
    return JSON.parse(stripBom(raw)) as AppSettings
  } catch {
    return null
  }
}

/** Merge a raw parsed object into a validated AppSettings using DEFAULT_SETTINGS as fallback. */
function mergeDefaults(parsed: AppSettings): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    baby:    { ...DEFAULT_SETTINGS.baby,    ...(parsed.baby    ?? {}) },
    profile: { ...DEFAULT_SETTINGS.profile, ...(parsed.profile ?? {}) },
    firebase: parsed.firebase ?? DEFAULT_SETTINGS.firebase,
  }
}

export class SettingsStore {
  private settingsPath: string
  private settings: AppSettings = { ...DEFAULT_SETTINGS }

  constructor(userDataPath: string) {
    this.settingsPath = path.join(userDataPath, 'settings.json')
    this.load()
  }

  private load(): void {
    if (!fs.existsSync(this.settingsPath)) return

    const raw = (() => {
      try { return fs.readFileSync(this.settingsPath, 'utf-8') } catch { return null }
    })()
    if (raw === null) return

    const parsed = tryParse(raw)
    if (parsed !== null) {
      // P10: deep-merge nested objects so partial baby/profile JSON (e.g. from
      // an older version that didn't have every field) never silently yields
      // undefined sub-fields. Top-level spread is kept for unknown future keys.
      this.settings = mergeDefaults(parsed)
      return
    }

    // ── Primary file is corrupt ──────────────────────────────────────────────
    // Write a timestamped .bak copy so we can diagnose the corruption later.
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const bakPath = this.settingsPath + `.corrupt-${ts}.bak`
    try {
      fs.copyFileSync(this.settingsPath, bakPath)
      console.error(`[Settings] Corrupt settings.json — saved backup to ${bakPath}`)
    } catch (bakErr) {
      console.error('[Settings] Could not write corrupt-settings backup:', bakErr)
    }

    // ── Try latest snapshot from userData/backups/*/settings.json ────────────
    const backupsDir = path.join(path.dirname(this.settingsPath), 'backups')
    const restored = this._tryRestoreFromBackups(backupsDir)
    if (restored !== null) {
      console.error('[Settings] Restored settings from backup snapshot.')
      this.settings = restored
      return
    }

    // ── Nothing could be parsed — use hard defaults ──────────────────────────
    console.error('[Settings] No parseable backup found — falling back to DEFAULT_SETTINGS.')
    this.settings = { ...DEFAULT_SETTINGS }
  }

  /** Scan backups dir, try each settings.json newest-first, return first parseable AppSettings. */
  private _tryRestoreFromBackups(backupsDir: string): AppSettings | null {
    if (!fs.existsSync(backupsDir)) return null
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(backupsDir, { withFileTypes: true })
    } catch {
      return null
    }

    // Sort snapshot dirs newest-first by name (ISO-timestamp dirs sort correctly lexicographically)
    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
      .reverse()

    for (const dir of dirs) {
      const candidate = path.join(backupsDir, dir, 'settings.json')
      try {
        if (!fs.existsSync(candidate)) continue
        const raw = fs.readFileSync(candidate, 'utf-8')
        const parsed = tryParse(raw)
        if (parsed !== null) {
          console.error(`[Settings] Restored from backup snapshot: ${candidate}`)
          return mergeDefaults(parsed)
        }
      } catch {
        // corrupt backup entry — continue to next
      }
    }
    return null
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

  /**
   * Field-merge partial settings into the current on-disk settings.
   * Re-reads the file first to avoid overwriting concurrent writes.
   * Only the provided keys are updated; everything else is untouched.
   * This is the preferred API for callers that only own a subset of fields.
   */
  merge(partial: DeepPartial<AppSettings>): void {
    // Re-read from disk to get the authoritative state
    this.load()
    const current = this.settings

    // Deep-merge: baby and profile sub-objects are merged field-by-field
    const merged: AppSettings = {
      ...current,
      ...(partial as Partial<AppSettings>),
      baby: partial.baby != null
        ? { ...current.baby, ...(partial.baby as object) }
        : current.baby,
      profile: partial.profile != null
        ? { ...current.profile, ...(partial.profile as object) }
        : current.profile,
      firebase: 'firebase' in partial
        ? (partial.firebase as AppSettings['firebase'] ?? current.firebase)
        : current.firebase,
    }

    this.save(merged)
  }
}
