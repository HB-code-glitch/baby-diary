import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path, { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  UPGRADE_MODES,
  V038_USERDATA_OVERRIDE_EVIDENCE,
  acquireWithTimeout,
  assertDistinctProfileIdentities,
  assertProfileFingerprintUnchanged,
  assertRuntimeDiscoverability,
  buildPackagedLaunchEnvironment,
  captureProfileFingerprintArtifact,
  closeElectronApplication,
  fingerprintProfileTree,
  mergeUpgradeNetworkEvidence,
  parseUpgradeCli,
  redactUpgradeProjection,
  resolveInteractiveProfileForPlatform,
  runUpgradePhase,
  sanitizeUpgradeDiagnostic,
  validateMainProcessAttestation,
  validateBaselineManifestArtifact,
  validateCompletedUpgradePhaseArtifacts,
  validateNonceOwnedPaths,
  validateV038UserDataOverrideContract,
  verifyProfileNonInterferenceArtifact,
} from '../scripts/upgrade-e2e.mjs'
import {
  V038_SOURCE,
  buildFixtureEventDerivative,
  canonicalJson,
  getBabyInfoMutationKey,
  materializeMigratedBabyInfoJournal,
  projectUpgradeSemantics,
  writeV038Fixture,
} from '../scripts/upgrade-data-contract.mjs'
import { V038_DEFAULT_FIREBASE_EVIDENCE } from '../scripts/upgrade-firebase-continuity.mjs'

const roots: string[] = []
const RUN_ID = '0123456789abcdef0123456789abcdef'
const REPOSITORY_ROOT = resolve(import.meta.dirname, '..')

function tempRunRoot(label = 'run') {
  const container = mkdtempSync(join(tmpdir(), `baby-diary-upgrade-test-${label}-`))
  roots.push(container)
  const root = join(container, `baby-diary-upgrade-${RUN_ID}`)
  mkdirSync(root)
  return root
}

function platformProfile(root: string) {
  const profileRoot = join(root, 'user-data', 'baby-diary')
  const interactiveRoot = join(path.dirname(root), 'interactive-profile')
  if (process.platform === 'win32') {
    const appData = join(interactiveRoot, 'AppData', 'Roaming')
    mkdirSync(appData, { recursive: true })
    return {
      profileRoot,
      interactiveProfileRoot: join(appData, 'baby-diary'),
      env: { APPDATA: appData },
    }
  }
  if (process.platform === 'darwin') {
    const home = join(interactiveRoot, 'home')
    mkdirSync(home, { recursive: true })
    return {
      profileRoot,
      interactiveProfileRoot: join(home, 'Library', 'Application Support', 'baby-diary'),
      env: { HOME: home },
    }
  }
  const home = join(interactiveRoot, 'home')
  const config = join(home, '.config')
  mkdirSync(config, { recursive: true })
  return {
    profileRoot,
    interactiveProfileRoot: join(config, 'baby-diary'),
    env: { HOME: home, XDG_CONFIG_HOME: config },
  }
}

function mainProcessAttestation(profileRoot: string, appVersion: string) {
  return {
    runId: RUN_ID,
    userDataPath: resolve(profileRoot),
    appVersion,
    hostArchitecture: process.arch,
    beforeUi: true,
  }
}

