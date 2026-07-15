import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  writeSync,
} from 'fs'
import { createHash } from 'crypto'
import * as path from 'path'
import { fileURLToPath } from 'url'

const TOKEN_PATTERN = /^[0-9a-f]{64}$/
const AUTH_EMULATOR = '127.0.0.1:9099'
const FIRESTORE_EMULATOR = '127.0.0.1:8080'
const PROJECT_ID = 'demo-baby-diary'

export interface SyncE2EGuardConfig {
  diagnosticPath: string
}

type Environment = Record<string, string | undefined>
type DiagnosticValue = string | number | boolean | null
type GuardPhase = 'active' | 'closing'

interface GuardRequestErrorDetails {
  url: string
  method: string
  error: string
  webContentsId?: number
}

type GuardRequestErrorListener = (details: GuardRequestErrorDetails) => void

interface GuardSession {
  webRequest: {
    onBeforeRequest: (
      filter: { urls: string[] },
      listener: (
        details: { url: string },
        callback: (result: { cancel: boolean }) => void,
      ) => void,
    ) => void
    onErrorOccurred(
      filter: { urls: string[] },
      listener: GuardRequestErrorListener | null,
    ): void
    onErrorOccurred(listener: GuardRequestErrorListener | null): void
  }
}

interface GuardWebContents {
  id: number
  on: (...args: any[]) => unknown
}

