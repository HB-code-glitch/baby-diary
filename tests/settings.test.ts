import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { SettingsStore } from '../electron/store/settings'
import { AppSettings } from '../shared/types'

describe('SettingsStore', () => {
  let tmpDir: string
  let store: SettingsStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-diary-settings-test-'))
    store = new SettingsStore(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('atomic write: saves and loads settings correctly', () => {
    const settings: AppSettings = {
      baby: { name: '아기', birthdate: '2024-01-01' },
      profile: { uid: 'uid1', name: '아빠', role: 'dad' },
      familyId: 'family1',
      firebase: null,
    }

    store.save(settings)

    const store2 = new SettingsStore(tmpDir)
    const loaded = store2.get()

    expect(loaded.baby.name).toBe('아기')
    expect(loaded.profile.role).toBe('dad')
    expect(loaded.familyId).toBe('family1')
  })

  it('no tmp file left after save', () => {
    const settings: AppSettings = {
      baby: { name: '테스트', birthdate: '2024-06-01' },
      profile: { uid: 'uid2', name: '엄마', role: 'mom' },
      familyId: '',
      firebase: null,
    }

    store.save(settings)

    const files = fs.readdirSync(tmpDir)
    const tmpFiles = files.filter(f => f.endsWith('.tmp'))
    expect(tmpFiles).toHaveLength(0)

    const settingsFile = files.find(f => f === 'settings.json')
    expect(settingsFile).toBeDefined()
  })
})
