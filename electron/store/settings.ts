import * as fs from 'fs'
import * as path from 'path'
import { AppSettings } from '../../shared/types'

const DEFAULT_SETTINGS: AppSettings = {
  baby: {
    name: '',
    birthdate: '',
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
        this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
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

    this.settings = { ...settings }
  }
}