interface GuardWindow {
  webContents: GuardWebContents
  on: (...args: any[]) => unknown
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function comparablePath(value: string): string {
  const normalized = path.normalize(path.resolve(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function safeUrlFields(rawUrl: unknown, resourceRoot: string): Record<string, DiagnosticValue> {
  if (typeof rawUrl !== 'string') return { protocol: 'invalid', destination: 'unknown' }
  try {
    const url = new URL(rawUrl)
    if (url.protocol === 'file:') {
      return {
        protocol: 'file:',
        destination: isAllowedSyncE2EGuardUrl(rawUrl, resourceRoot) ? 'packaged' : 'outside',
      }
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host)
    return {
      protocol: url.protocol.slice(0, 16),
      destination: loopback ? 'loopback' : 'external',
      ...(url.port ? { port: Number(url.port) || 0 } : {}),
    }
  } catch {
    return { protocol: 'invalid', destination: 'unknown' }
  }
}

function safeReason(value: unknown): string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/i.test(value)
    ? value.toLowerCase()
    : 'unknown'
}

function isExactFirestoreListenChannel(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (
    url.username
    || url.password
    || url.hash
    || url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.port !== '8080'
    || url.pathname !== '/google.firestore.v1.Firestore/Listen/channel'
  ) return false

  const expectedKeys = ['VER', 'database', 'RID', 'SID', 'AID', 'CI', 'TYPE', 'zx', 't']
  const entries = Array.from(url.searchParams.entries())
  if (entries.length !== expectedKeys.length) return false
  if (expectedKeys.some(key => url.searchParams.getAll(key).length !== 1)) return false
  if (entries.some(([key]) => !expectedKeys.includes(key))) return false

  const sid = url.searchParams.get('SID') ?? ''
  const aid = url.searchParams.get('AID') ?? ''
  const zx = url.searchParams.get('zx') ?? ''
  const attempt = url.searchParams.get('t') ?? ''
  const canonicalNonNegativeInteger = (value: string): boolean => /^(?:0|[1-9]\d*)$/.test(value)
    && Number.isSafeInteger(Number(value))
  const canonicalPositiveInteger = (value: string): boolean => /^[1-9]\d*$/.test(value)
    && Number.isSafeInteger(Number(value))

  return url.searchParams.get('VER') === '8'
    && url.searchParams.get('database') === `projects/${PROJECT_ID}/databases/(default)`
    && url.searchParams.get('RID') === 'rpc'
    && sid.length <= 256
    && /^[A-Za-z0-9_-]{1,254}={0,2}$/.test(sid)
    && canonicalNonNegativeInteger(aid)
    && /^(?:0|1)$/.test(url.searchParams.get('CI') ?? '')
    && url.searchParams.get('TYPE') === 'xmlhttp'
    && /^[a-z0-9]{1,64}$/.test(zx)
    && canonicalPositiveInteger(attempt)
}

function safeRequestMethod(value: unknown): string {
  return typeof value === 'string' && /^[A-Z]{1,16}$/.test(value)
    ? value
    : 'UNKNOWN'
}

function safeNetworkError(value: unknown): string {
  return typeof value === 'string' && /^net::ERR_[A-Z0-9_]{1,48}$/.test(value)
    ? value
    : 'unknown'
}

const MAX_CONSOLE_SUMMARY_LENGTH = 240

export function safeConsoleSummary(message: unknown): string {
  if (typeof message !== 'string') return 'unavailable'

  let summary = message
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\b(?:https?|wss?|ftp|file):\/\/[^\s<>"'`]+/gi, '[url]')
    .replace(/\b[A-Za-z]:\\(?:[^\\\s"'<>|]+\\)*[^\\\s"'<>|]*/g, '[path]')
    .replace(
      /(^|[\s("'`])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]*/g,
      (_match, prefix: string) => `${prefix}[path]`,
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(
      /(["']?)([A-Za-z0-9_-]*(?:api[_-]?key|password|token|secret|authorization|credential)[A-Za-z0-9_-]*)\1\s*[:=]\s*(?:\[redacted\]|"[^"\r\n]*"|'[^'\r\n]*'|Bearer\s+[^\s,;)}\]&]+|[^\s,;)}\]&]+)/gi,
      (_match, _quote: string, key: string) => `${key}=[redacted]`,
    )
    .replace(/\bBearer\s+[^\s,;)}\]&]+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[jwt]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[uuid]')
    .replace(
      /(^|[^A-Za-z0-9+/_=-])([A-Za-z0-9+/_-]{24,}={0,2})(?=$|[^A-Za-z0-9+/_=-])/g,
      (_match, prefix: string) => `${prefix}[redacted]`,
    )
    .replace(/\s+/g, ' ')
    .trim()

  if (!summary) return 'unavailable'
  if (summary.length > MAX_CONSOLE_SUMMARY_LENGTH) {
    summary = `${summary.slice(0, MAX_CONSOLE_SUMMARY_LENGTH - 1).trimEnd()}…`
  }
  return summary || 'unavailable'
}

function eventUrl(args: unknown[]): unknown {
  for (const value of args) {
    if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(value)) return value
    if (isRecord(value) && typeof value.url === 'string') return value.url
  }
  return undefined
}

function preventNavigation(args: unknown[]): void {
  for (const value of args) {
    if (isRecord(value) && typeof value.preventDefault === 'function') {
      value.preventDefault()
      return
    }
  }
}

export function readSyncE2EGuardConfig(
  env: Environment,
  userDataPath: string,
): SyncE2EGuardConfig | null {
  // The normal application path returns before any filesystem access. This guard
  // exists solely for explicitly isolated packaged E2E processes.
  if (env.BABYDIARY_SYNC_E2E_EARLY_GUARD !== '1') return null

  const token = env.BABYDIARY_SYNC_E2E_GUARD_TOKEN
  invariant(typeof token === 'string' && TOKEN_PATTERN.test(token), 'Sync E2E guard token must be 64 lowercase hex characters')
  invariant(env.BABYDIARY_FIREBASE_EMULATOR === '1', 'Sync E2E guard requires the Firebase emulator flag')
  invariant(env.BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID === PROJECT_ID, `Sync E2E guard project must be ${PROJECT_ID}`)
  invariant(env.FIREBASE_AUTH_EMULATOR_HOST === AUTH_EMULATOR, `Sync E2E Auth host must be ${AUTH_EMULATOR}`)
  invariant(env.FIRESTORE_EMULATOR_HOST === FIRESTORE_EMULATOR, `Sync E2E Firestore host must be ${FIRESTORE_EMULATOR}`)

  const isolatedUserData = env.BABYDIARY_TEST_USERDATA
  invariant(typeof isolatedUserData === 'string' && isolatedUserData.length > 0, 'Sync E2E guard requires isolated userData')
  invariant(samePath(isolatedUserData, userDataPath), 'Sync E2E guard userData does not match the Electron userData path')
  const userDataEntry = lstatSync(userDataPath)
  invariant(userDataEntry.isDirectory() && !userDataEntry.isSymbolicLink(), 'Sync E2E guard userData must be a real directory')
  const realUserData = realpathSync(userDataPath)
  invariant(samePath(realUserData, userDataPath), 'Sync E2E guard userData must not traverse a symbolic link')

  const diagnosticPath = env.BABYDIARY_SYNC_E2E_DIAGNOSTICS
  const expectedDiagnosticPath = path.join(realUserData, `sync-e2e-diagnostics-${token}.jsonl`)
  invariant(
    typeof diagnosticPath === 'string' && samePath(diagnosticPath, expectedDiagnosticPath),
    'Sync E2E diagnostic path must be the token-bound file inside isolated userData',
  )
  invariant(samePath(path.dirname(path.resolve(diagnosticPath)), realUserData), 'Sync E2E diagnostic path escaped isolated userData')
  return Object.freeze({ diagnosticPath: path.resolve(diagnosticPath) })
}

export function isAllowedSyncE2EGuardUrl(rawUrl: string, resourceRoot: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }

  if (url.protocol === 'about:') return url.href === 'about:blank'
  if (url.protocol === 'file:') {
    let requestedPath: string
    try {
      requestedPath = fileURLToPath(url)
    } catch {
      return false
    }
    const root = comparablePath(resourceRoot)
    const requested = comparablePath(requestedPath)
    return requested === root || requested.startsWith(`${root}${path.sep}`)
  }

  if (url.username || url.password) return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return false
  const port = Number(url.port)
  if (url.protocol === 'http:') return port === 9099 || port === 8080
  if (url.protocol === 'ws:') return port === 8080
  return false
}

export function createSyncE2EGuard(config: SyncE2EGuardConfig): {
  installSessionGuard: (session: GuardSession, resourceRoot: string) => void
  attachWindowDiagnostics: (window: GuardWindow, resourceRoot: string) => void
  beginShutdown: () => void
  close: () => void
} {
  let descriptor: number
  try {
    descriptor = openSync(config.diagnosticPath, 'wx', 0o600)
    if (process.platform !== 'win32') fchmodSync(descriptor, 0o600)
  } catch (error) {
    void error
    throw new Error(`Sync E2E diagnostic file could not be created exclusively: ${config.diagnosticPath}`)
  }

  let closed = false
  let shuttingDown = false
  let sessionInstalled = false
  let installedSession: GuardSession | null = null
  let sequence = 0
  const attached = new WeakSet<object>()
  const windowPhases = new Map<number, GuardPhase>()
  const webContentsById = new Map<number, object>()
  const windowCloseRecorded = new Set<number>()
  const record = (kind: string, fields: Record<string, DiagnosticValue> = {}): void => {
    invariant(!closed, 'Sync E2E diagnostic file is already closed')
    const line = `${JSON.stringify({
      kind,
      sequence: sequence += 1,
      timestamp: new Date().toISOString(),
      ...fields,
    })}\n`
    writeSync(descriptor, line, undefined, 'utf8')
    fsyncSync(descriptor)
  }

  const markWindowClosing = (webContentsId: number): void => {
    windowPhases.set(webContentsId, 'closing')
    if (windowCloseRecorded.has(webContentsId)) return
    windowCloseRecorded.add(webContentsId)
    record('teardown-start', {
      phase: 'closing',
      source: 'window-close',
      webContentsId,
    })
  }

  const installSessionGuard = (session: GuardSession, resourceRoot: string): void => {
    invariant(!sessionInstalled, 'Sync E2E session guard was installed more than once')
    sessionInstalled = true
    installedSession = session
    session.webRequest.onBeforeRequest(
      { urls: ['<all_urls>'] },
      (details, callback) => {
        const allowed = isAllowedSyncE2EGuardUrl(details.url, resourceRoot)
        if (!allowed) record('network-blocked', safeUrlFields(details.url, resourceRoot))
        callback({ cancel: !allowed })
      },
    )
    session.webRequest.onErrorOccurred(
      { urls: ['<all_urls>'] },
      details => {
        const webContentsId = details.webContentsId
        if (!Number.isInteger(webContentsId) || Number(webContentsId) <= 0) return
        const phase = windowPhases.get(Number(webContentsId))
        if (!phase) return
        const rawUrl = typeof details.url === 'string' ? details.url : ''
        record('network-error', {
          phase,
          webContentsId: Number(webContentsId),
          method: safeRequestMethod(details.method),
          error: safeNetworkError(details.error),
          target: isExactFirestoreListenChannel(rawUrl) ? 'firestore-listen-channel' : 'other',
          urlSha256: createHash('sha256').update(rawUrl).digest('hex'),
        })
      },
    )
    record('guard-ready')
  }

  const attachWindowDiagnostics = (window: GuardWindow, resourceRoot: string): void => {
    const webContents = window.webContents
    if (attached.has(webContents as object)) return
    invariant(
      Number.isInteger(webContents.id) && webContents.id > 0,
      'Sync E2E window requires a positive webContents id',
    )
    invariant(
      !webContentsById.has(webContents.id),
      `Sync E2E webContents id ${webContents.id} was attached more than once`,
    )
    attached.add(webContents as object)
    webContentsById.set(webContents.id, webContents as object)
    windowPhases.set(webContents.id, shuttingDown ? 'closing' : 'active')
    window.on('close', () => {
      markWindowClosing(webContents.id)
    })

    webContents.on('console-message', (...args: unknown[]) => {
      const details = args.find(value => isRecord(value) && 'level' in value) as Record<string, unknown> | undefined
      const level = details?.level ?? args[1]
      if (level !== 'error' && level !== 3) return
      const source = details?.sourceId ?? args[4]
      const lineNumber = details?.lineNumber ?? args[3]
      const message = details?.message ?? args[2]
      record('console-error', {
        phase: windowPhases.get(webContents.id) ?? 'active',
        webContentsId: webContents.id,
        ...safeUrlFields(source, resourceRoot),
        ...(typeof lineNumber === 'number' ? { line: lineNumber } : {}),
        summary: safeConsoleSummary(message),
      })
    })

    const blockNavigation = (...args: unknown[]): void => {
      const rawUrl = eventUrl(args)
      if (typeof rawUrl === 'string' && isAllowedSyncE2EGuardUrl(rawUrl, resourceRoot)) return
      preventNavigation(args)
      record('navigation-blocked', safeUrlFields(rawUrl, resourceRoot))
    }
    webContents.on('will-navigate', blockNavigation)
    webContents.on('will-frame-navigate', blockNavigation)

    webContents.on('did-fail-load', (...args: unknown[]) => {
      const errorCode = typeof args[1] === 'number' ? args[1] : 0
      const rawUrl = typeof args[3] === 'string' ? args[3] : eventUrl(args)
      record('load-failed', {
        errorCode,
        mainFrame: typeof args[4] === 'boolean' ? args[4] : false,
        ...safeUrlFields(rawUrl, resourceRoot),
      })
    })

    webContents.on('render-process-gone', (...args: unknown[]) => {
      const details = args.find(value => isRecord(value) && ('reason' in value || 'exitCode' in value)) as Record<string, unknown> | undefined
      const reason = safeReason(details?.reason)
      if (reason === 'clean-exit') return
      record('renderer-gone', {
        reason,
        ...(typeof details?.exitCode === 'number' ? { exitCode: details.exitCode } : {}),
      })
    })

    webContents.on('preload-error', (...args: unknown[]) => {
      record('preload-error', safeUrlFields(eventUrl(args), resourceRoot))
    })
    webContents.on('unresponsive', () => record('renderer-unresponsive'))
  }

  return {
    installSessionGuard,
    attachWindowDiagnostics,
    beginShutdown: () => {
      shuttingDown = true
      for (const webContentsId of Array.from(windowPhases.keys())) {
        windowPhases.set(webContentsId, 'closing')
      }
    },
    close: () => {
      if (closed) return
      installedSession?.webRequest.onErrorOccurred(null)
      installedSession = null
      closed = true
      fsyncSync(descriptor)
      closeSync(descriptor)
    },
  }
}
