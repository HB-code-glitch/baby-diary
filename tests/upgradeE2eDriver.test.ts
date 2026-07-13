import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  UPGRADE_MODES,
  acquireWithTimeout,
  buildPackagedLaunchEnvironment,
  canonicalProfileForPlatform,
  closeElectronApplication,
  parseUpgradeCli,
  runUpgradePhase,
  sanitizeUpgradeDiagnostic,
  validateNonceOwnedPaths,
} from '../scripts/upgrade-e2e.mjs'
import {
  V038_SOURCE,
  getBabyInfoMutationKey,
  materializeMigratedBabyInfoJournal,
  projectUpgradeSemantics,
  writeV038Fixture,
} from '../scripts/upgrade-data-contract.mjs'

const roots: string[] = []
const RUN_ID = '0123456789abcdef0123456789abcdef'

function tempRunRoot(label = 'run') {
  const container = mkdtempSync(join(tmpdir(), `baby-diary-upgrade-test-${label}-`))
  roots.push(container)
  const root = join(container, `baby-diary-upgrade-${RUN_ID}`)
  mkdirSync(root)
  return root
}

function platformProfile(root: string) {
  if (process.platform === 'win32') {
    const appData = join(root, 'AppData', 'Roaming')
    mkdirSync(appData, { recursive: true })
    return { profileRoot: join(appData, 'baby-diary'), env: { APPDATA: appData } }
  }
  if (process.platform === 'darwin') {
    const home = join(root, 'home')
    mkdirSync(home)
    return {
      profileRoot: join(home, 'Library', 'Application Support', 'baby-diary'),
      env: { HOME: home },
    }
  }
  const home = join(root, 'home')
  const config = join(home, '.config')
  mkdirSync(config, { recursive: true })
  return { profileRoot: join(config, 'baby-diary'), env: { HOME: home, XDG_CONFIG_HOME: config } }
}

