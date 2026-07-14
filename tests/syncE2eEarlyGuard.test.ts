import { EventEmitter } from 'node:events'
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

  it('attaches window diagnostics before load without writing renderer message contents', () => {
    const userData = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'baby-diary-early-guard-')))
    const resourceRoot = path.resolve('release', 'win-unpacked', 'resources', 'app.asar')
    try {
      const config = readSyncE2EGuardConfig(guardEnvironment(userData), userData)
      expect(config).not.toBeNull()
      if (!config) return
      const guard = createSyncE2EGuard(config)
      const webContents = new EventEmitter()
      const window = new EventEmitter() as EventEmitter & { webContents: EventEmitter }
      window.webContents = webContents
      guard.attachWindowDiagnostics(window, resourceRoot)
      const packagedSource = `${pathToFileURL(path.join(resourceRoot, 'dist', 'index.html')).href}?token=secret`

      webContents.emit('console-message', {
        level: 'error',
        message: 'private-account@example.test password=do-not-write',
        lineNumber: 17,
        sourceId: packagedSource,
      })
      window.emit('close')
      webContents.emit('console-message', {
        level: 'error',
        message: 'private-account@example.test password=still-do-not-write',
        lineNumber: 18,
        sourceId: packagedSource,
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
        }),
        expect.objectContaining({
          kind: 'console-error',
          phase: 'closing',
          protocol: 'file:',
          destination: 'packaged',
          line: 18,
        }),
      ])
      for (const kind of ['console-error', 'navigation-blocked', 'load-failed', 'renderer-gone']) {
        expect(source).toContain(`"kind":"${kind}"`)
      }
      expect(source).not.toContain('private-account')
      expect(source).not.toContain('do-not-write')
      expect(source).not.toContain('token=')
    } finally {
      rmSync(userData, { recursive: true, force: true })
    }
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
