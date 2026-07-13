/**
 * src/tests/settings-merge.test.ts
 *
 * RC1 fix verification: settings.merge() must not resurrect dead state when
 * a stale full-save races with a field-scoped merge.
 *
 * Simulates: Session A reads stale settings, Session B merges new familyId,
 * Session A then calls merge with only its own fields → familyId must stay new.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SettingsStore } from '../../electron/store/settings'
import type { AppSettings } from '../../shared/types'

function makeSettings(overrides?: Partial<AppSettings>): AppSettings {
  return {
    baby: { name: 'Test Baby', birthdate: '2024-01-01' },
    profile: { uid: 'uid-test', name: 'Tester', role: 'mom' },
    familyId: '',
    firebase: null,
    ...overrides,
  }
}

function commitPair(store: SettingsStore, name: string, birthdate: string): void {
  store.commitBabyInfo({
    kind: 'user-edit',
    familyId: store.get().familyId,
    babyName: name,
    babyBirthdate: birthdate,
  })
}

describe('SettingsStore.merge', () => {
  let tmpDir: string
  let store: SettingsStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'babydiary-test-'))
    store = new SettingsStore(tmpDir)
  })

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
  })

  it('merge projects the destination family without leaking the prior family pair', () => {
    store.save(makeSettings({ familyId: 'fam-001', baby: { name: 'Sora', birthdate: '2024-06-01' } }))
    commitPair(store, 'Sora', '2024-06-01')
    store.merge({ familyId: 'fam-002' })
    const result = store.get()
    expect(result.familyId).toBe('fam-002')
    expect(result.baby.name).toBe('')                 // fam-002 has no retained winner
    expect(result.baby.birthdate).toBe('')
    expect(result.profile.uid).toBe('uid-test')     // untouched
  })

  it('merge re-reads disk — stale full-save from Session A cannot resurrect old familyId', () => {
    // Initial state on disk
    store.save(makeSettings({ familyId: 'fam-old' }))
    commitPair(store, 'Test Baby', '2024-01-01')

    // Session A reads OLD state (simulated by reading before Session B writes)
    const storeA = new SettingsStore(tmpDir) // fresh instance = fresh disk read
    const staleSettings = storeA.get()      // staleSettings.familyId === 'fam-old'

    // Session B merges a NEW familyId (uses merge — field-scoped write)
    const storeB = new SettingsStore(tmpDir)
    storeB.merge({ familyId: 'fam-new' })

    // Verify disk now has fam-new
    const storeC = new SettingsStore(tmpDir)
    expect(storeC.get().familyId).toBe('fam-new')

    // Session A now calls merge with only its own fields (baby+profile) — NOT full save
    // Even though staleSettings has familyId='fam-old', Session A only owns baby/profile
    storeA.merge({
      baby:    staleSettings.baby,
      profile: staleSettings.profile,
    })

    // CRITICAL: familyId must still be fam-new — merge must not resurrect old value
    const final = new SettingsStore(tmpDir).get()
    expect(final.familyId).toBe('fam-new')
    expect(final.baby.name).toBe('') // generic writes cannot leak fam-old's managed pair
  })

  it('merge deep-merges unmanaged baby fields without changing the managed pair', () => {
    store.save(makeSettings({
      baby: { name: 'Hana', birthdate: '2024-03-15', gender: 'girl' },
      familyId: 'fam-xyz',
    }))
    commitPair(store, 'Hana', '2024-03-15')
    // Generic merge cannot change the managed name/date; gender still survives.
    store.merge({
      baby: { name: 'Hana Updated', birthdate: '2024-03-15' },
      babyInfoRevision: store.get().babyInfoRevision,
    })
    const result = store.get()
    expect(result.baby.name).toBe('Hana')
    expect(result.baby.birthdate).toBe('2024-03-15')
    expect(result.baby.gender).toBe('girl') // preserved via deep-merge
    expect(result.familyId).toBe('fam-xyz') // untouched
  })

  it('merge with { familyId: "" } clears both the link and managed projection', () => {
    store.save(makeSettings({ familyId: 'fam-xyz', baby: { name: 'Rio', birthdate: '2025-01-01' } }))
    commitPair(store, 'Rio', '2025-01-01')
    store.merge({ familyId: '' })
    const result = store.get()
    expect(result.familyId).toBe('')
    expect(result.baby.name).toBe('')
  })
})