function runtimeViewFromProjection(projection: any, mode: string) {
  const sourceByContentId = new Map(
    projection.eventSources.map((item: any) => [item.contentId, JSON.parse(item.canonical)]),
  )
  const mutations = projection.babyInfo.mutations.map((item: any) => ({
    key: item.key,
    mutation: JSON.parse(item.canonical),
  }))
  const pendingKeys = new Set(projection.babyInfo.pendingKeys)
  const base = {
    identity: projection.identity,
    events: projection.eventWinners.map((item: any) => sourceByContentId.get(item.contentId)),
    dataInfoEventCount: projection.eventWinners.filter((item: any) => !item.deleted).length,
  }
  if (mode === 'baseline-initialize') {
    return {
      ...base,
      babyInfo: {
        kind: 'legacy-settings',
        mutations: mutations.map((item: any) => item.mutation),
        pendingKeys: projection.babyInfo.pendingKeys,
      },
    }
  }
  return {
    ...base,
    babyInfo: {
      kind: 'journal-ipc',
      hasLegacyBabyInfoSync: false,
      settingsJournal: { version: 1, projectedFamilyId: projection.identity.familyId },
      summary: {
        familyId: projection.identity.familyId,
        mutationCount: mutations.length,
        pendingCount: pendingKeys.size,
        totalPendingCount: pendingKeys.size,
      },
      pendingItems: mutations.filter((item: any) => pendingKeys.has(item.key)).map((item: any) => item.mutation),
      mutationEntries: mutations.map((item: any) => [item.key, item.mutation]),
    },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('packaged in-place upgrade driver', () => {
  it('disposes an Electron application that resolves only after the bounded launch timeout', async () => {
    let resolveApplication: ((value: { close: () => Promise<void> }) => void) | undefined
    let closeCount = 0
    const acquisition = new Promise<{ close: () => Promise<void> }>(resolvePromise => {
      resolveApplication = resolvePromise
    })
    const pending = acquireWithTimeout(
      acquisition,
      5,
      'late Electron launch',
      async application => application.close(),
    )
    await expect(pending).rejects.toMatchObject({ code: 'UPGRADE_TIMEOUT' })
    resolveApplication?.({ close: async () => { closeCount += 1 } })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
    expect(closeCount).toBe(1)
  })

  it('terminates and reaps the real Electron child when graceful close exceeds its bound', async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const child = {
      exitCode: null as number | null,
      signalCode: null as string | null,
      once(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, listener)
        return this
      },
      off(event: string) {
        listeners.delete(event)
        return this
      },
      kill(signal: string) {
        if (signal === 'SIGTERM') {
          this.signalCode = signal
          queueMicrotask(() => {
            listeners.get('exit')?.(null, signal)
            listeners.get('close')?.(null, signal)
          })
        }
        return true
      },
    }
    const application = {
      close: () => new Promise<void>(() => {}),
      process: () => child,
    }
    await expect(closeElectronApplication(application, 5)).rejects.toMatchObject({ code: 'UPGRADE_TIMEOUT' })
    expect(child.signalCode).toBe('SIGTERM')
  })

  it('wires the production renderer session to exact event and baby-info IPC discovery', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../scripts/upgrade-e2e.mjs'), 'utf8')
    expect(source).toContain('api.getSettings()')
    expect(source).toContain('api.listEvents()')
    expect(source).toContain('api.getBabyInfoSummary(settings.familyId)')
    expect(source).toContain('api.listPendingBabyInfo({')
    expect(source).toContain('api.getBabyInfoMutation(settings.familyId, key)')
    expect(source).toContain('materializeV038AuxiliaryFixture(owned.profileRoot)')
    expect(source).toContain('assertCandidateUiVisibility(page, rendererResult.publicView')
    expect(source).toContain('[data-event-id="legacy-formula"][data-event-rev="2"]')
    expect(source).toContain('[data-event-id="legacy-diary-tombstone"]')
    expect(source).toContain('[data-settings-language="ko"]')
    expect(source).toContain('[data-settings-language="ja"]')
    expect(source).toContain('[data-settings-baby-name]')
    expect(source).toContain('[data-settings-account-name]')
    expect(source).toContain('[data-sync-state]')
    expect(source).toContain('assertRuntimeDiscoverability(projection, runtime.publicView, options.mode)')
  })

  it('accepts exactly the three planned modes and rejects secret-bearing/unknown CLI input', () => {
    expect(UPGRADE_MODES).toEqual([
      'baseline-initialize',
      'candidate-first-run',
      'candidate-second-run',
    ])
    const parsed = parseUpgradeCli([
      '--mode', 'baseline-initialize',
      '--executable', '/tmp/Baby Diary',
      '--profile-root', '/tmp/run/profile',
      '--temp-root', '/tmp/run',
      '--run-id', RUN_ID,
      '--diagnostic', '/tmp/run/diagnostic.json',
      '--projection-output', '/tmp/run/baseline.json',
      '--source-sha', V038_SOURCE.commit,
      '--expected-version', '0.3.8',
      '--expected-arch', 'x64',
    ])
    expect(parsed.mode).toBe('baseline-initialize')
    expect(parsed.comparisonProjectionPath).toBeUndefined()
    expect(() => parseUpgradeCli(['--mode', 'manifest'])).toThrow(/mode|required/i)
    expect(() => parseUpgradeCli(['--password', 'do-not-log'])).toThrow(/unknown|secret/i)
    expect(() => parseUpgradeCli(['--mode', 'baseline-initialize', '--mode', 'candidate-first-run'])).toThrow(/duplicate/i)
  })

  it('derives the canonical OS profile leaf from APPDATA/HOME without a test userData override', () => {
    expect(canonicalProfileForPlatform('win32', { APPDATA: 'C:\\nonce\\Roaming' })).toBe(
      path.win32.resolve('C:\\nonce\\Roaming', 'baby-diary'),
    )
    expect(canonicalProfileForPlatform('darwin', { HOME: '/nonce/home' })).toBe(
      '/nonce/home/Library/Application Support/baby-diary',
    )
    expect(canonicalProfileForPlatform('linux', { HOME: '/nonce/home' })).toBe(
      '/nonce/home/.config/baby-diary',
    )

    const launchEnv = buildPackagedLaunchEnvironment({
      APPDATA: 'C:\\nonce\\Roaming',
      BABYDIARY_TEST_USERDATA: 'C:\\real-profile',
      FIREBASE_API_KEY: 'must-not-cross',
      NODE_ENV: 'test',
    })
    expect(launchEnv).not.toHaveProperty('BABYDIARY_TEST_USERDATA')
    expect(launchEnv).not.toHaveProperty('FIREBASE_API_KEY')
    expect(launchEnv.NODE_ENV).toBe('production')
    expect(launchEnv.APPDATA).toBe('C:\\nonce\\Roaming')
  })

  it('rejects outside, real/equal, nonce-mismatched, and linked profile roots', async () => {
    const root = tempRunRoot('paths')
    const { profileRoot } = platformProfile(root)
    const output = join(root, 'phase.json')
    await expect(validateNonceOwnedPaths({
      tempRoot: root,
      profileRoot,
      outputPaths: [output],
      runId: RUN_ID,
      forbiddenRoots: [],
    })).resolves.toMatchObject({ tempRoot: resolve(root), profileRoot: resolve(profileRoot) })

    await expect(validateNonceOwnedPaths({
      tempRoot: root,
      profileRoot: root,
      outputPaths: [output],
      runId: RUN_ID,
      forbiddenRoots: [],
    })).rejects.toThrow(/profile.*temp root|equal/i)
    await expect(validateNonceOwnedPaths({
      tempRoot: root,
      profileRoot: join(path.dirname(root), 'outside', 'baby-diary'),
      outputPaths: [output],
      runId: RUN_ID,
      forbiddenRoots: [],
    })).rejects.toThrow(/outside/i)
    await expect(validateNonceOwnedPaths({
      tempRoot: root,
      profileRoot,
      outputPaths: [output],
      runId: 'ffffffffffffffffffffffffffffffff',
      forbiddenRoots: [],
    })).rejects.toThrow(/nonce|run id/i)
    await expect(validateNonceOwnedPaths({
      tempRoot: root,
      profileRoot,
      outputPaths: [output],
      runId: RUN_ID,
      forbiddenRoots: [profileRoot],
    })).rejects.toThrow(/real|forbidden/i)

    const linkedTarget = join(root, 'linked-target')
    mkdirSync(linkedTarget)
    const linkedProfile = join(root, 'linked-profile')
    symlinkSync(linkedTarget, linkedProfile, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(validateNonceOwnedPaths({
      tempRoot: root,
      profileRoot: linkedProfile,
      outputPaths: [output],
      runId: RUN_ID,
      forbiddenRoots: [],
    })).rejects.toThrow(/link|reparse/i)
  })

  it('orchestrates baseline, first, and second phases with real on-disk projections', async () => {
    const root = tempRunRoot('phases')
    const { profileRoot, env } = platformProfile(root)
    const executablePath = join(root, process.platform === 'win32' ? 'Baby Diary.exe' : 'Baby Diary')
    writeFileSync(executablePath, 'packaged-candidate-bytes')
    const baselineProjection = join(root, 'baseline-projection.json')
    const firstProjection = join(root, 'first-projection.json')
    const secondProjection = join(root, 'second-projection.json')
    const launched: Array<Record<string, unknown>> = []
    const dependencies = {
      hashExecutable: async () => 'a'.repeat(64),
      runPackagedSession: async (context: Record<string, unknown>) => {
        launched.push(context)
        if (context.mode === 'baseline-initialize') await writeV038Fixture(profileRoot)
        if (context.mode !== 'baseline-initialize'
          && !existsSync(join(profileRoot, 'baby-info-journal-v1.jsonl'))) {
          await materializeMigratedBabyInfoJournal(profileRoot)
        }
        const projection = await projectUpgradeSemantics(profileRoot)
        return {
          appVersion: context.mode === 'baseline-initialize' ? '0.3.8' : '0.3.9',
          hostArchitecture: process.arch,
          canonicalUserDataPath: resolve(profileRoot),
          publicView: runtimeViewFromProjection(projection, String(context.mode)),
        }
      },
    }
    const common = {
      executablePath,
      profileRoot,
      tempRoot: root,
      runId: RUN_ID,
      sourceSha: V038_SOURCE.commit,
      expectedArch: process.arch,
      platform: process.platform,
      env,
      forbiddenRoots: [],
    }

    const baseline = await runUpgradePhase({
      ...common,
      mode: 'baseline-initialize',
      diagnosticPath: join(root, 'baseline-diagnostic.json'),
      projectionOutputPath: baselineProjection,
      expectedVersion: '0.3.8',
    }, dependencies)
    expect(baseline.passed).toBe(true)

    const first = await runUpgradePhase({
      ...common,
      mode: 'candidate-first-run',
      diagnosticPath: join(root, 'first-diagnostic.json'),
      projectionOutputPath: firstProjection,
      comparisonProjectionPath: baselineProjection,
      expectedVersion: '0.3.9',
    }, dependencies)
    expect(first.passed).toBe(true)

    const second = await runUpgradePhase({
      ...common,
      mode: 'candidate-second-run',
      diagnosticPath: join(root, 'second-diagnostic.json'),
      projectionOutputPath: secondProjection,
      comparisonProjectionPath: firstProjection,
      expectedVersion: '0.3.9',
    }, dependencies)
    expect(second.passed).toBe(true)
    expect(launched.map(item => item.mode)).toEqual(UPGRADE_MODES)
    expect(launched.every(item => item.executablePath === resolve(executablePath))).toBe(true)
    expect(existsSync(secondProjection)).toBe(true)
  })

  it('fails closed when candidate listEvents hides a current revision or tombstone that remains on disk', async () => {
    const root = tempRunRoot('runtime-events')
    const { profileRoot, env } = platformProfile(root)
    const executablePath = join(root, process.platform === 'win32' ? 'Baby Diary.exe' : 'Baby Diary')
    const baselineProjectionPath = join(root, 'baseline-projection.json')
    writeFileSync(executablePath, 'candidate')
    await writeV038Fixture(profileRoot)
    const baselineProjection = await projectUpgradeSemantics(profileRoot)
    writeFileSync(baselineProjectionPath, JSON.stringify(baselineProjection))
    await materializeMigratedBabyInfoJournal(profileRoot)
    const candidateProjection = await projectUpgradeSemantics(profileRoot)
    const publicView = runtimeViewFromProjection(candidateProjection, 'candidate-first-run')
    const staleVisibleRevision = JSON.parse(candidateProjection.eventSources.find(
      (item: any) => item.id === 'legacy-diary-tombstone' && item.rev === 1,
    ).canonical)
    publicView.events = publicView.events.map((item: any) => (
      item.id === 'legacy-diary-tombstone' ? staleVisibleRevision : item
    ))

    await expect(runUpgradePhase({
      mode: 'candidate-first-run',
      executablePath,
      profileRoot,
      tempRoot: root,
      runId: RUN_ID,
      diagnosticPath: join(root, 'diagnostic.json'),
      projectionOutputPath: join(root, 'candidate-projection.json'),
      comparisonProjectionPath: baselineProjectionPath,
      sourceSha: 'a'.repeat(40),
      expectedVersion: '0.3.9',
      expectedArch: process.arch,
      platform: process.platform,
      env,
      forbiddenRoots: [],
    }, {
      hashExecutable: async () => 'b'.repeat(64),
      runPackagedSession: async () => ({
        appVersion: '0.3.9',
        hostArchitecture: process.arch,
        canonicalUserDataPath: resolve(profileRoot),
        publicView,
      }),
    })).rejects.toThrow(/runtime|visible|listEvents|tombstone/i)
  })

  it('fails closed when candidate baby-info IPC hides acknowledged or pending originals', async () => {
    const root = tempRunRoot('runtime-baby-info')
    const { profileRoot, env } = platformProfile(root)
    const executablePath = join(root, process.platform === 'win32' ? 'Baby Diary.exe' : 'Baby Diary')
    const baselineProjectionPath = join(root, 'baseline-projection.json')
    writeFileSync(executablePath, 'candidate')
    await writeV038Fixture(profileRoot)
    const baselineProjection = await projectUpgradeSemantics(profileRoot)
    writeFileSync(baselineProjectionPath, JSON.stringify(baselineProjection))
    await materializeMigratedBabyInfoJournal(profileRoot)
    const candidateProjection = await projectUpgradeSemantics(profileRoot)
    const publicView = runtimeViewFromProjection(candidateProjection, 'candidate-first-run')
    const acknowledged = candidateProjection.babyInfo.acknowledgedKeys[0]
    publicView.babyInfo.mutationEntries = publicView.babyInfo.mutationEntries
      .filter(([key]: [string, unknown]) => key !== acknowledged)
    expect(getBabyInfoMutationKey(publicView.babyInfo.pendingItems[0]))
      .toBe(candidateProjection.babyInfo.pendingKeys[0])

    await expect(runUpgradePhase({
      mode: 'candidate-first-run',
      executablePath,
      profileRoot,
      tempRoot: root,
      runId: RUN_ID,
      diagnosticPath: join(root, 'diagnostic.json'),
      projectionOutputPath: join(root, 'candidate-projection.json'),
      comparisonProjectionPath: baselineProjectionPath,
      sourceSha: 'c'.repeat(40),
      expectedVersion: '0.3.9',
      expectedArch: process.arch,
      platform: process.platform,
      env,
      forbiddenRoots: [],
    }, {
      hashExecutable: async () => 'd'.repeat(64),
      runPackagedSession: async () => ({
        appVersion: '0.3.9',
        hostArchitecture: process.arch,
        canonicalUserDataPath: resolve(profileRoot),
        publicView,
      }),
    })).rejects.toThrow(/runtime|baby|acknowledged|mutation/i)
  })

  it('whitelists diagnostics and never persists a thrown secret-bearing message', async () => {
    const clean = sanitizeUpgradeDiagnostic({
      sourceSha: 'a'.repeat(40),
      executableSha256: 'b'.repeat(64),
      appVersion: '0.3.9',
      hostArchitecture: 'x64',
      canonicalUserDataPath: '/nonce/profile',
      fixtureProjectionHash: 'c'.repeat(64),
      phase: 'candidate-first-run',
      passed: true,
      password: 'must-disappear',
      firebaseApiKey: 'must-disappear',
    })
    expect(clean).not.toHaveProperty('password')
    expect(clean).not.toHaveProperty('firebaseApiKey')

    const root = tempRunRoot('failure')
    const { profileRoot, env } = platformProfile(root)
    const executablePath = join(root, process.platform === 'win32' ? 'Baby Diary.exe' : 'Baby Diary')
    const diagnosticPath = join(root, 'failure-diagnostic.json')
    writeFileSync(executablePath, 'candidate')
    await expect(runUpgradePhase({
      mode: 'baseline-initialize',
      executablePath,
      profileRoot,
      tempRoot: root,
      runId: RUN_ID,
      diagnosticPath,
      projectionOutputPath: join(root, 'projection.json'),
      sourceSha: V038_SOURCE.commit,
      expectedVersion: '0.3.8',
      expectedArch: process.arch,
      platform: process.platform,
      env,
      forbiddenRoots: [],
    }, {
      hashExecutable: async () => 'd'.repeat(64),
      runPackagedSession: async () => {
        throw new Error('password=hunter2 firebaseApiKey=never-persist')
      },
    })).rejects.toThrow(/password=hunter2/)
    const serialized = readFileSync(diagnosticPath, 'utf8')
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('never-persist')
    expect(JSON.parse(serialized)).toMatchObject({ phase: 'baseline-initialize', passed: false })
  })
})
