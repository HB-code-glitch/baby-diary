import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FIREBASE_AUTH_PORT,
  FIREBASE_CLI_VERSION,
  FIREBASE_PROJECT_ID,
  FIRESTORE_PORT,
  assertCleanDiagnostics,
  assertEmulatorEnvironment,
  buildFirebaseCliInvocation,
  buildSameRevisionConflicts,
  buildSeedSettings,
  isAllowedNetworkUrl,
  makeMutationDocId,
  normalizeConvergence,
  parseEmulatorAddress,
  readJavaMajor,
  resolvePackagedExecutable,
  selectMutationWinner,
} from '../scripts/sync-e2e.mjs'

describe('packaged cross-platform sync E2E runner contract', () => {
  it('pins demo-only Firebase 15.23.0 endpoints', () => {
    expect(FIREBASE_CLI_VERSION).toBe('15.23.0')
    expect(FIREBASE_PROJECT_ID).toBe('demo-baby-diary')
    expect(FIREBASE_AUTH_PORT).toBe(9099)
    expect(FIRESTORE_PORT).toBe(8080)

    expect(parseEmulatorAddress('localhost:9099', 'auth', 9099)).toEqual({
      host: '127.0.0.1',
      port: 9099,
    })
    expect(parseEmulatorAddress('127.0.0.1:8080', 'firestore', 8080)).toEqual({
      host: '127.0.0.1',
      port: 8080,
    })
    expect(() => parseEmulatorAddress('https://127.0.0.1:9099', 'auth', 9099)).toThrow()
    expect(() => parseEmulatorAddress('192.168.0.2:9099', 'auth', 9099)).toThrow()
    expect(() => parseEmulatorAddress('127.0.0.1:9199', 'auth', 9099)).toThrow()
  })

  it('refuses an inner run unless every fail-closed emulator variable matches', () => {
    const valid = {
      BABYDIARY_FIREBASE_EMULATOR: '1',
      BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID: FIREBASE_PROJECT_ID,
      FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${FIREBASE_AUTH_PORT}`,
      FIRESTORE_EMULATOR_HOST: `127.0.0.1:${FIRESTORE_PORT}`,
    }

    expect(assertEmulatorEnvironment(valid)).toEqual({
      projectId: FIREBASE_PROJECT_ID,
      auth: { host: '127.0.0.1', port: FIREBASE_AUTH_PORT },
      firestore: { host: '127.0.0.1', port: FIRESTORE_PORT },
    })
    expect(() => assertEmulatorEnvironment({ ...valid, BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID: 'production' })).toThrow(/demo-baby-diary/)
    expect(() => assertEmulatorEnvironment({ ...valid, FIRESTORE_EMULATOR_HOST: undefined })).toThrow(/FIRESTORE_EMULATOR_HOST/)
  })

  it('accepts Java 21 only and builds an exact versioned CLI invocation', () => {
    expect(readJavaMajor('openjdk version "21.0.7" 2025-04-15 LTS')).toBe(21)
    expect(readJavaMajor('java version "21"')).toBe(21)
    expect(readJavaMajor('openjdk version "17.0.12"')).toBe(17)
    expect(() => readJavaMajor('unknown runtime')).toThrow(/Java version/)

    const invocation = buildFirebaseCliInvocation({
      platform: 'win32',
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'D:\\Baby Diary\\scripts\\sync-e2e.mjs',
    })
    expect(invocation.command).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(invocation.args[0]).toMatch(/node_modules[\\/]npm[\\/]bin[\\/]npx-cli\.js$/)
    expect(invocation.args).toContain('firebase-tools@15.23.0')
    expect(invocation.args).toContain('--project')
    expect(invocation.args).toContain('demo-baby-diary')
    expect(invocation.args).toContain('--only')
    expect(invocation.args).toContain('auth,firestore')
    expect(invocation.args.at(-1)).toContain('--inside-emulators')
    expect(invocation.versionArgs).toContain('firebase-tools@15.23.0')
    expect(invocation.versionArgs.at(-1)).toBe('--version')
  })

  it('allows package resources and exact emulator ports but no other network', () => {
    expect(isAllowedNetworkUrl('file:///Baby%20Diary/resources/app.asar/dist/index.html')).toBe(true)
    expect(isAllowedNetworkUrl('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts')).toBe(true)
    expect(isAllowedNetworkUrl('http://localhost:8080/google.firestore.v1.Firestore/Listen/channel')).toBe(true)
    expect(isAllowedNetworkUrl('http://localhost:5173')).toBe(false)
    expect(isAllowedNetworkUrl('https://identitytoolkit.googleapis.com/v1/accounts')).toBe(false)
  })

  it('fails closed for every blocked request and renderer console error', () => {
    expect(() => assertCleanDiagnostics([], [])).not.toThrow()
    expect(() => assertCleanDiagnostics(
      ['A: https://identitytoolkit.googleapis.com/v1/accounts'],
      [],
    )).toThrow(/Blocked non-emulator network request/)
    expect(() => assertCleanDiagnostics([], ['B: unhandled sync error'])).toThrow(
      /Unexpected renderer error/,
    )
  })

  it('resolves only a packaged Windows or macOS executable', () => {
    const root = path.resolve('fixture root')
    const win = path.join(root, 'release', 'win-unpacked', 'Baby Diary.exe')
    const winResources = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar')
    const mac = path.join(root, 'release', 'mac-arm64', 'Baby Diary.app', 'Contents', 'MacOS', 'Baby Diary')
    const macResources = path.join(root, 'release', 'mac-arm64', 'Baby Diary.app', 'Contents', 'Resources', 'app.asar')
    const arbitraryBinary = path.join(root, 'tools', 'node.exe')
    const existing = new Set([win, winResources, mac, macResources, arbitraryBinary])
    const exists = (candidate: string) => existing.has(candidate)

    expect(resolvePackagedExecutable({ root, platform: 'win32', exists })).toBe(win)
    expect(resolvePackagedExecutable({ root, platform: 'darwin', exists })).toBe(mac)
    expect(() => resolvePackagedExecutable({ root, platform: 'linux', exists })).toThrow(/Windows.*macOS/)
    expect(() => resolvePackagedExecutable({ root, platform: 'win32', override: path.join(root, 'missing.exe'), exists })).toThrow(/Packaged executable/)
    expect(() => resolvePackagedExecutable({
      root,
      platform: 'win32',
      override: arbitraryBinary,
      exists,
    })).toThrow(/packaged Baby Diary/i)

    existing.delete(winResources)
    expect(() => resolvePackagedExecutable({ root, platform: 'win32', override: win, exists })).toThrow(/app\.asar/)
  })

  it('seeds isolated devices with the demo project and identical baby identity', () => {
    const a = buildSeedSettings('Device A')
    const b = buildSeedSettings('Device B')

    expect(a.firebase?.projectId).toBe(FIREBASE_PROJECT_ID)
    expect(b.firebase?.projectId).toBe(FIREBASE_PROJECT_ID)
    expect(a.baby).toEqual({ name: 'Sync Baby', birthdate: '2026-01-15' })
    expect(b.baby).toEqual(a.baby)
    expect(a.familyId).toBe('')
    expect(b.familyId).toBe('')
    expect(a.profile.name).toBe('Device A')
    expect(b.profile.name).toBe('Device B')
    expect(a.language).toBe('ko')
  })

  it('normalizes convergence by id/rev/deleted with tombstones winning ties', () => {
    expect(normalizeConvergence([
      { id: 'b', rev: 1, deleted: false },
      { id: 'a', rev: 1, deleted: false },
      { id: 'a', rev: 2, deleted: false },
      { id: 'b', rev: 1, deleted: true },
    ])).toEqual([
      { id: 'a', rev: 2, deleted: false },
      { id: 'b', rev: 1, deleted: true },
    ])
  })

  it('builds a deterministic same-id/rev conflict with different payloads', () => {
    const base = {
      id: 'shared-event',
      type: 'pee',
      at: '2026-07-13T08:00:00.000Z',
      data: {},
      author: { uid: 'account-a', name: 'A', role: 'mom' },
      createdAt: '2026-07-13T08:00:00.000Z',
      updatedAt: '2026-07-13T08:00:00.000Z',
      rev: 1,
      deleted: false,
    }

    const [a, b] = buildSameRevisionConflicts(base, 1_752_393_601_000)

    expect(a.id).toBe(base.id)
    expect(b.id).toBe(base.id)
    expect(a.rev).toBe(2)
    expect(b.rev).toBe(2)
    expect(a.deleted).toBe(false)
    expect(b.deleted).toBe(false)
    expect(a.at).not.toBe(b.at)
    expect(a.updatedAt).toBe(b.updatedAt)
    expect(a.mutationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(b.mutationId).toMatch(/^[0-9a-f-]{36}$/)
    expect(a.mutationId).not.toBe(b.mutationId)
    expect(selectMutationWinner([b, a])).toEqual(b)
    expect(selectMutationWinner([a, b])).toEqual(b)
    expect(normalizeConvergence([b, a])).toEqual([{
      id: base.id,
      rev: 2,
      deleted: false,
      mutationId: b.mutationId,
    }])
    expect(makeMutationDocId(a)).not.toBe(makeMutationDocId(b))
    expect(makeMutationDocId(a)).not.toContain('/')
  })

  it('configures Auth and Firestore emulators with the UI disabled', () => {
    const config = JSON.parse(readFileSync('firebase.json', 'utf8'))
    expect(config.emulators).toMatchObject({
      auth: { host: '127.0.0.1', port: FIREBASE_AUTH_PORT },
      firestore: { host: '127.0.0.1', port: FIRESTORE_PORT },
      ui: { enabled: false },
      singleProjectMode: true,
    })
  })
})
