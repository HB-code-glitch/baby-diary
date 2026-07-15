import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createSyncE2EGuard,
  isAllowedSyncE2EGuardUrl,
  readSyncE2EGuardConfig,
  safeConsoleSummary,
} from '../electron/syncE2EGuard'

const TOKEN = 'a'.repeat(64)

function guardEnvironment(userData: string): NodeJS.ProcessEnv {
  return {
    BABYDIARY_SYNC_E2E_EARLY_GUARD: '1',
    BABYDIARY_SYNC_E2E_GUARD_TOKEN: TOKEN,
    BABYDIARY_SYNC_E2E_DIAGNOSTICS: path.join(
      userData,
      `sync-e2e-diagnostics-${TOKEN}.jsonl`,
    ),
    BABYDIARY_TEST_USERDATA: userData,
    BABYDIARY_FIREBASE_EMULATOR: '1',
    BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID: 'demo-baby-diary',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  }
}

describe('packaged sync E2E early main-process guard', () => {
  it('keeps console causes useful while removing secrets and identifiers', () => {
    const summary = safeConsoleSummary([
      'Firestore write failed\nwhile restoring account',
      'https://user:pass@example.test/private?apiKey=api-key-value',
      'private-account@example.test',
      'Authorization: Bearer bearer-secret-value',
      'token=0123456789abcdef0123456789abcdef',
      'credential="wife-private-value"',
      '{"refreshToken":"refresh-private-value","client_secret":"client-private-value"}',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJiYWJ5In0.signaturevalue',
      '01890f47-3c6f-7cc1-98c2-b8f9deac0001',
      String.raw`C:\Users\wife-private\AppData\Roaming\baby-diary\events.jsonl`,
      '/Users/wife-private/Library/BabyDiary/events.jsonl',
      '\u0000\u0007',
    ].join(' '))

    expect(summary).toContain('Firestore write failed while restoring account')
    expect(summary).toContain('[url]')
    expect(summary).toContain('[email]')
    expect(summary).toContain('[redacted]')
    expect(summary).toContain('[jwt]')
    expect(summary).toContain('[uuid]')
    expect(summary).toContain('[path]')
    expect(summary).not.toMatch(/[\r\n\u0000-\u001f\u007f]/)
    expect(summary).not.toContain('private-account')
    expect(summary).not.toContain('api-key-value')
    expect(summary).not.toContain('bearer-secret-value')
    expect(summary).not.toContain('wife-private-value')
    expect(summary).not.toContain('refresh-private-value')
    expect(summary).not.toContain('client-private-value')
    expect(summary).not.toContain('wife-private')
    expect(summary).not.toContain('01890f47')
    expect(summary.length).toBeLessThanOrEqual(240)
    expect(safeConsoleSummary(' \r\n\t\u0000 ')).toBe('unavailable')
    expect(safeConsoleSummary('ordinary failure '.repeat(40))).toHaveLength(240)
  })

  it('is inert unless the explicit test-only activation token is present', () => {
    expect(readSyncE2EGuardConfig({}, path.resolve('production-user-data'))).toBeNull()
    expect(() => readSyncE2EGuardConfig({
      BABYDIARY_SYNC_E2E_EARLY_GUARD: '1',
    }, path.resolve('production-user-data'))).toThrow(/token/i)
  })

  it('accepts only an isolated real userData directory and exact private diagnostic path', () => {
    const userData = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'baby-diary-early-guard-')))
    try {
      const env = guardEnvironment(userData)
      expect(readSyncE2EGuardConfig(env, userData)).toEqual({
        diagnosticPath: env.BABYDIARY_SYNC_E2E_DIAGNOSTICS,
      })
      expect(() => readSyncE2EGuardConfig({
        ...env,
        BABYDIARY_SYNC_E2E_DIAGNOSTICS: path.join(userData, '..', 'escaped.jsonl'),
      }, userData)).toThrow(/diagnostic path/i)
      expect(() => readSyncE2EGuardConfig({
        ...env,
        BABYDIARY_SYNC_E2E_GUARD_TOKEN: 'short',
      }, userData)).toThrow(/token/i)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('allows only the packaged renderer and exact loopback emulator protocols', () => {
    const resourceRoot = path.resolve('release', 'win-unpacked', 'resources', 'app.asar')
    expect(isAllowedSyncE2EGuardUrl(
      pathToFileURL(path.join(resourceRoot, 'dist', 'index.html')).href,
      resourceRoot,
    )).toBe(true)
    expect(isAllowedSyncE2EGuardUrl('http://127.0.0.1:9099/accounts', resourceRoot)).toBe(true)
    expect(isAllowedSyncE2EGuardUrl('http://[::1]:8080/listen', resourceRoot)).toBe(true)
    expect(isAllowedSyncE2EGuardUrl('ws://localhost:8080/listen', resourceRoot)).toBe(true)
    expect(isAllowedSyncE2EGuardUrl('https://127.0.0.1:9099/accounts', resourceRoot)).toBe(false)
    expect(isAllowedSyncE2EGuardUrl('wss://127.0.0.1:8080/listen', resourceRoot)).toBe(false)
    expect(isAllowedSyncE2EGuardUrl('ftp://127.0.0.1:8080/export', resourceRoot)).toBe(false)
    expect(isAllowedSyncE2EGuardUrl('custom://unexpected', resourceRoot)).toBe(false)
    expect(isAllowedSyncE2EGuardUrl(
      pathToFileURL(path.resolve('outside.html')).href,
      resourceRoot,
    )).toBe(false)
  })

  it('registers session blocking before load and persists redacted early diagnostics', () => {
    const userData = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'baby-diary-early-guard-')))
    const resourceRoot = path.resolve('release', 'win-unpacked', 'resources', 'app.asar')
    try {
      const config = readSyncE2EGuardConfig(guardEnvironment(userData), userData)
      expect(config).not.toBeNull()
      if (!config) return

      let beforeRequestFilter: { urls: string[] } | undefined
      let beforeRequest: ((details: { url: string }, callback: (result: { cancel: boolean }) => void) => void) | undefined
      const session = {
        webRequest: {
          onBeforeRequest: (
            filter: { urls: string[] },
            handler: typeof beforeRequest,
          ) => {
            beforeRequestFilter = filter
            beforeRequest = handler
          },
          onErrorOccurred: () => undefined,
        },
      }
      const guard = createSyncE2EGuard(config)
      guard.installSessionGuard(session, resourceRoot)
      expect(beforeRequestFilter).toEqual({ urls: ['<all_urls>'] })
      expect(beforeRequest).toBeTypeOf('function')

      let result: { cancel: boolean } | undefined
      beforeRequest?.({ url: 'https://user:pass@example.test/private?apiKey=secret#token' }, value => { result = value })
      expect(result).toEqual({ cancel: true })
      beforeRequest?.({ url: 'http://127.0.0.1:8080/listen' }, value => { result = value })
      expect(result).toEqual({ cancel: false })
      guard.close()

      const source = readFileSync(config.diagnosticPath, 'utf8')
      expect(source).toContain('"kind":"guard-ready"')
      expect(source).toContain('"kind":"network-blocked"')
      expect(source).not.toContain('apiKey')
      expect(source).not.toContain('secret')
      expect(source).not.toContain('user:pass')
      if (process.platform !== 'win32') {
        expect(statSync(config.diagnosticPath).mode & 0o777).toBe(0o600)
      }
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('durably attributes an exact Firestore Listen failure to one closing window without storing its URL', () => {
    const userData = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'baby-diary-early-guard-')))
    const resourceRoot = path.resolve('release', 'win-unpacked', 'resources', 'app.asar')
    try {
      const config = readSyncE2EGuardConfig(guardEnvironment(userData), userData)
      expect(config).not.toBeNull()
      if (!config) return

      type ErrorDetails = {
        url: string
        method: string
        error: string
        webContentsId: number
      }
      type ErrorListener = (details: ErrorDetails) => void
      type ErrorFilter = { urls: string[] }
      let errorFilter: ErrorFilter | null | undefined
      let errorOccurred: ErrorListener | null | undefined
      const errorRegistrations: Array<{
        filterOrListener: ErrorFilter | ErrorListener | null
        listener?: ErrorListener | null
      }> = []
      function onErrorOccurred(filter: ErrorFilter, listener: ErrorListener | null): void
      function onErrorOccurred(listener: ErrorListener | null): void
      function onErrorOccurred(
        filterOrListener: ErrorFilter | ErrorListener | null,
        listener?: ErrorListener | null,
      ): void {
        if (filterOrListener && typeof filterOrListener === 'object') {
          errorFilter = filterOrListener
          errorOccurred = listener
        } else if (filterOrListener === null) {
          errorOccurred = null
        }
        errorRegistrations.push({ filterOrListener, listener })
      }
      const session = {
        webRequest: {
          onBeforeRequest: () => undefined,
          onErrorOccurred,
        },
      }
      const windowA = new EventEmitter() as EventEmitter & { webContents: EventEmitter & { id: number } }
      windowA.webContents = Object.assign(new EventEmitter(), { id: 101 })
      const windowB = new EventEmitter() as EventEmitter & { webContents: EventEmitter & { id: number } }
      windowB.webContents = Object.assign(new EventEmitter(), { id: 202 })
      const guard = createSyncE2EGuard(config)
      guard.installSessionGuard(session, resourceRoot)
      guard.attachWindowDiagnostics(windowA, resourceRoot)
      guard.attachWindowDiagnostics(windowB, resourceRoot)

      expect(errorFilter).toEqual({ urls: ['<all_urls>'] })
      expect(errorOccurred).toBeTypeOf('function')
      const params = new URLSearchParams({
        VER: '8',
        database: 'projects/demo-baby-diary/databases/(default)',
        RID: 'rpc',
        SID: 'private-session-id==',
        AID: '33',
        CI: '1',
        TYPE: 'xmlhttp',
        zx: 'rryrrnxmbofc',
        t: '1',
      })
      const listenUrl = `http://127.0.0.1:8080/google.firestore.v1.Firestore/Listen/channel?${params}`
      const details = {
        url: listenUrl,
        method: 'GET',
        error: 'net::ERR_NO_BUFFER_SPACE',
      }

      errorOccurred?.({ ...details, webContentsId: 999 })
      errorOccurred?.({ ...details, webContentsId: 101 })
      windowA.emit('close')
      errorOccurred?.({ ...details, webContentsId: 101 })
      errorOccurred?.({ ...details, webContentsId: 202 })
      guard.close()

      expect(errorRegistrations.at(-1)).toEqual({ filterOrListener: null, listener: undefined })
      const records = readFileSync(config.diagnosticPath, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map(line => JSON.parse(line))
      const networkRecords = records.filter(record => record.kind === 'network-error')
      expect(networkRecords).toEqual([
        expect.objectContaining({
          phase: 'active',
          webContentsId: 101,
          method: 'GET',
          error: 'net::ERR_NO_BUFFER_SPACE',
          target: 'firestore-listen-channel',
          urlSha256: createHash('sha256').update(listenUrl).digest('hex'),
        }),
        expect.objectContaining({
          phase: 'closing',
          webContentsId: 101,
          method: 'GET',
          error: 'net::ERR_NO_BUFFER_SPACE',
          target: 'firestore-listen-channel',
          urlSha256: createHash('sha256').update(listenUrl).digest('hex'),
        }),
        expect.objectContaining({
          phase: 'active',
          webContentsId: 202,
          method: 'GET',
          error: 'net::ERR_NO_BUFFER_SPACE',
          target: 'firestore-listen-channel',
          urlSha256: createHash('sha256').update(listenUrl).digest('hex'),
        }),
      ])
      const teardown = records.find(record => record.kind === 'teardown-start')
      expect(teardown).toEqual(expect.objectContaining({
        phase: 'closing',
        source: 'window-close',
        webContentsId: 101,
      }))
      expect(networkRecords[1].sequence).toBeGreaterThan(teardown.sequence)
      expect(Date.parse(networkRecords[1].timestamp)).toBeGreaterThanOrEqual(Date.parse(teardown.timestamp))
      expect(records.every((record, index) => record.sequence === index + 1)).toBe(true)
      const durableText = readFileSync(config.diagnosticPath, 'utf8')
      expect(durableText).not.toContain(listenUrl)
      expect(durableText).not.toContain('private-session-id')
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('attaches window diagnostics before load with redacted modern and legacy summaries', () => {
    const userData = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'baby-diary-early-guard-')))
    const resourceRoot = path.resolve('release', 'win-unpacked', 'resources', 'app.asar')
    try {
      const config = readSyncE2EGuardConfig(guardEnvironment(userData), userData)
      expect(config).not.toBeNull()
      if (!config) return
      const guard = createSyncE2EGuard(config)
      const webContents = Object.assign(new EventEmitter(), { id: 101 })
      const window = new EventEmitter() as EventEmitter & { webContents: EventEmitter & { id: number } }
      window.webContents = webContents
      guard.attachWindowDiagnostics(window, resourceRoot)
      const packagedSource = `${pathToFileURL(path.join(resourceRoot, 'dist', 'index.html')).href}?token=secret`

      webContents.emit('console-message', {
        level: 'error',
        message: 'Auth restore failed for private-account@example.test password=do-not-write',
        stack: 'raw-stack-with-secret-token',
        lineNumber: 17,
        sourceId: packagedSource,
      })
      webContents.emit(
        'console-message',
        {},
        3,
        'Legacy Firestore write failed token=legacy-private-token',
        18,
        'node:electron/js2c/browser_init',
      )
      guard.beginShutdown()
      webContents.emit('console-message', {
        level: 'error',
        message: 'Teardown failed credential=still-do-not-write',
        lineNumber: 19,
        sourceId: 'node:electron/js2c/browser_init',
      })
      let prevented = false
      webContents.emit('will-navigate', {
        url: 'custom://private-account@example.test?token=secret',
        preventDefault: () => { prevented = true },
      })
      webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://example.test/?token=secret', true)
      webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
      guard.close()

      expect(prevented).toBe(true)
      const source = readFileSync(config.diagnosticPath, 'utf8')
      const consoleRecords = source
        .trim()
        .split(/\r?\n/)
        .map(line => JSON.parse(line))
        .filter(record => record.kind === 'console-error')
      expect(consoleRecords).toEqual([
        expect.objectContaining({
          kind: 'console-error',
          phase: 'active',
          protocol: 'file:',
          destination: 'packaged',
          line: 17,
          summary: 'Auth restore failed for [email] password=[redacted]',
        }),
        expect.objectContaining({
          kind: 'console-error',
          phase: 'active',
          protocol: 'node:',
          destination: 'external',
          line: 18,
          summary: 'Legacy Firestore write failed token=[redacted]',
        }),
        expect.objectContaining({
          kind: 'console-error',
          phase: 'closing',
          protocol: 'node:',
          destination: 'external',
          line: 19,
          summary: 'Teardown failed credential=[redacted]',
        }),
      ])
      for (const kind of ['console-error', 'navigation-blocked', 'load-failed', 'renderer-gone']) {
        expect(source).toContain(`"kind":"${kind}"`)
      }
      expect(source).not.toContain('private-account')
      expect(source).not.toContain('do-not-write')
      expect(source).not.toContain('legacy-private-token')
      expect(source).not.toContain('raw-stack-with-secret-token')
      expect(source).not.toContain('token=secret')
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })

  it('marks the shared guard as shutting down at the start of before-quit', () => {
    const source = readFileSync(path.resolve('electron', 'main.ts'), 'utf8')
    expect(source).toMatch(
      /app\.on\('before-quit', \(event\) => \{\s*syncE2EGuard\?\.beginShutdown\(\)/,
    )
  })

  it('maps the isolated macOS harness signal to the normal app quit path', () => {
    const source = readFileSync(path.resolve('electron', 'main.ts'), 'utf8')
    expect(source).toMatch(
      /if \(syncE2EGuardConfig && process\.platform === 'darwin'\) \{\s*process\.once\('SIGTERM', \(\) => app\.quit\(\)\)/,
    )
  })

  it('refuses to overwrite a pre-existing diagnostic file', () => {
    const userData = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'baby-diary-early-guard-')))
    try {
      const config = readSyncE2EGuardConfig(guardEnvironment(userData), userData)
      expect(config).not.toBeNull()
      if (!config) return
      writeFileSync(config.diagnosticPath, 'owned by another run')
      chmodSync(config.diagnosticPath, 0o600)
      expect(() => createSyncE2EGuard(config)).toThrow(/diagnostic file/i)
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
  })
})
