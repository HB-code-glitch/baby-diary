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

  // ── BOM handling ────────────────────────────────────────────────────────────

  it('BOM read: loads settings.json that has a UTF-8 BOM prefix', () => {
    const settings: AppSettings = {
      baby: { name: 'BOM아기', birthdate: '2024-03-01' },
      profile: { uid: 'bom-uid', name: 'BOM엄마', role: 'mom' },
      familyId: 'bom-family',
      firebase: null,
    }
    // Write with BOM manually
    const json = '﻿' + JSON.stringify(settings, null, 2)
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), json, 'utf-8')

    const loaded = new SettingsStore(tmpDir).get()
    expect(loaded.baby.name).toBe('BOM아기')
    expect(loaded.profile.uid).toBe('bom-uid')
    expect(loaded.familyId).toBe('bom-family')
  })

  // ── Corrupt settings + backup restore ──────────────────────────────────────

  it('corrupt settings.json: writes .bak and falls back to DEFAULT_SETTINGS when no backup exists', () => {
    // Write garbage JSON
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '{ not valid json !!!', 'utf-8')

    const loaded = new SettingsStore(tmpDir).get()

    // Should fall back to defaults
    expect(loaded.baby.name).toBe('')
    expect(loaded.familyId).toBe('')

    // A .bak file should have been created
    const baks = fs.readdirSync(tmpDir).filter(f => f.includes('.corrupt-') && f.endsWith('.bak'))
    expect(baks.length).toBe(1)
  })

  it('corrupt settings.json: restores from newest backup snapshot', () => {
    const goodSettings: AppSettings = {
      baby: { name: '복구아기', birthdate: '2025-01-01' },
      profile: { uid: 'restore-uid', name: '복구엄마', role: 'mom' },
      familyId: 'restored-family',
      firebase: null,
    }

    // Create backups/2025-01-01T00-00-00/settings.json
    const backupDir = path.join(tmpDir, 'backups', '2025-01-01T00-00-00')
    fs.mkdirSync(backupDir, { recursive: true })
    fs.writeFileSync(path.join(backupDir, 'settings.json'), JSON.stringify(goodSettings, null, 2), 'utf-8')

    // Write corrupt primary settings.json
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), '}} totally broken {{', 'utf-8')

    const loaded = new SettingsStore(tmpDir).get()
    expect(loaded.baby.name).toBe('복구아기')
    expect(loaded.familyId).toBe('restored-family')
    expect(loaded.profile.uid).toBe('restore-uid')
  })

  it('corrupt settings.json: uses newest backup when multiple exist', () => {
    const oldSettings: AppSettings = {
      baby: { name: '구버전아기', birthdate: '2024-01-01' },
      profile: { uid: 'old-uid', name: '구버전엄마', role: 'mom' },
      familyId: 'old-family',
      firebase: null,
    }
    const newSettings: AppSettings = {
      baby: { name: '최신아기', birthdate: '2025-06-01' },
      profile: { uid: 'new-uid', name: '최신아빠', role: 'dad' },
      familyId: 'new-family',
      firebase: null,
    }

    // Older backup
    const oldDir = path.join(tmpDir, 'backups', '2024-06-01T00-00-00')
    fs.mkdirSync(oldDir, { recursive: true })
    fs.writeFileSync(path.join(oldDir, 'settings.json'), JSON.stringify(oldSettings, null, 2), 'utf-8')

    // Newer backup (sorts after old lexicographically)
    const newDir = path.join(tmpDir, 'backups', '2025-06-01T00-00-00')
    fs.mkdirSync(newDir, { recursive: true })
    fs.writeFileSync(path.join(newDir, 'settings.json'), JSON.stringify(newSettings, null, 2), 'utf-8')

    // Corrupt primary
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), 'not json', 'utf-8')

    const loaded = new SettingsStore(tmpDir).get()
    expect(loaded.baby.name).toBe('최신아기')
    expect(loaded.familyId).toBe('new-family')
  })
})