async function recordMainProcessAttestation(
  context: Record<string, any>,
  profileRoot: string,
  appVersion: string,
) {
  if (typeof context.onMainProcessAttestation !== 'function') {
    throw new Error('test session did not receive the attestation recorder')
  }
  await context.onMainProcessAttestation(mainProcessAttestation(profileRoot, appVersion))
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
    expect(source).toContain('writeV038FirebaseBootstrap(owned.profileRoot)')
    expect(source).toContain('startUpgradeDenyProxy()')
    expect(source).toContain('buildFailClosedChromiumArgs({ denyProxyPort: denyProxy.port })')
    expect(source).toContain('installCdpUpgradeNetworkGuard(page')
    expect(source).toContain('await page.addInitScript(installUpgradeAuthFormObserver)')
    expect(source).toContain(".lang-picker-card.lang-picker-card-visible")
    expect(source).toContain(".lang-picker-btn[lang=\"ko\"]")
    expect(source).toContain('validateUpgradeEmulatorEnvironment(env)')
    expect(source).toContain('assertUpgradeContinuity(comparisonEvidence.authSync, projection.authSync, options.mode)')
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
    expect(source).toContain('assertRuntimeDiscoverability(baseProjection, runtime.publicView, options.mode)')
  })

  it('persists only hashed real-auth continuity and rejects candidate signup/signed-out fallback', async () => {
    const root = tempRunRoot('auth-continuity')
    const { profileRoot, env } = platformProfile(root)
    const executablePath = join(root, process.platform === 'win32' ? 'Baby Diary.exe' : 'Baby Diary')
    const baselineProjectionPath = join(root, 'baseline-projection.json')
    const baselineDiagnosticPath = join(root, 'baseline-diagnostic.json')
    writeFileSync(executablePath, 'candidate')
    await writeV038Fixture(profileRoot)
    const projection = await projectUpgradeSemantics(profileRoot)
    const sourceByContentId = new Map(
      projection.eventSources.map((item: any) => [item.contentId, JSON.parse(item.canonical)]),
    )
    const onlineEvent = sourceByContentId.get(projection.eventWinners.find((item: any) => item.id === 'legacy-pee').contentId)
    const pendingEvent = sourceByContentId.get(projection.eventWinners.find((item: any) => item.id === 'legacy-poop').contentId)
    const commonContinuity = {
      uid: projection.identity.account.uid,
      email: 'upgrade-parent@example.test',
      familyId: projection.identity.familyId,
      inviteCode: 'ABC234',
      memberUids: [projection.identity.account.uid],
      onlineEvent,
      pendingEvent,
    }
    const runtimeBase = {
      appVersion: '0.3.8',
      hostArchitecture: process.arch,
      canonicalUserDataPath: resolve(profileRoot),
      publicView: runtimeViewFromProjection(projection, 'baseline-initialize'),
    }

    await runUpgradePhase({
      mode: 'baseline-initialize',
      executablePath,
      profileRoot,
      tempRoot: root,
      runId: RUN_ID,
      diagnosticPath: baselineDiagnosticPath,
      projectionOutputPath: baselineProjectionPath,
      sourceSha: V038_SOURCE.commit,
      expectedVersion: '0.3.8',
      expectedArch: process.arch,
      platform: process.platform,
      env,
      forbiddenRoots: [],
    }, {
      hashExecutable: async () => 'a'.repeat(64),
      validateV038Fixture: async () => projection,
      runPackagedSession: async (context: Record<string, any>) => {
        await recordMainProcessAttestation(context, profileRoot, '0.3.8')
        expect(JSON.parse(readFileSync(baselineDiagnosticPath, 'utf8'))).toMatchObject({
          passed: false,
          processReportedRunId: RUN_ID,
          canonicalUserDataPath: resolve(profileRoot),
          attestationBeforeUi: true,
          baselineUserDataOverrideEvidence: V038_USERDATA_OVERRIDE_EVIDENCE,
        })
        return {
          ...runtimeBase,
          continuity: {
            ...commonContinuity,
            pendingCount: 1,
            cloudPendingCopies: 0,
            authFormVisible: false,
            signupAttempted: true,
          },
        }
      },
    })
    const baselineWritten = JSON.parse(readFileSync(baselineProjectionPath, 'utf8'))
    expect(baselineWritten.authSync).toMatchObject({
      uidSha256: createHash('sha256').update(projection.identity.account.uid).digest('hex'),
      familyIdSha256: createHash('sha256').update(projection.identity.familyId).digest('hex'),
      pendingCount: 1,
      cloudPendingCopies: 0,
      signupAttempted: true,
    })
    const persistedAuth = JSON.stringify(baselineWritten.authSync)
    for (const forbidden of [
      projection.identity.account.uid,
      projection.identity.familyId,
      'upgrade-parent@example.test',
      'ABC234',
      onlineEvent.id,
      pendingEvent.id,
    ]) expect(persistedAuth).not.toContain(forbidden)

    await expect(runUpgradePhase({
      mode: 'candidate-first-run',
      executablePath,
      profileRoot,
      tempRoot: root,
      runId: RUN_ID,
      diagnosticPath: join(root, 'candidate-diagnostic.json'),
      projectionOutputPath: join(root, 'candidate-projection.json'),
      comparisonProjectionPath: baselineProjectionPath,
      sourceSha: 'b'.repeat(40),
      expectedVersion: '0.3.9',
      expectedArch: process.arch,
      platform: process.platform,
      env,
      forbiddenRoots: [],
    }, {
      hashExecutable: async () => 'b'.repeat(64),
      projectUpgradeSemantics: async () => projection,
      runPackagedSession: async (context: Record<string, any>) => {
        await recordMainProcessAttestation(context, profileRoot, '0.3.9')
        return {
          ...runtimeBase,
          appVersion: '0.3.9',
          publicView: runtimeViewFromProjection(projection, 'candidate-first-run'),
          continuity: {
            ...commonContinuity,
            pendingCount: 0,
            cloudPendingCopies: 1,
            authFormVisible: true,
            signupAttempted: true,
            secondDevice: {
              uid: 'device-two',
              familyId: projection.identity.familyId,
              convergedEventIds: [onlineEvent.id, pendingEvent.id],
            },
          },
        }
      },
    })).rejects.toThrow(/auth|signup|restore/i)
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

  it('accepts a quote-safe, strict phase-env entrypoint without accepting arbitrary environment fields', () => {
    const env = {
      APPDATA: 'C:\\nonce\\Roaming',
      BABYDIARY_UPGRADE_PHASE_MODE: 'baseline-initialize',
      BABYDIARY_UPGRADE_PHASE_EXECUTABLE: 'C:\\Program Files\\Baby Diary\\Baby Diary.exe',
      BABYDIARY_UPGRADE_PHASE_PROFILE_ROOT: 'C:\\nonce\\Roaming\\baby-diary',
      BABYDIARY_UPGRADE_PHASE_TEMP_ROOT: 'C:\\nonce',
      BABYDIARY_UPGRADE_PHASE_RUN_ID: RUN_ID,
      BABYDIARY_UPGRADE_PHASE_DIAGNOSTIC: 'C:\\nonce\\diagnostic.json',
      BABYDIARY_UPGRADE_PHASE_PROJECTION_OUTPUT: 'C:\\nonce\\baseline.json',
      BABYDIARY_UPGRADE_PHASE_SOURCE_SHA: V038_SOURCE.commit,
      BABYDIARY_UPGRADE_PHASE_EXPECTED_VERSION: '0.3.8',
      BABYDIARY_UPGRADE_PHASE_EXPECTED_ARCH: 'x64',
      PASSWORD: 'must-not-become-an-option',
    }

    const parsed = parseUpgradeCli(['phase-env'], env, 'win32')
    expect(parsed).toMatchObject({
      mode: 'baseline-initialize',
      executablePath: env.BABYDIARY_UPGRADE_PHASE_EXECUTABLE,
      profileRoot: env.BABYDIARY_UPGRADE_PHASE_PROFILE_ROOT,
      tempRoot: env.BABYDIARY_UPGRADE_PHASE_TEMP_ROOT,
      runId: RUN_ID,
      platform: 'win32',
      env,
    })
    expect(parsed).not.toHaveProperty('password')
    expect(() => parseUpgradeCli(['phase-env', '--mode'], env, 'win32')).toThrow(/phase-env|exact/i)
    expect(() => parseUpgradeCli(['phase-env'], {
      ...env,
      BABYDIARY_UPGRADE_PHASE_MODE: 'candidate-first-run',
    }, 'win32')).toThrow(/comparison projection/i)
  })

  it('executes rather than silently succeeding through a junction entrypoint with preserve-symlinks-main', () => {
    const runRoot = tempRunRoot('junction-entrypoint')
    const linkedRepository = join(runRoot, 'repo-entry')
    symlinkSync(REPOSITORY_ROOT, linkedRepository, process.platform === 'win32' ? 'junction' : 'dir')
    const cleanEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith('BABYDIARY_UPGRADE_PHASE_')))
    const result = spawnSync(process.execPath, [
      '--preserve-symlinks-main',
      join(linkedRepository, 'scripts', 'upgrade-e2e.mjs'),
      'phase-env',
    ], { cwd: runRoot, env: cleanEnv, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('[upgrade-e2e] FAIL')
  })

  it('independently resolves the interactive profile while forcing the nonce profile through the test override', () => {
    expect(resolveInteractiveProfileForPlatform('win32', { APPDATA: 'C:\\interactive\\Roaming' })).toBe(
      path.win32.resolve('C:\\interactive\\Roaming', 'baby-diary'),
    )
    expect(resolveInteractiveProfileForPlatform('darwin', { HOME: '/interactive/home' })).toBe(
      '/interactive/home/Library/Application Support/baby-diary',
    )
    expect(resolveInteractiveProfileForPlatform('linux', { HOME: '/interactive/home' })).toBe(
      '/interactive/home/.config/baby-diary',
    )

    const launchEnv = buildPackagedLaunchEnvironment({
      APPDATA: 'C:\\interactive\\Roaming',
      BABYDIARY_TEST_USERDATA: 'C:\\real-profile',
      BABYDIARY_UPGRADE_ATTEST_RUN_ID: 'f'.repeat(32),
      BABYDIARY_UPGRADE_PHASE_TEMP_ROOT: 'C:\\nonce',
      BABYDIARY_UPGRADE_RULES_ROOT: 'C:\\rules',
      FIREBASE_API_KEY: 'must-not-cross',
      NODE_ENV: 'test',
    }, {
      profileRoot: 'C:\\nonce\\user-data\\baby-diary',
      runId: RUN_ID,
    })
    expect(launchEnv.BABYDIARY_TEST_USERDATA).toBe(path.resolve('C:\\nonce\\user-data\\baby-diary'))
    expect(launchEnv.BABYDIARY_UPGRADE_ATTEST_RUN_ID).toBe(RUN_ID)
    expect(launchEnv).not.toHaveProperty('BABYDIARY_UPGRADE_PHASE_TEMP_ROOT')
    expect(launchEnv).not.toHaveProperty('BABYDIARY_UPGRADE_RULES_ROOT')
    expect(launchEnv).not.toHaveProperty('FIREBASE_API_KEY')
    expect(launchEnv.NODE_ENV).toBe('production')
    expect(launchEnv.APPDATA).toBe('C:\\interactive\\Roaming')
    expect(() => buildPackagedLaunchEnvironment({}, {
      profileRoot: '',
      runId: RUN_ID,
    })).toThrow(/profile/i)
  })

  it('rejects outside, interactive/equal or contained, nonce-mismatched, and linked profile roots', async () => {
    const root = tempRunRoot('paths')
    const { profileRoot, interactiveProfileRoot } = platformProfile(root)
    const output = join(root, 'phase.json')
    await expect(validateNonceOwnedPaths({
      tempRoot: root,
      profileRoot,
      interactiveProfileRoot,
      outputPaths: [output],
      runId: RUN_ID,
      forbiddenRoots: [],
    })).resolves.toMatchObject({ tempRoot: resolve(root), profileRoot: resolve(profileRoot) })

    await expect(validateNonceOwnedPaths({
      tempRoot: root,
      profileRoot: root,
      interactiveProfileRoot,
      outputPaths: [output],
      runId: RUN_ID,
      forbiddenRoots: [],
    })).rejects.toThrow(/profile.*temp root|equal/i)
    await expect(validateNonceOwnedPaths({
      tempRoot: root,
      profileRoot: join(path.dirname(root), 'outside', 'baby-diary'),
      interactiveProfileRoot,
      outputPaths: [output],
      runId: RUN_ID,
      forbiddenRoots: [],
    })).rejects.toThrow(/outside/i)
    await expect(validateNonceOwnedPaths({
      tempRoot: root,
      profileRoot,
      interactiveProfileRoot,
      outputPaths: [output],
      runId: 'ffffffffffffffffffffffffffffffff',
      forbiddenRoots: [],
    })).rejects.toThrow(/nonce|run id/i)
    await expect(validateNonceOwnedPaths({
      tempRoot: root,
      profileRoot,
      interactiveProfileRoot,
      outputPaths: [output],
      runId: RUN_ID,
      forbiddenRoots: [profileRoot],
    })).rejects.toThrow(/real|forbidden/i)

    await expect(validateNonceOwnedPaths({
      tempRoot: root,
      profileRoot,
      interactiveProfileRoot: join(root, 'user-data'),
      outputPaths: [output],
      runId: RUN_ID,
      forbiddenRoots: [],
    })).rejects.toThrow(/interactive|contain/i)

    const linkedTarget = join(root, 'linked-target')
    mkdirSync(linkedTarget)
    mkdirSync(join(root, 'user-data'), { recursive: true })
    const linkedProfile = profileRoot
    symlinkSync(linkedTarget, linkedProfile, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(validateNonceOwnedPaths({
      tempRoot: root,
      profileRoot: linkedProfile,
      interactiveProfileRoot,
      outputPaths: [output],
      runId: RUN_ID,
      forbiddenRoots: [],
    })).rejects.toThrow(/link|reparse/i)
    rmSync(linkedProfile, { recursive: true, force: true })

    const interactiveTarget = join(path.dirname(root), 'interactive-target')
    mkdirSync(interactiveTarget)
    const linkedInteractive = join(path.dirname(root), 'interactive-linked')
    symlinkSync(interactiveTarget, linkedInteractive, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(validateNonceOwnedPaths({
      tempRoot: root,
      profileRoot,
      interactiveProfileRoot: linkedInteractive,
      outputPaths: [output],
      runId: RUN_ID,
      forbiddenRoots: [],
    })).rejects.toThrow(/interactive|link|reparse/i)

    expect(() => assertDistinctProfileIdentities({
      nonceProfileRoot: profileRoot,
      interactiveProfileRoot,
      nonceIdentity: { dev: 7n, ino: 9n },
      interactiveIdentity: { dev: 7n, ino: 9n },
    })).toThrow(/same.*inode|identity/i)
  })

  it('pins the exact v0.3.8 main-process bytes that implement the userData override', async () => {
    expect(V038_USERDATA_OVERRIDE_EVIDENCE).toEqual({
      sourceSha: V038_SOURCE.commit,
      sourcePath: 'electron/main.ts',
      blobSha1: '5c578300008b8a005fcc72110d9817feca3d626e',
      byteLength: 10125,
      bytesSha256: 'da05cc989892d0d575be601be6c8e4ca7b456074ee40d5d18545f182987fd7d1',
      environmentVariable: 'BABYDIARY_TEST_USERDATA',
    })
    await expect(validateV038UserDataOverrideContract({ repositoryRoot: REPOSITORY_ROOT }))
      .resolves.toEqual(V038_USERDATA_OVERRIDE_EVIDENCE)
  })

  it('accepts only a pre-UI, process-reported run-id and userData attestation', () => {
    const profileRoot = resolve('nonce-owned', 'user-data', 'baby-diary')
    expect(validateMainProcessAttestation(mainProcessAttestation(profileRoot, '0.3.8'), {
      profileRoot,
      runId: RUN_ID,
      expectedVersion: '0.3.8',
      expectedArch: process.arch,
    })).toEqual(mainProcessAttestation(profileRoot, '0.3.8'))
    expect(() => validateMainProcessAttestation({
      ...mainProcessAttestation(profileRoot, '0.3.8'),
      runId: 'f'.repeat(32),
    }, {
      profileRoot,
      runId: RUN_ID,
      expectedVersion: '0.3.8',
      expectedArch: process.arch,
    })).toThrow(/process.*run.?id|attestation/i)
    expect(() => validateMainProcessAttestation({
      ...mainProcessAttestation(profileRoot, '0.3.8'),
      beforeUi: false,
    }, {
      profileRoot,
      runId: RUN_ID,
      expectedVersion: '0.3.8',
      expectedArch: process.arch,
    })).toThrow(/before.*UI|pre-UI/i)
  })

  it('fingerprints the interactive profile before creating the nonce root and proves non-interference', async () => {
    const container = mkdtempSync(join(tmpdir(), 'baby-diary-profile-fingerprint-'))
    roots.push(container)
    const interactiveProfileRoot = join(container, 'interactive', 'baby-diary')
    mkdirSync(join(interactiveProfileRoot, 'data'), { recursive: true })
    writeFileSync(join(interactiveProfileRoot, 'settings.json'), '{"language":"ko"}\n')
    writeFileSync(join(interactiveProfileRoot, 'data', 'events-2026-07.jsonl'), '{"id":"real"}\n')
    const plannedRoot = join(container, `baby-diary-upgrade-${RUN_ID}`)
    const beforePath = join(plannedRoot, 'interactive-profile-before.json')
    const afterPath = join(plannedRoot, 'interactive-profile-after.json')

    expect(existsSync(plannedRoot)).toBe(false)
    const directBefore = await fingerprintProfileTree(interactiveProfileRoot)
    const captured = await captureProfileFingerprintArtifact({
      interactiveProfileRoot,
      tempRoot: plannedRoot,
      runId: RUN_ID,
      outputPath: beforePath,
    })
    expect(existsSync(plannedRoot)).toBe(true)
    expect(captured).toMatchObject({ version: 1, stage: 'before', runId: RUN_ID, fingerprint: directBefore })
    const unchanged = await verifyProfileNonInterferenceArtifact({
      interactiveProfileRoot,
      tempRoot: plannedRoot,
      runId: RUN_ID,
      beforePath,
      outputPath: afterPath,
    })
    expect(unchanged).toMatchObject({ version: 1, stage: 'after', runId: RUN_ID, unchanged: true })
    expect(() => assertProfileFingerprintUnchanged(directBefore, {
      ...directBefore,
      treeSha256: 'f'.repeat(64),
    })).toThrow(/interactive profile.*changed|non-interference/i)

    writeFileSync(join(interactiveProfileRoot, 'settings.json'), '{"language":"ja"}\n')
    await expect(verifyProfileNonInterferenceArtifact({
      interactiveProfileRoot,
      tempRoot: plannedRoot,
      runId: RUN_ID,
      beforePath,
      outputPath: afterPath,
    })).rejects.toThrow(/interactive profile.*changed|non-interference/i)
    expect(JSON.parse(readFileSync(afterPath, 'utf8'))).toMatchObject({ unchanged: false })
  })

  it('rejects child-code-zero false positives unless bound phase artifacts, profile, network proof, and manifest exist', async () => {
    const root = tempRunRoot('artifact-verification')
    const { profileRoot } = platformProfile(root)
    await writeV038Fixture(profileRoot)
    const projectionPath = join(root, 'baseline-projection.json')
    const diagnosticPath = join(root, 'baseline-diagnostic.json')
    const manifestPath = join(root, 'baseline-raw-manifest.json')
    const rawProjection = await projectUpgradeSemantics(profileRoot)
    const projection = {
      ...redactUpgradeProjection(rawProjection),
      authSync: {
        version: 2,
        uidSha256: '1'.repeat(64),
        emailSha256: '2'.repeat(64),
        familyIdSha256: '3'.repeat(64),
        inviteCodeSha256: '4'.repeat(64),
        memberUidSha256s: ['1'.repeat(64)],
        onlineEvent: { idSha256: '5'.repeat(64), rev: 1, deleted: false, semanticSha256: '6'.repeat(64) },
        pendingEvent: { idSha256: '7'.repeat(64), rev: 1, deleted: false, semanticSha256: '8'.repeat(64) },
        pendingCount: 1,
        cloudPendingCopies: 0,
        authFormVisible: false,
        signupAttempted: true,
      },
    }
    writeFileSync(projectionPath, JSON.stringify(projection))
    writeFileSync(diagnosticPath, JSON.stringify(sanitizeUpgradeDiagnostic({
      runId: RUN_ID,
      sourceSha: V038_SOURCE.commit,
      executableSha256: 'a'.repeat(64),
      executableSize: 181185024,
      appVersion: '0.3.8',
      hostArchitecture: process.arch,
      canonicalUserDataPath: resolve(profileRoot),
      processReportedRunId: RUN_ID,
      attestationBeforeUi: true,
      baselineUserDataOverrideEvidence: V038_USERDATA_OVERRIDE_EVIDENCE,
      fixtureProjectionHash: 'b'.repeat(64),
      firebaseSettingsEvidence: {
        settingsBytesSha256: 'e'.repeat(64),
        configSha256: V038_DEFAULT_FIREBASE_EVIDENCE.configSha256,
        apiKeySha256: V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256,
        configMatchesExactTag: true,
      },
      phase: 'baseline-initialize',
      passed: true,
      networkEvidence: {
        rewrittenAuth: 1,
        rewrittenPasswordPolicy: 1,
        rewrittenFirestore: 2,
        runtimeRequestKeySha256: V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256,
        expectedOfflineBlocks: 1,
        externalBlocks: 0,
      },
    })))
    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      entries: [
        { path: 'settings.json', type: 'file', size: 10, sha256: 'c'.repeat(64) },
        { path: 'data', type: 'directory' },
        { path: 'data/events-2026-07.jsonl', type: 'file', size: 10, sha256: 'd'.repeat(64) },
      ],
    }))
    const options = {
      runId: RUN_ID,
      mode: 'baseline-initialize',
      expectedVersion: '0.3.8',
      expectedArch: process.arch,
      sourceSha: V038_SOURCE.commit,
      diagnosticPath,
      projectionPath,
      profileRoot,
    }

    await expect(validateCompletedUpgradePhaseArtifacts(options)).resolves.toMatchObject({
      runId: RUN_ID,
      phase: 'baseline-initialize',
    })
    await expect(validateBaselineManifestArtifact({ manifestPath })).resolves.toMatchObject({ entryCount: 3 })

    writeFileSync(diagnosticPath, '')
    await expect(validateCompletedUpgradePhaseArtifacts(options)).rejects.toThrow(/diagnostic|empty|JSON/i)
    writeFileSync(diagnosticPath, JSON.stringify(sanitizeUpgradeDiagnostic({
      runId: 'f'.repeat(32),
      sourceSha: V038_SOURCE.commit,
      executableSha256: 'a'.repeat(64),
      executableSize: 181185024,
      appVersion: '0.3.8',
      hostArchitecture: process.arch,
      canonicalUserDataPath: resolve(profileRoot),
      processReportedRunId: 'f'.repeat(32),
      attestationBeforeUi: true,
      baselineUserDataOverrideEvidence: V038_USERDATA_OVERRIDE_EVIDENCE,
      fixtureProjectionHash: 'b'.repeat(64),
      firebaseSettingsEvidence: {
        settingsBytesSha256: 'e'.repeat(64),
        configSha256: V038_DEFAULT_FIREBASE_EVIDENCE.configSha256,
        apiKeySha256: V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256,
        configMatchesExactTag: true,
      },
      phase: 'baseline-initialize',
      passed: true,
      networkEvidence: {
        rewrittenAuth: 1,
        rewrittenPasswordPolicy: 1,
        rewrittenFirestore: 1,
        runtimeRequestKeySha256: V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256,
        expectedOfflineBlocks: 1,
        externalBlocks: 0,
      },
    })))
    await expect(validateCompletedUpgradePhaseArtifacts(options)).rejects.toThrow(/run id|run-id/i)
    writeFileSync(manifestPath, JSON.stringify({ version: 1, entries: [] }))
    await expect(validateBaselineManifestArtifact({ manifestPath })).rejects.toThrow(/manifest|empty|entries/i)
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
        const version = context.mode === 'baseline-initialize' ? '0.3.8' : '0.3.9'
        await recordMainProcessAttestation(context, profileRoot, version)
        return {
          appVersion: version,
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
      runPackagedSession: async (context: Record<string, any>) => {
        await recordMainProcessAttestation(context, profileRoot, '0.3.9')
        return {
          appVersion: '0.3.9',
          hostArchitecture: process.arch,
          canonicalUserDataPath: resolve(profileRoot),
          publicView,
        }
      },
    })).rejects.toThrow(/runtime|visible|listEvents|tombstone/i)
  })

  it('accepts only a projected auth-bound derivative as the visible form of its retained source', async () => {
    const root = tempRunRoot('runtime-derivative')
    const { profileRoot } = platformProfile(root)
    await writeV038Fixture(profileRoot)
    await materializeMigratedBabyInfoJournal(profileRoot)
    const projection = await projectUpgradeSemantics(profileRoot)
    const derivative = buildFixtureEventDerivative()
    const derivativeCanonical = canonicalJson(derivative)
    projection.eventDerivatives.push({
      mutationId: derivative.mutationId,
      sourceContentId: derivative.migration.sourceContentId,
      canonicalHash: createHash('sha256').update(derivativeCanonical).digest('hex'),
    })
    const publicView = runtimeViewFromProjection(projection, 'candidate-first-run')
    publicView.events = publicView.events.map((event: any) => (
      event.id === derivative.id ? derivative : event
    ))
    expect(() => assertRuntimeDiscoverability(projection, publicView, 'candidate-first-run')).not.toThrow()

    publicView.events = publicView.events.map((event: any) => (
      event.id === derivative.id ? { ...event, mutationId: 'substituted' } : event
    ))
    expect(() => assertRuntimeDiscoverability(projection, publicView, 'candidate-first-run'))
      .toThrow(/substituted|derivative|source/i)
  })

  it('persists only hashed identity/event payload evidence while retaining deterministic comparisons', async () => {
    const root = tempRunRoot('redacted-projection')
    const { profileRoot } = platformProfile(root)
    await writeV038Fixture(profileRoot)
    const raw = await projectUpgradeSemantics(profileRoot)
    const redacted = redactUpgradeProjection(raw)
    const serialized = JSON.stringify(redacted)
    const firstEvent = JSON.parse(raw.eventSources[0].canonical)

    expect(redacted).toMatchObject({ evidenceSchemaVersion: 2, version: 1 })
    expect(redacted.identity).toEqual({ semanticSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(redacted.eventSources[0]).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{64}$/),
      canonical: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    for (const forbidden of [
      raw.identity.account.uid,
      raw.identity.familyId,
      raw.eventSources[0].id,
      firstEvent.author.uid,
    ]) expect(serialized).not.toContain(forbidden)
    expect(redactUpgradeProjection(redacted)).toEqual(redacted)
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
      runPackagedSession: async (context: Record<string, any>) => {
        await recordMainProcessAttestation(context, profileRoot, '0.3.9')
        return {
          appVersion: '0.3.9',
          hostArchitecture: process.arch,
          canonicalUserDataPath: resolve(profileRoot),
          publicView,
        }
      },
    })).rejects.toThrow(/runtime|baby|acknowledged|mutation/i)
  })

  it('whitelists diagnostics and never persists a thrown secret-bearing message', async () => {
    const clean = sanitizeUpgradeDiagnostic({
      runId: RUN_ID,
      sourceSha: 'a'.repeat(40),
      executableSha256: 'b'.repeat(64),
      executableSize: 123,
      appVersion: '0.3.9',
      hostArchitecture: 'x64',
      canonicalUserDataPath: '/nonce/profile',
      fixtureProjectionHash: 'c'.repeat(64),
      firebaseSettingsEvidence: {
        settingsBytesSha256: 'd'.repeat(64),
        configSha256: V038_DEFAULT_FIREBASE_EVIDENCE.configSha256,
        apiKeySha256: V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256,
        configMatchesExactTag: true,
      },
      phase: 'candidate-first-run',
      passed: true,
      networkEvidence: {
        rewrittenFirestore: 3,
        externalBlocks: 1,
        runtimeRequestKeySha256: V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256,
        firstExternalBlock: {
          host: 'identity-toolkit',
          pathname: '/v2/passwordPolicy',
          method: 'POST',
          queryParameterNames: ['clientType', 'key'],
          configuredDemoKeyEquality: false,
          requestKeySha256: 'a'.repeat(64),
          hasFragment: false,
          hasUserInfo: false,
          blockReason: 'identity-request-shape',
          rawUrl: 'https://must-disappear.example/?token=must-disappear',
        },
      },
      failureUiState: {
        familyChoiceVisible: true,
        createSubmitVisible: true,
        createSubmitDisabled: false,
        errorClassPresent: true,
        inviteVisible: false,
        domText: 'must-disappear',
      },
      password: 'must-disappear',
      firebaseApiKey: 'must-disappear',
    })
    expect(clean).not.toHaveProperty('password')
    expect(clean).not.toHaveProperty('firebaseApiKey')
    expect(clean).toMatchObject({
      schemaVersion: 2,
      runId: RUN_ID,
      executableSize: 123,
      firebaseSettingsEvidence: {
        settingsBytesSha256: 'd'.repeat(64),
        configSha256: V038_DEFAULT_FIREBASE_EVIDENCE.configSha256,
        apiKeySha256: V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256,
        configMatchesExactTag: true,
      },
      networkEvidence: {
        rewrittenFirestore: 3,
        externalBlocks: 1,
        runtimeRequestKeySha256: V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256,
        firstExternalBlock: {
          host: 'identity-toolkit',
          pathname: '/v2/passwordPolicy',
          method: 'POST',
          queryParameterNames: ['clientType', 'key'],
          configuredDemoKeyEquality: false,
          requestKeySha256: 'a'.repeat(64),
          hasFragment: false,
          hasUserInfo: false,
          blockReason: 'identity-request-shape',
        },
      },
      failureUiState: {
        familyChoiceVisible: true,
        createSubmitVisible: true,
        createSubmitDisabled: false,
        errorClassPresent: true,
        inviteVisible: false,
      },
    })
    expect(JSON.stringify(clean)).not.toContain('must-disappear')

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
      runPackagedSession: async (context: Record<string, any>) => {
        await recordMainProcessAttestation(context, profileRoot, '0.3.8')
        throw new Error('password=hunter2 firebaseApiKey=never-persist')
      },
    })).rejects.toThrow(/password=hunter2/)
    const serialized = readFileSync(diagnosticPath, 'utf8')
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('never-persist')
    expect(JSON.parse(serialized)).toMatchObject({ phase: 'baseline-initialize', passed: false })
  })

  it('sums network counters while retaining the first value-free blocked-request shape', () => {
    const firstExternalBlock = {
      host: 'identity-toolkit',
      pathname: '/v2/passwordPolicy',
      method: 'POST',
      queryParameterNames: ['clientType', 'key', 'version'],
      configuredDemoKeyEquality: true,
      requestKeySha256: 'a'.repeat(64),
      hasFragment: false,
      hasUserInfo: false,
      blockReason: 'identity-request-shape',
    }
    expect(mergeUpgradeNetworkEvidence([
      {
        rewrittenAuth: 1,
        externalBlocks: 1,
        runtimeRequestKeySha256: V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256,
        firstExternalBlock,
      },
      {
        rewrittenAuth: 2,
        rewrittenFirestore: 3,
        externalBlocks: 0,
        runtimeRequestKeySha256: V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256,
      },
    ])).toEqual({
      rewrittenAuth: 3,
      rewrittenFirestore: 3,
      externalBlocks: 1,
      runtimeRequestKeySha256: V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256,
      firstExternalBlock,
    })
  })
})
