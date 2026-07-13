import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FIREBASE_PERSISTENCE_REGISTRY_FILE,
  FirebasePersistenceRegistry,
  detectPreexistingFirebaseProfile,
} from '../electron/store/firebasePersistenceRegistry'
import {
  LEGACY_FIREBASE_APP_NAME,
  canonicalFirebaseConfig,
  getDigestFirebasePersistenceIdentity,
  sha256Hex,
} from '../shared/firebasePersistence'
import { DEFAULT_FIREBASE_CONFIG } from '../shared/defaultFirebaseConfig'

const roots: string[] = []

const customConfig = {
  apiKey: 'custom-api-key',
  authDomain: 'custom.example.test',
  projectId: 'custom-project',
  storageBucket: 'custom-bucket',
  messagingSenderId: '987654321',
  appId: 'custom-app-id',
}

const otherConfig = {
  ...customConfig,
  apiKey: 'other-api-key',
  projectId: 'other-project',
  appId: 'other-app-id',
}

function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `baby-diary-firebase-${label}-`))
  roots.push(root)
  return root
}

function writeSettingsEvidence(root: string, firebase: typeof customConfig | null): void {
  writeFileSync(join(root, 'settings.json'), JSON.stringify({
    baby: { name: '아기', birthdate: '2026-01-01' },
    profile: { uid: 'legacy-user', name: '보호자', role: 'mom' },
    familyId: 'ABCDEFGHJKLM',
    firebase,
  }))
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('main-owned Firebase persistence registry', () => {
  it('matches Node SHA-256 for standard, Unicode, and long canonical inputs', () => {
    const inputs = [
      '',
      'abc',
      '아기日記👶',
      'firebase-canonical-config/'.repeat(8_192),
    ]
    for (const input of inputs) {
      expect(sha256Hex(input)).toBe(
        createHash('sha256').update(input, 'utf8').digest('hex'),
      )
    }
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('claims the exact shared default when released settings stored firebase:null', () => {
    const root = makeRoot('legacy-default')
    writeSettingsEvidence(root, null)
    const snapshot = detectPreexistingFirebaseProfile(root)

    const registry = FirebasePersistenceRegistry.open(root, snapshot)

    expect(registry.claim(DEFAULT_FIREBASE_CONFIG).appName).toBe(LEGACY_FIREBASE_APP_NAME)
    expect(registry.claim(customConfig).appName).toBe(
      getDigestFirebasePersistenceIdentity(customConfig).appName,
    )
  })

  it('inherits a v0.3.8 custom config despite partial and unknown unrelated settings fields', () => {
    const root = makeRoot('legacy-partial-unknown')
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      firebase: customConfig,
      baby: { unknownHistoricalShape: ['preserve', 0, false, null] },
      profile: 42,
      upgradeOpaque: { deep: { ko: '보존', ja: '保持' } },
    }))

    const snapshot = detectPreexistingFirebaseProfile(root)
    const registry = FirebasePersistenceRegistry.open(root, snapshot)

    expect(registry.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('fails closed when the settings firebase field itself is malformed', () => {
    const root = makeRoot('legacy-malformed-firebase')
    writeFileSync(join(root, 'settings.json'), JSON.stringify({
      firebase: { ...customConfig, extra: 'not released' },
      upgradeOpaque: { keep: true },
    }))

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/firebase value is invalid/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })

  it('canonicalizes IPC config in main and rejects renderer-supplied extra fields', () => {
    const root = makeRoot('invalid-ipc-config')
    const registry = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )

    expect(() => registry.claim({
      ...customConfig,
      rendererFingerprint: canonicalFirebaseConfig(customConfig),
    })).toThrow(/configuration shape is invalid/i)
  })

  it('immutably binds the canonical custom config A to v0.3.8 and keeps A -> B -> A stable across restart', () => {
    const root = makeRoot('legacy-custom')
    writeSettingsEvidence(root, customConfig)
    const evidence = detectPreexistingFirebaseProfile(root)
    expect(evidence).toMatchObject({ existed: true, kind: 'settings-snapshot' })

    const first = FirebasePersistenceRegistry.open(root, evidence)
    const rawBefore = readFileSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))

    expect(first.claim(customConfig)).toMatchObject({
      appName: LEGACY_FIREBASE_APP_NAME,
      configIdentity: canonicalFirebaseConfig(customConfig),
    })
    expect(first.claim(otherConfig).appName).toBe(
      getDigestFirebasePersistenceIdentity(otherConfig).appName,
    )

    const restarted = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )
    expect(restarted.claim(otherConfig).appName).toBe(
      getDigestFirebasePersistenceIdentity(otherConfig).appName,
    )
    expect(restarted.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)
    expect(readFileSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toEqual(rawBefore)

    const diagnostic = restarted.diagnostic()
    expect(diagnostic).toMatchObject({
      classification: 'legacy-v0.3.8-upgrade',
      legacyAppName: LEGACY_FIREBASE_APP_NAME,
      preservedDigestAppName: getDigestFirebasePersistenceIdentity(customConfig).appName,
    })
  })

  it('persists a fresh classification so a later settings file can never steal the legacy namespace', () => {
    const root = makeRoot('fresh')
    const evidence = detectPreexistingFirebaseProfile(root)
    expect(evidence).toMatchObject({ existed: false, kind: 'settings-absent' })

    const first = FirebasePersistenceRegistry.open(root, evidence)
    expect(first.claim(customConfig).appName).toBe(
      getDigestFirebasePersistenceIdentity(customConfig).appName,
    )

    writeSettingsEvidence(root, customConfig)
    const restarted = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )
    expect(restarted.claim(customConfig).appName).toBe(
      getDigestFirebasePersistenceIdentity(customConfig).appName,
    )
    expect(restarted.diagnostic().classification).toBe('fresh-v0.3.9-or-newer')
  })

  it('re-reads the one hard-link winner when two processes publish concurrently', () => {
    const root = makeRoot('concurrent')
    writeSettingsEvidence(root, customConfig)
    const evidence = detectPreexistingFirebaseProfile(root)
    let second!: FirebasePersistenceRegistry

    const first = FirebasePersistenceRegistry.open(root, evidence, {
      beforePublish: () => {
        second = FirebasePersistenceRegistry.open(root, evidence)
      },
    })

    expect(first.claim(customConfig)).toEqual(second.claim(customConfig))
    expect(first.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('survives response loss after publish and returns the same ownership on retry', () => {
    const root = makeRoot('response-loss')
    writeSettingsEvidence(root, customConfig)
    const evidence = detectPreexistingFirebaseProfile(root)

    expect(() => FirebasePersistenceRegistry.open(root, evidence, {
      afterPublish: () => { throw new Error('simulated response loss') },
    })).toThrow('simulated response loss')

    const retried = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )
    expect(retried.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)
    expect(retried.claim(otherConfig).appName).toBe(
      getDigestFirebasePersistenceIdentity(otherConfig).appName,
    )
  })

  it('fails closed on corrupt or unknown registry fields without replacing existing bytes', () => {
    const root = makeRoot('corrupt')
    const registryPath = join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE)
    const corrupt = Buffer.from('{"version":1,"legacyClaim":null,"unknown":true}\n')
    writeFileSync(registryPath, corrupt)

    expect(() => FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )).toThrow(/registry/i)
    expect(readFileSync(registryPath)).toEqual(corrupt)
  })

  it('rejects a registry symlink/reparse point and never changes its target', () => {
    const root = makeRoot('symlink')
    const outside = makeRoot('outside')
    const target = join(outside, 'target.json')
    const targetBytes = Buffer.from('{"outside":true}\n')
    writeFileSync(target, targetBytes)
    const registryPath = join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE)
    try {
      symlinkSync(target, registryPath, 'file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }

    expect(lstatSync(registryPath).isSymbolicLink()).toBe(true)
    expect(() => FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )).toThrow(/link|reparse|regular/i)
    expect(readFileSync(target)).toEqual(targetBytes)
  })

  it('does not remove an unverified foreign crash candidate', () => {
    const root = makeRoot('foreign-temp')
    const foreign = join(root, `${FIREBASE_PERSISTENCE_REGISTRY_FILE}.candidate-foreign`)
    writeFileSync(foreign, 'forensic evidence')

    const registry = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )
    expect(registry.claim(customConfig).appName).toBe(
      getDigestFirebasePersistenceIdentity(customConfig).appName,
    )
    expect(existsSync(foreign)).toBe(true)
    expect(readFileSync(foreign, 'utf8')).toBe('forensic evidence')
  })

  it('never modifies Chromium Auth, Local Storage, or IndexedDB bytes', () => {
    const root = makeRoot('chromium-untouched')
    writeSettingsEvidence(root, customConfig)
    const sentinels = [
      join(root, 'IndexedDB', 'firebase.leveldb'),
      join(root, 'Local Storage', 'leveldb', 'auth.log'),
      join(root, 'Session Storage', 'session.log'),
    ]
    sentinels.forEach((file, index) => {
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, Buffer.from(`sentinel-${index}-firebase-bytes`))
    })
    const before = sentinels.map(file => readFileSync(file))

    const registry = FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )
    expect(registry.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)

    sentinels.forEach((file, index) => expect(readFileSync(file)).toEqual(before[index]))
  })

  it('can retry the same snapshot after a pre-publish interruption without a digest fallback', () => {
    const root = makeRoot('publish-interrupted')
    writeSettingsEvidence(root, customConfig)
    const snapshot = detectPreexistingFirebaseProfile(root)

    expect(() => FirebasePersistenceRegistry.open(root, snapshot, {
      beforePublish: () => { throw new Error('power loss before link') },
    })).toThrow('power loss before link')
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)

    const retried = FirebasePersistenceRegistry.open(root, snapshot)
    expect(retried.claim(customConfig).appName).toBe(LEGACY_FIREBASE_APP_NAME)
  })

  it('fails before publication if the parent directory identity changes', () => {
    const container = makeRoot('root-swap')
    const root = join(container, 'profile')
    const displaced = join(container, 'profile-original')
    mkdirSync(root)
    writeSettingsEvidence(root, customConfig)
    const evidence = detectPreexistingFirebaseProfile(root)

    expect(() => FirebasePersistenceRegistry.open(root, evidence, {
      beforePublish: () => {
        // Keep the original bytes for forensics and substitute an empty directory.
        renameSync(root, displaced)
        mkdirSync(root)
      },
    })).toThrow(/directory|identity|path/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
    expect(existsSync(join(displaced, 'settings.json'))).toBe(true)
  })

  it('rejects a valid settings replacement after snapshot and publishes no final claim', () => {
    const root = makeRoot('settings-swap')
    writeSettingsEvidence(root, customConfig)
    const snapshot = detectPreexistingFirebaseProfile(root)
    const original = join(root, 'settings.original.json')

    expect(() => FirebasePersistenceRegistry.open(root, snapshot, {
      beforePublish: () => {
        renameSync(join(root, 'settings.json'), original)
        writeSettingsEvidence(root, otherConfig)
      },
    })).toThrow(/settings.*changed|identity/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
    expect(existsSync(original)).toBe(true)
  })

  it('rejects corrupt settings evidence before publishing any registry', () => {
    const root = makeRoot('settings-corrupt')
    writeFileSync(join(root, 'settings.json'), '{not-json')

    expect(() => detectPreexistingFirebaseProfile(root)).toThrow(/settings evidence is invalid/i)
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe('{not-json')
  })

  it('detects a same-inode same-size registry rewrite between stable reads', () => {
    const root = makeRoot('same-inode-rewrite')
    const initial = detectPreexistingFirebaseProfile(root)
    FirebasePersistenceRegistry.open(root, initial)
    const registryPath = join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE)
    const original = readFileSync(registryPath)
    const changed = Buffer.from(original)
    const whitespace = changed.indexOf(0x0a)
    expect(whitespace).toBeGreaterThan(0)
    changed[whitespace] = 0x20

    expect(() => FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
      { afterFirstFileRead: () => writeFileSync(registryPath, changed) },
    )).toThrow(/changed while reading|identity changed/i)
    expect(readFileSync(registryPath)).toEqual(changed)
  })

  it('detects an atomic final-path swap even when replacement bytes are identical', () => {
    const root = makeRoot('atomic-final-swap')
    FirebasePersistenceRegistry.open(root, detectPreexistingFirebaseProfile(root))
    const registryPath = join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE)
    const displaced = join(root, 'registry.displaced.json')
    const original = readFileSync(registryPath)

    expect(() => FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
      {
        afterFirstFileRead: () => {
          renameSync(registryPath, displaced)
          writeFileSync(registryPath, original)
        },
      },
    )).toThrow(/changed while reading|identity changed/i)
    expect(readFileSync(displaced)).toEqual(original)
    expect(readFileSync(registryPath)).toEqual(original)
  })

  it('rejects an oversized final registry without truncating or replacing it', () => {
    const root = makeRoot('oversized')
    const registryPath = join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE)
    const oversized = Buffer.alloc(64 * 1024 + 1, 0x78)
    writeFileSync(registryPath, oversized)

    expect(() => FirebasePersistenceRegistry.open(
      root,
      detectPreexistingFirebaseProfile(root),
    )).toThrow(/size/i)
    expect(readFileSync(registryPath)).toEqual(oversized)
  })

  it('safely creates a completely absent nested userData root and classifies it fresh', () => {
    const container = makeRoot('absent-root')
    const root = join(container, 'nested', 'profile')

    const snapshot = detectPreexistingFirebaseProfile(root)

    expect(snapshot).toMatchObject({ existed: false, kind: 'settings-absent' })
    expect(lstatSync(root).isDirectory()).toBe(true)
    expect(FirebasePersistenceRegistry.open(root, snapshot).diagnostic().classification)
      .toBe('fresh-v0.3.9-or-newer')
  })

  it('accepts a concurrent regular-directory mkdir winner', () => {
    const container = makeRoot('mkdir-race')
    const root = join(container, 'profile')

    const snapshot = detectPreexistingFirebaseProfile(root, {
      beforeRootCreate: () => mkdirSync(root, { recursive: true }),
    })

    expect(snapshot.kind).toBe('settings-absent')
    expect(lstatSync(root).isDirectory()).toBe(true)
  })

  it('rejects an attacker symlink winner during root creation', () => {
    const container = makeRoot('mkdir-symlink-race')
    const outside = makeRoot('mkdir-symlink-outside')
    const root = join(container, 'profile')
    let linked = false

    try {
      expect(() => detectPreexistingFirebaseProfile(root, {
        beforeRootCreate: () => {
          symlinkSync(outside, root, 'junction')
          linked = true
        },
      })).toThrow(/link|reparse/i)
    } catch (error) {
      if (!linked && (error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    expect(existsSync(join(root, FIREBASE_PERSISTENCE_REGISTRY_FILE))).toBe(false)
  })
})
