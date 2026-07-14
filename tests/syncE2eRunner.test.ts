import { EventEmitter } from 'node:events'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FIREBASE_AUTH_PORT,
  FIREBASE_CLI_VERSION,
  FIREBASE_PROJECT_ID,
  FIRESTORE_PORT,
  assertCleanDiagnostics,
  assertEmulatorEnvironment,
  assertPackagedRuntimeAttestation,
  attachRendererDiagnostics,
  buildFirebaseCliInvocation,
  buildExpectedDeletedEvent,
  buildExpectedEditedEvent,
  buildSameRevisionConflicts,
  buildSeedSettings,
  classifyFirstLaunchState,
  cleanupPartialDevice,
  closeDevice,
  collectPersistentGuardDiagnostics,
  decodeFirestoreEventDocument,
  finalizeRun,
  installNetworkGuards,
  isAllowedNetworkUrl,
  makeMutationDocId,
  normalizeConvergence,
  normalizeSemanticEvents,
  ownedProcessTreePids,
  parseEmulatorAddress,
  readJavaMajor,
  resolveCanonicalUpgradeProfile,
  resolvePackagedExecutable,
  removeTempDirectoryWithRetry,
  semanticEventPayload,
  semanticEventsEqual,
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

  it('allows only the exact packaged resource, safe internal page, and emulator protocols', () => {
    const resourcePath = path.resolve('release', 'win-unpacked', 'resources', 'app.asar')
    const packagedPage = pathToFileURL(path.join(resourcePath, 'dist', 'index.html')).href

    expect(isAllowedNetworkUrl(packagedPage, { resourcePath })).toBe(true)
    expect(isAllowedNetworkUrl('about:blank', { resourcePath })).toBe(true)
    expect(isAllowedNetworkUrl('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts')).toBe(true)
    expect(isAllowedNetworkUrl('http://localhost:8080/google.firestore.v1.Firestore/Listen/channel')).toBe(true)
    expect(isAllowedNetworkUrl('ws://127.0.0.1:8080/google.firestore.v1.Firestore/Listen/channel')).toBe(true)
    expect(isAllowedNetworkUrl('http://localhost:5173')).toBe(false)
    expect(isAllowedNetworkUrl('https://identitytoolkit.googleapis.com/v1/accounts')).toBe(false)
    expect(isAllowedNetworkUrl('https://127.0.0.1:9099/accounts')).toBe(false)
    expect(isAllowedNetworkUrl('wss://127.0.0.1:8080/listen')).toBe(false)
    expect(isAllowedNetworkUrl('ws://127.0.0.1:9099/auth')).toBe(false)
    expect(isAllowedNetworkUrl('ftp://127.0.0.1:8080/export')).toBe(false)
    expect(isAllowedNetworkUrl('custom://127.0.0.1:8080/export')).toBe(false)
    expect(isAllowedNetworkUrl(pathToFileURL(path.resolve('outside.html')).href, { resourcePath })).toBe(false)
    expect(isAllowedNetworkUrl('not a url', { resourcePath })).toBe(false)
  })

  it('routes both HTTP and WebSocket traffic through the fail-closed policy', async () => {
    const handlers: Record<string, (value: any) => Promise<void>> = {}
    const context = {
      route: async (_pattern: string, handler: (route: any) => Promise<void>) => { handlers.http = handler },
      routeWebSocket: async (_pattern: string, handler: (route: any) => Promise<void>) => { handlers.ws = handler },
    }
    const blockedRequests: string[] = []
    await installNetworkGuards(context, {
      name: 'A',
      resourcePath: path.resolve('resources', 'app.asar'),
      blockedRequests,
    })

    const httpActions: string[] = []
    await handlers.http({
      request: () => ({ url: () => 'ftp://example.test/export' }),
      continue: async () => httpActions.push('continue'),
      abort: async () => httpActions.push('abort'),
    })
    expect(httpActions).toEqual(['abort'])
    await handlers.http({
      request: () => ({ url: () => `http://[::1]:${FIRESTORE_PORT}/listen` }),
      continue: async () => httpActions.push('continue'),
      abort: async () => httpActions.push('abort-allowed'),
    })
    expect(httpActions).toEqual(['abort', 'continue'])

    const wsActions: string[] = []
    await handlers.ws({
      url: () => 'wss://example.test/listen',
      connectToServer: () => wsActions.push('connect'),
      close: async () => wsActions.push('close'),
    })
    expect(wsActions).toEqual(['close'])
    expect(blockedRequests).toEqual([
      'A: ftp://example.test/export',
      'A: wss://example.test/listen',
    ])

    await handlers.ws({
      url: () => `ws://127.0.0.1:${FIRESTORE_PORT}/listen`,
      connectToServer: () => wsActions.push('connect'),
      close: async () => wsActions.push('close-allowed'),
    })
    expect(wsActions).toEqual(['close', 'connect'])
  })

  it('captures renderer failures on existing and future windows before test navigation', () => {
    const existing = new EventEmitter() as EventEmitter & { url(): string }
    existing.url = () => 'file:///packaged/index.html'
    const future = new EventEmitter() as EventEmitter & { url(): string }
    future.url = () => 'file:///packaged/settings.html'
    const app = new EventEmitter()
    const rendererErrors: string[] = []

    attachRendererDiagnostics({
      app,
      context: { pages: () => [existing] },
      name: 'A',
      rendererErrors,
      isClosing: () => false,
    })
    existing.emit('console', { type: () => 'error', text: () => 'early console error' })
    app.emit('window', future)
    future.emit('pageerror', new Error('future page error'))
    future.emit('requestfailed', {
      url: () => 'https://example.test/data',
      failure: () => ({ errorText: 'net::ERR_FAILED' }),
    })

    expect(rendererErrors).toEqual([
      'A: console early console error',
      'A: pageerror future page error',
      'A: requestfailed https://example.test/data net::ERR_FAILED',
    ])
  })

  it('records unexpected file or custom navigation even when protocol routing cannot intercept it', () => {
    const page = new EventEmitter() as EventEmitter & { url(): string }
    page.url = () => 'about:blank'
    const blockedRequests: string[] = []
    attachRendererDiagnostics({
      app: new EventEmitter(),
      context: { pages: () => [page] },
      name: 'A',
      rendererErrors: [],
      blockedRequests,
      isClosing: () => false,
      resourcePath: path.resolve('resources', 'app.asar'),
    })
    page.emit('framenavigated', { url: () => pathToFileURL(path.resolve('outside.html')).href })
    page.emit('request', { url: () => 'custom://unexpected-resource' })
    expect(blockedRequests).toEqual([
      `A: ${pathToFileURL(path.resolve('outside.html')).href}`,
      'A: custom://unexpected-resource',
    ])
  })

  it('ignores only expected emulator cancellation while a device is closing', () => {
    const page = new EventEmitter() as EventEmitter & { url(): string }
    page.url = () => 'file:///packaged/index.html'
    const rendererErrors: string[] = []
    attachRendererDiagnostics({
      app: new EventEmitter(),
      context: { pages: () => [page] },
      name: 'A',
      rendererErrors,
      isClosing: () => true,
    })
    page.emit('requestfailed', {
      url: () => `http://127.0.0.1:${FIRESTORE_PORT}/listen`,
      failure: () => ({ errorText: 'net::ERR_ABORTED' }),
    })
    page.emit('requestfailed', {
      url: () => 'https://example.test/data',
      failure: () => ({ errorText: 'net::ERR_ABORTED' }),
    })
    expect(rendererErrors).toEqual([
      'A: requestfailed https://example.test/data net::ERR_ABORTED',
    ])
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

  it('resolves only real regular files in the expected packaged Windows or macOS structure', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'baby-diary-packaged-fixture-')))
    const win = path.join(root, 'release', 'win-unpacked', 'Baby Diary.exe')
    const winResources = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar')
    const mac = path.join(root, 'release', 'mac-universal', 'Baby Diary.app', 'Contents', 'MacOS', 'Baby Diary')
    const macResources = path.join(root, 'release', 'mac-universal', 'Baby Diary.app', 'Contents', 'Resources', 'app.asar')
    const installedWin = path.join(root, 'Program Files', 'Baby Diary', 'Baby Diary.exe')
    const installedWinResources = path.join(root, 'Program Files', 'Baby Diary', 'resources', 'app.asar')
    const installedMac = path.join(root, 'Applications', 'Baby Diary.app', 'Contents', 'MacOS', 'Baby Diary')
    const installedMacResources = path.join(root, 'Applications', 'Baby Diary.app', 'Contents', 'Resources', 'app.asar')
    const arbitraryBinary = path.join(root, 'tools', 'node.exe')
    try {
      for (const file of [
        win,
        winResources,
        mac,
        macResources,
        installedWin,
        installedWinResources,
        installedMac,
        installedMacResources,
        arbitraryBinary,
      ]) {
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, 'fixture')
      }
      chmodSync(mac, 0o755)
      chmodSync(installedMac, 0o755)

      expect(resolvePackagedExecutable({ root, platform: 'win32' })).toBe(win)
      expect(resolvePackagedExecutable({ root, platform: 'darwin' })).toBe(mac)
      expect(resolvePackagedExecutable({ root, platform: 'win32', override: installedWin })).toBe(installedWin)
      expect(resolvePackagedExecutable({ root, platform: 'darwin', override: installedMac })).toBe(installedMac)
      expect(() => resolvePackagedExecutable({ root, platform: 'linux' })).toThrow(/Windows.*macOS/)
      expect(() => resolvePackagedExecutable({ root, platform: 'win32', override: path.join(root, 'missing.exe') })).toThrow(/packaged Baby Diary/i)
      expect(() => resolvePackagedExecutable({
        root,
        platform: 'win32',
        override: arbitraryBinary,
      })).toThrow(/packaged Baby Diary/i)
      rmSync(winResources)
      mkdirSync(winResources)
      expect(() => resolvePackagedExecutable({ root, platform: 'win32', override: win })).toThrow(/regular file.*app\.asar/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('attests the launched installed app by its packaged npm identity and rejects a source Electron runtime', () => {
    const executablePath = path.resolve('Program Files', 'Baby Diary', 'Baby Diary.exe')
    const resourcePath = path.resolve('Program Files', 'Baby Diary', 'resources', 'app.asar')
    const valid = {
      // Electron app.getName() reads the packaged package.json "name". The
      // electron-builder productName controls the executable/display name only.
      name: 'baby-diary',
      version: '0.3.9',
      isPackaged: true,
      appPath: resourcePath,
      executablePath,
    }

    expect(assertPackagedRuntimeAttestation(valid, {
      executablePath,
      resourcePath,
      platform: 'win32',
      expectedVersion: '0.3.9',
    })).toEqual(valid)
    expect(() => assertPackagedRuntimeAttestation({
      ...valid,
      name: 'Baby Diary',
    }, {
      executablePath,
      resourcePath,
      platform: 'win32',
      expectedVersion: '0.3.9',
    })).toThrow(/packaged Baby Diary runtime/i)
    expect(() => assertPackagedRuntimeAttestation({
      ...valid,
      name: 'Electron',
      isPackaged: false,
      appPath: path.resolve('node_modules', 'electron', 'dist', 'resources', 'default_app.asar'),
      executablePath: path.resolve('node_modules', 'electron', 'dist', 'electron.exe'),
    }, {
      executablePath,
      resourcePath,
      platform: 'win32',
      expectedVersion: '0.3.9',
    })).toThrow(/packaged Baby Diary runtime/i)
  })

  it('binds emulator continuation to the existing canonical upgraded profile, never a fresh userData', () => {
    const runnerSource = readFileSync(path.resolve(import.meta.dirname, '../scripts/sync-e2e.mjs'), 'utf8')
    const continuationIndex = runnerSource.indexOf('await runCanonicalUpgradeProfileContinuation({')
    const freshSeedIndex = runnerSource.indexOf("writeSeed(userDataA, 'Device A')")
    expect(continuationIndex).toBeGreaterThan(-1)
    expect(freshSeedIndex).toBeGreaterThan(continuationIndex)
    expect(runnerSource).toContain('BABYDIARY_TEST_USERDATA: canonicalUpgradeProfile')

    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'baby-diary-upgraded-profile-')))
    const platform = process.platform === 'darwin' ? 'darwin' : 'win32'
    const homeOrAppData = platform === 'darwin'
      ? path.join(root, 'home')
      : path.join(root, 'AppData', 'Roaming')
    const profile = platform === 'darwin'
      ? path.join(homeOrAppData, 'Library', 'Application Support', 'baby-diary')
      : path.join(homeOrAppData, 'baby-diary')
    const fresh = path.join(root, 'fresh-device')
    try {
      mkdirSync(path.join(profile, 'data'), { recursive: true })
      mkdirSync(fresh)
      writeFileSync(path.join(profile, 'settings.json'), '{"version":1}\n')
      expect(resolveCanonicalUpgradeProfile({
        override: profile,
        platform,
        env: platform === 'darwin' ? { HOME: homeOrAppData } : { APPDATA: homeOrAppData },
      })).toBe(realpathSync(profile))
      expect(() => resolveCanonicalUpgradeProfile({
        override: fresh,
        platform,
        env: platform === 'darwin' ? { HOME: homeOrAppData } : { APPDATA: homeOrAppData },
      })).toThrow(/canonical upgraded profile/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a path whose realpath escapes the packaged candidate', () => {
    const root = path.resolve('fixture-root')
    const win = path.join(root, 'release', 'win-unpacked', 'Baby Diary.exe')
    const asar = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar')
    const fileSystem = {
      existsSync: () => true,
      lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      realpathSync: (candidate: string) => candidate === asar ? candidate : path.join(root, 'escaped', 'Baby Diary.exe'),
    }
    expect(() => resolvePackagedExecutable({
      root,
      platform: 'win32',
      override: win,
      fileSystem,
    })).toThrow(/real path/i)
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

  it('treats persisted tutorial completion as authoritative without a legacy language marker', () => {
    const completedTutorial = JSON.stringify({
      version: 2,
      status: 'skipped',
      updatedAt: '2026-07-14T00:00:00.000Z',
    })

    expect(classifyFirstLaunchState({
      persistedLanguage: 'ko',
      langChosen: false,
      tutorialState: completedTutorial,
    })).toBe('complete')
    expect(classifyFirstLaunchState({
      persistedLanguage: 'ko',
      langChosen: false,
      tutorialState: null,
    })).toBe('tour')
    expect(classifyFirstLaunchState({
      persistedLanguage: null,
      langChosen: false,
      tutorialState: null,
    })).toBe('picker')
    expect(classifyFirstLaunchState({
      persistedLanguage: 'ko',
      langChosen: false,
      tutorialState: '{malformed',
    })).toBe('tour')
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

  it('compares every semantic DiaryEvent field, including nested data, author, and mutation identity', () => {
    const event = {
      id: 'semantic-event',
      type: 'feed',
      at: '2026-07-13T08:00:00.000Z',
      data: { side: 'left', ml: 80 },
      author: { uid: 'account-a', name: 'A', role: 'mom' },
      createdAt: '2026-07-13T08:00:01.000Z',
      updatedAt: '2026-07-13T08:00:02.000Z',
      rev: 2,
      deleted: false,
      mutationId: '11111111-1111-4111-8111-111111111111',
    }

    expect(semanticEventPayload(event)).toEqual(event)
    expect(semanticEventsEqual(event, structuredClone(event))).toBe(true)
    for (const changed of [
      { ...event, at: '2026-07-13T09:00:00.000Z' },
      { ...event, data: { ...event.data, ml: 81 } },
      { ...event, author: { ...event.author, uid: 'account-b' } },
      { ...event, updatedAt: '2026-07-13T08:00:03.000Z' },
      { ...event, mutationId: '22222222-2222-4222-8222-222222222222' },
    ]) {
      expect(semanticEventsEqual(event, changed)).toBe(false)
    }
    expect(normalizeSemanticEvents([event])).toEqual([event])
  })

  it('builds edit and delete expectations from the original payload, not the observed result', () => {
    const original = {
      id: 'expected-event',
      type: 'feed',
      at: '2026-07-13T08:00:00.000Z',
      data: { side: 'left', ml: 80 },
      author: { uid: 'account-a', name: 'A', role: 'mom' },
      createdAt: '2026-07-13T08:00:01.000Z',
      updatedAt: '2026-07-13T08:00:02.000Z',
      rev: 1,
      deleted: false,
      mutationId: '11111111-1111-4111-8111-111111111111',
    }
    const dynamic = {
      updatedAt: '2026-07-13T08:10:00.000Z',
      mutationId: '22222222-2222-4222-8222-222222222222',
    }
    const edited = buildExpectedEditedEvent(
      original,
      '2026-07-13T07:30:00.000Z',
      dynamic,
      { startedAt: Date.parse('2026-07-13T08:09:59.000Z'), finishedAt: Date.parse('2026-07-13T08:10:01.000Z') },
    )
    expect(edited).toEqual({
      ...original,
      at: '2026-07-13T07:30:00.000Z',
      updatedAt: dynamic.updatedAt,
      rev: 2,
      mutationId: dynamic.mutationId,
    })
    expect(edited.data).toEqual(original.data)
    expect(edited.author).toEqual(original.author)

    const deleted = buildExpectedDeletedEvent(
      original,
      dynamic,
      { startedAt: Date.parse('2026-07-13T08:09:59.000Z'), finishedAt: Date.parse('2026-07-13T08:10:01.000Z') },
    )
    expect(deleted).toEqual({
      ...original,
      deleted: true,
      updatedAt: dynamic.updatedAt,
      rev: 2,
      mutationId: dynamic.mutationId,
    })
    expect(semanticEventsEqual(edited, { ...edited, data: { side: 'right', ml: 80 } })).toBe(false)
    expect(() => buildExpectedEditedEvent(original, edited.at, {
      ...dynamic,
      mutationId: original.mutationId,
    }, { startedAt: 0, finishedAt: Number.MAX_SAFE_INTEGER })).toThrow(/mutation/i)
  })

  it('decodes and compares the complete event stored in a Firestore emulator document', () => {
    const event = {
      id: 'cloud-event',
      type: 'pee',
      at: '2026-07-13T08:00:00.000Z',
      data: { amount: 2, flags: ['a', true] },
      author: { uid: 'account-a', name: 'A', role: 'mom' },
      createdAt: '2026-07-13T08:00:00.000Z',
      updatedAt: '2026-07-13T08:00:01.000Z',
      rev: 2,
      deleted: false,
      mutationId: '22222222-2222-4222-8222-222222222222',
    }
    const encode = (value: unknown): Record<string, unknown> => {
      if (value === null) return { nullValue: null }
      if (typeof value === 'string') return { stringValue: value }
      if (typeof value === 'boolean') return { booleanValue: value }
      if (typeof value === 'number') return Number.isInteger(value)
        ? { integerValue: String(value) }
        : { doubleValue: value }
      if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } }
      return {
        mapValue: {
          fields: Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, encode(entry)]),
          ),
        },
      }
    }
    const decoded = decodeFirestoreEventDocument({
      name: 'projects/demo-baby-diary/databases/(default)/documents/families/family/events/cloud-doc',
      fields: { event: encode(event) },
    })
    expect(decoded).toEqual({ docId: 'cloud-doc', event })
    expect(semanticEventsEqual(decoded.event, event)).toBe(true)
    expect(semanticEventsEqual(decoded.event, { ...event, data: { amount: 999 } })).toBe(false)
  })

  it('closes with a timeout, kills only the registered app pid tree, and reports cleanup failure', async () => {
    const killed: number[] = []
    const device = {
      name: 'A',
      app: {
        close: () => new Promise(() => undefined),
        process: () => ({ pid: 4242 }),
      },
    }
    await expect(closeDevice(device, {
      timeoutMs: 10,
      killTree: async (pid: number) => { killed.push(pid) },
    })).rejects.toThrow(/timed out/i)
    expect(killed).toEqual([4242])
    expect(device.app).toBeNull()
  })

  it('derives only descendants of the owned root pid in leaf-first kill order', () => {
    expect(ownedProcessTreePids(40, [
      { pid: 41, parentPid: 40 },
      { pid: 42, parentPid: 41 },
      { pid: 99, parentPid: 1 },
    ])).toEqual([42, 41, 40])
    expect(() => ownedProcessTreePids(process.pid, [])).not.toThrow()
    expect(() => ownedProcessTreePids(1, [])).toThrow(/unsafe process id/i)
  })

  it('retries temporary auth-data removal without masking the final result', async () => {
    const attempts: string[] = []
    await removeTempDirectoryWithRetry('isolated-auth-root', {
      retries: 3,
      remove: async (candidate: string) => {
        attempts.push(candidate)
        if (attempts.length < 3) throw new Error('file still locked')
      },
    })
    expect(attempts).toEqual([
      'isolated-auth-root',
      'isolated-auth-root',
      'isolated-auth-root',
    ])
  })

  it('preserves the original launch error when partial-app cleanup also fails', async () => {
    const original = new Error('first window failed')
    await expect(cleanupPartialDevice(
      { name: 'A', app: {} },
      original,
      async () => { throw new Error('close failed') },
    )).rejects.toMatchObject({
      errors: [original, expect.objectContaining({ message: 'close failed' })],
    })
  })

  it('collects diagnostics after both apps close and never lets cleanup hide the primary error', async () => {
    const rendererErrors: string[] = []
    const order: string[] = []
    const primary = new Error('sync assertion failed')
    await expect(finalizeRun({
      devices: [{ name: 'A' }, { name: 'B' }],
      rootTemp: 'temporary-auth-root',
      blockedRequests: [],
      rendererErrors,
      primaryError: primary,
      close: async (device: { name: string }) => {
        order.push(`close-${device.name}`)
        if (device.name === 'B') rendererErrors.push('B: pageerror during close')
      },
      removeTemp: async () => { order.push('remove-temp') },
    })).rejects.toMatchObject({
      errors: [
        primary,
        expect.objectContaining({ message: expect.stringMatching(/renderer error/i) }),
      ],
    })
    expect(order.slice(0, 2).sort()).toEqual(['close-A', 'close-B'])
    expect(order.at(-1)).toBe('remove-temp')
  })

  it('requires a persistent early-guard ready record and maps blocked or crashed startup activity', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'baby-diary-persistent-guard-')))
    try {
      const diagnosticPath = path.join(root, 'guard.jsonl')
      writeFileSync(diagnosticPath, [
        JSON.stringify({ kind: 'guard-ready', timestamp: '2026-07-13T08:00:00.000Z' }),
        JSON.stringify({ kind: 'network-blocked', protocol: 'https:', destination: 'external' }),
        JSON.stringify({ kind: 'renderer-gone', reason: 'crashed', exitCode: 9 }),
      ].join('\n') + '\n')
      const blockedRequests: string[] = []
      const rendererErrors: string[] = []
      collectPersistentGuardDiagnostics(
        [{ name: 'A', path: diagnosticPath }],
        blockedRequests,
        rendererErrors,
      )
      expect(blockedRequests).toEqual(['A: early network-blocked https: external'])
      expect(rendererErrors).toEqual(['A: early renderer-gone crashed (9)'])

      writeFileSync(diagnosticPath, `${JSON.stringify({ kind: 'network-blocked' })}\n`)
      expect(() => collectPersistentGuardDiagnostics(
        [{ name: 'A', path: diagnosticPath }],
        [],
        [],
      )).toThrow(/guard-ready/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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
