/**
 * Fail-closed Firebase emulator transport and account/family continuity
 * contracts for the exact published v0.3.8 -> packaged v0.3.9 gate.
 *
 * This module never imports application code. The historical app therefore
 * remains byte-for-byte unchanged while CDP rewrites only its Firebase wire
 * requests to loopback emulators.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const UPGRADE_FIREBASE_PROJECT_ID = 'demo-baby-diary'
export const UPGRADE_FIREBASE_AUTH_PORT = 9099
export const UPGRADE_FIRESTORE_PORT = 8080

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const DEFAULT_ENDPOINTS = Object.freeze({
  auth: Object.freeze({ host: '127.0.0.1', port: UPGRADE_FIREBASE_AUTH_PORT }),
  firestore: Object.freeze({ host: '127.0.0.1', port: UPGRADE_FIRESTORE_PORT }),
})
const REPOSITORY_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const V038_SOURCE_COMMIT = '4ad44829c0de56da33d9123c16f92e6090f0df4a'
const DEMO_API_KEY = 'demo-api-key'

export const V038_DEFAULT_FIREBASE_EVIDENCE = Object.freeze({
  sourceCommit: V038_SOURCE_COMMIT,
  apiKeySha256: 'c70a06a2b1c891576652b4f9ac9a2961743c1aa45031e26649a11dd1b0ed7a81',
  configSha256: '5ff4434f8c956cffec008f8d173d57f9ea34bd29553abfe22826a08eb09811e8',
})

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function loadExactV038DefaultFirebaseConfig() {
  let source
  try {
    source = execFileSync('git', [
      '-C', REPOSITORY_ROOT,
      'show', `${V038_SOURCE_COMMIT}:src/sync/defaultFirebaseConfig.ts`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    throw new Error('exact v0.3.8 Firebase config source is unavailable')
  }
  const body = /DEFAULT_FIREBASE_CONFIG[^=]*=\s*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
  const config = {}
  for (const match of body.matchAll(/([A-Za-z][A-Za-z0-9]*)\s*:\s*'([^']*)'/g)) {
    config[match[1]] = match[2]
  }
  const expectedKeys = [
    'apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId',
  ].sort()
  invariant(stableJson(Object.keys(config).sort()) === stableJson(expectedKeys),
    'exact v0.3.8 Firebase config shape changed')
  invariant(sha256(config.apiKey) === V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256,
    'exact v0.3.8 Firebase API-key digest changed')
  invariant(sha256(stableJson(config)) === V038_DEFAULT_FIREBASE_EVIDENCE.configSha256,
    'exact v0.3.8 Firebase config digest changed')
  return Object.freeze(config)
}

const V038_DEFAULT_FIREBASE_CONFIG = loadExactV038DefaultFirebaseConfig()
const DEMO_API_KEY_SHA256 = sha256(DEMO_API_KEY)

function parseEndpoint(value, label, expectedPort) {
  invariant(typeof value === 'string' && value.length > 0, `${label} emulator host is required`)
  const match = /^([A-Za-z0-9.:-]+):(\d+)$/.exec(value)
  invariant(match, `${label} emulator host must use host:port without a URL scheme`)
  const rawHost = match[1].replace(/^\[|\]$/g, '').toLowerCase()
  invariant(LOOPBACK_HOSTS.has(rawHost), `${label} emulator must use a loopback host`)
  const port = Number(match[2])
  invariant(port === expectedPort, `${label} emulator must use port ${expectedPort}`)
  return { host: '127.0.0.1', port }
}

export function validateUpgradeEmulatorEnvironment(env = process.env) {
  invariant(env.BABYDIARY_UPGRADE_FIREBASE_EMULATOR === '1',
    'published-upgrade Firebase emulator mode must be explicitly enabled')
  invariant(env.BABYDIARY_UPGRADE_FIREBASE_PROJECT_ID === UPGRADE_FIREBASE_PROJECT_ID,
    `published-upgrade Firebase project must be ${UPGRADE_FIREBASE_PROJECT_ID}`)
  return {
    projectId: UPGRADE_FIREBASE_PROJECT_ID,
    auth: parseEndpoint(env.FIREBASE_AUTH_EMULATOR_HOST, 'Auth', UPGRADE_FIREBASE_AUTH_PORT),
    firestore: parseEndpoint(env.FIRESTORE_EMULATOR_HOST, 'Firestore', UPGRADE_FIRESTORE_PORT),
  }
}

/** Config accepted by the exact v0.3.8 settings schema. */
export function buildUpgradeFirebaseConfig() {
  return { ...V038_DEFAULT_FIREBASE_CONFIG }
}

export function buildUpgradeTransportPolicy(mode = 'demo') {
  invariant(mode === 'demo' || mode === 'published-v038', 'upgrade transport policy mode is invalid')
  return mode === 'demo'
    ? {
        allowedApiKeySha256s: new Set([DEMO_API_KEY_SHA256]),
        allowedFirestoreProjectIds: new Set([UPGRADE_FIREBASE_PROJECT_ID]),
      }
    : {
        allowedApiKeySha256s: new Set([V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256]),
        allowedFirestoreProjectIds: new Set([V038_DEFAULT_FIREBASE_CONFIG.projectId]),
      }
}

/**
 * DNS is denied before Chromium creates its first renderer. CDP later changes
 * the three approved Firebase origins to literal loopback URLs, which are the
 * only exclusions from the resolver deny rule.
 */
export function buildFailClosedChromiumArgs({ denyProxyPort } = {}) {
  invariant(Number.isSafeInteger(denyProxyPort) && denyProxyPort > 0 && denyProxyPort <= 65_535,
    'loopback deny-proxy port is invalid')
  return [
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-features=OptimizationHints,MediaRouter',
    `--proxy-server=http://127.0.0.1:${denyProxyPort}`,
    '--proxy-bypass-list=localhost;127.0.0.1;[::1]',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]',
  ]
}

/**
 * Chromium is pointed at this proxy before process creation. Every non-loopback
 * socket (including IP literals and worker targets that predate CDP attach) is
 * therefore terminated on loopback. The proxy deliberately never reads or
 * stores request bytes, so CONNECT credentials cannot enter diagnostics.
 */
export async function startUpgradeDenyProxy() {
  let blockedConnections = 0
  const sockets = new Set()
  const server = createServer(socket => {
    blockedConnections += 1
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.destroy()
  })
  server.on('error', () => {
    // The listen/close promises surface lifecycle errors without URL payloads.
  })
  await new Promise((resolvePromise, rejectPromise) => {
    const onError = error => rejectPromise(new Error(`loopback deny proxy failed: ${error?.code ?? 'listen'}`))
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolvePromise()
    })
  })
  const address = server.address()
  invariant(address && typeof address === 'object' && Number.isSafeInteger(address.port),
    'loopback deny proxy did not expose a port')
  let closed = false
  return {
    port: address.port,
    getEvidence: () => ({ blockedConnections }),
    async close() {
      if (closed) return
      closed = true
      for (const socket of sockets) socket.destroy()
      await new Promise((resolvePromise, rejectPromise) => {
        server.close(error => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') rejectPromise(error)
          else resolvePromise()
        })
      })
    },
  }
}

function rewrittenUrl(url, host, port, prefix = '') {
  return `http://${host}:${port}${prefix}${url.pathname}${url.search}`
}

/** Pure request decision used by both the CDP handler and unit tests. */
function isAllowedFileUrl(url, allowedFileRoot) {
  if (typeof allowedFileRoot !== 'string' || allowedFileRoot.length === 0) return false
  // Electron's packaged page has an empty file authority. Any authority is a
  // UNC/device ambiguity, and encoded separators/dot segments must not be
  // decoded into a different containment decision.
  if (url.hostname || /%(?:2f|5c|2e)/i.test(url.pathname)) return false
  if (/^(?:[\\/]{2}|[\\/]{1,2}[?.][\\/])/.test(allowedFileRoot)) return false
  let candidate
  try {
    candidate = fileURLToPath(url)
  } catch {
    return false
  }
  if (process.platform === 'win32' && /^(?:[\\/]{2}|[\\/]{1,2}[?.][\\/])/.test(candidate)) return false
  const root = path.resolve(allowedFileRoot)
  const resolvedCandidate = path.resolve(candidate)
  const comparableRoot = process.platform === 'win32' ? root.toLocaleLowerCase('en-US') : root
  const comparableCandidate = process.platform === 'win32'
    ? resolvedCandidate.toLocaleLowerCase('en-US')
    : resolvedCandidate
  const relative = path.relative(comparableRoot, comparableCandidate)
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function hasExactQueryNames(url, expectedNames) {
  const actual = [...url.searchParams.keys()].sort()
  const expected = [...expectedNames].sort()
  return stableJson(actual) === stableJson(expected)
}

function hasExactAllowedApiKey(url, allowedApiKeySha256s) {
  const keys = url.searchParams.getAll('key')
  return keys.length === 1
    && hasExactQueryNames(url, ['key'])
    && allowedApiKeySha256s instanceof Set
    && allowedApiKeySha256s.has(sha256(keys[0]))
}

function firestoreDatabase(projectId) {
  return `projects/${projectId}/databases/(default)`
}

function hasExactFirestoreDatabase(url, allowedFirestoreProjectIds) {
  if (!(allowedFirestoreProjectIds instanceof Set) || allowedFirestoreProjectIds.size === 0) return false
  const databases = url.searchParams.getAll('database')
  if (databases.length > 0) {
    return databases.length === 1 && [...allowedFirestoreProjectIds]
      .some(projectId => databases[0] === firestoreDatabase(projectId))
  }
  return [...allowedFirestoreProjectIds].some(projectId => {
    const expectedPath = `/v1/${firestoreDatabase(projectId)}`
    return url.pathname === expectedPath || url.pathname.startsWith(`${expectedPath}/`)
  })
}

const IDENTITY_TOOLKIT_PATHS = new Set([
  '/v1/accounts:lookup',
  '/v1/accounts:signInWithPassword',
  '/v1/accounts:signUp',
])
const IDENTITY_TOOLKIT_PASSWORD_POLICY_PATH = '/v2/passwordPolicy'
const FIRESTORE_WEBCHANNEL_PATHS = new Set([
  '/google.firestore.v1.Firestore/Listen/channel',
  '/google.firestore.v1.Firestore/Write/channel',
])
const FIRESTORE_DATABASE_PATH = `/v1/projects/${UPGRADE_FIREBASE_PROJECT_ID}/databases/(default)`

function normalizedMethod(method) {
  return typeof method === 'string' ? method.toUpperCase() : ''
}

function diagnosticHost(url, endpoints = DEFAULT_ENDPOINTS) {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (hostname === 'identitytoolkit.googleapis.com') return 'identity-toolkit'
  if (hostname === 'securetoken.googleapis.com') return 'secure-token'
  if (hostname === 'firestore.googleapis.com') return 'firestore'
  const port = Number(url.port || (url.protocol === 'http:' ? 80 : 0))
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname)) {
    if (port === endpoints.auth.port) return 'loopback-auth'
    if (port === endpoints.firestore.port) return 'loopback-firestore'
    return 'loopback-other'
  }
  return 'other'
}

function diagnosticPathname(url, host) {
  const identityPath = host === 'loopback-auth'
    ? stripExactPrefix(url.pathname, '/identitytoolkit.googleapis.com')
    : host === 'identity-toolkit' ? url.pathname : null
  if (identityPath !== null
    && /^\/v\d+\/[A-Za-z][A-Za-z0-9._:-]{0,80}$/.test(identityPath)) {
    return identityPath
  }
  const tokenPath = host === 'loopback-auth'
    ? stripExactPrefix(url.pathname, '/securetoken.googleapis.com')
    : host === 'secure-token' ? url.pathname : null
  if (tokenPath !== null && /^\/v\d+\/[A-Za-z][A-Za-z0-9._:-]{0,80}$/.test(tokenPath)) {
    return tokenPath
  }
  if (host === 'firestore' || host === 'loopback-firestore') {
    if (FIRESTORE_WEBCHANNEL_PATHS.has(url.pathname)) return url.pathname
    if (url.pathname === FIRESTORE_DATABASE_PATH
      || url.pathname === `${FIRESTORE_DATABASE_PATH}/documents:batchGet`
      || url.pathname === `${FIRESTORE_DATABASE_PATH}/documents:commit`
      || url.pathname === `${FIRESTORE_DATABASE_PATH}/documents:runQuery`) return url.pathname
  }
  return '<redacted>'
}

/**
 * Equality-only shape for the first fail-closed request. It deliberately omits
 * the URL, query values, headers, and body so credentials cannot enter evidence.
 */
export function describeUpgradeBlockedRequest(rawUrl, {
  endpoints = DEFAULT_ENDPOINTS,
  method = '',
} = {}) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return {
      host: 'invalid',
      pathname: '<redacted>',
      method: normalizedMethod(method) || 'UNKNOWN',
      queryParameterNames: [],
      configuredDemoKeyEquality: false,
      requestKeySha256: null,
      hasFragment: false,
      hasUserInfo: false,
      blockReason: 'invalid-url',
    }
  }
  const host = diagnosticHost(url, endpoints)
  const hasFragment = Boolean(url.hash)
  const hasUserInfo = Boolean(url.username || url.password)
  const queryParameterNames = [...url.searchParams.keys()]
    .map(name => (/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : '<other>'))
    .sort()
    .slice(0, 16)
  const requestKeys = url.searchParams.getAll('key')
  let blockReason = 'external-origin'
  if (hasFragment || hasUserInfo) blockReason = 'forbidden-url-components'
  else if (host === 'identity-toolkit') blockReason = 'identity-request-shape'
  else if (host === 'secure-token') blockReason = 'secure-token-request-shape'
  else if (host === 'firestore') blockReason = 'firestore-request-shape'
  else if (host.startsWith('loopback-')) blockReason = 'loopback-request-shape'
  else if (url.protocol === 'file:') blockReason = 'file-path'
  return {
    host,
    pathname: diagnosticPathname(url, host),
    method: normalizedMethod(method) || 'UNKNOWN',
    queryParameterNames,
    configuredDemoKeyEquality: requestKeys.length === 1 && requestKeys[0] === DEMO_API_KEY,
    requestKeySha256: requestKeys.length === 1 ? sha256(requestKeys[0]) : null,
    hasFragment,
    hasUserInfo,
    blockReason,
  }
}

function stripExactPrefix(value, prefix) {
  return value.startsWith(prefix) ? value.slice(prefix.length) : null
}

function isAllowedIdentityToolkitPath(pathname, method) {
  if (IDENTITY_TOOLKIT_PATHS.has(pathname)) return method === 'POST' || method === 'OPTIONS'
  return pathname === IDENTITY_TOOLKIT_PASSWORD_POLICY_PATH
    && (method === 'GET' || method === 'OPTIONS')
}

function isAllowedSecureTokenPath(pathname, method) {
  return pathname === '/v1/token' && (method === 'POST' || method === 'OPTIONS')
}

function isAllowedLoopbackAuthPath(pathname, method) {
  const identityPath = stripExactPrefix(pathname, '/identitytoolkit.googleapis.com')
  if (identityPath !== null) return isAllowedIdentityToolkitPath(identityPath, method)
  const tokenPath = stripExactPrefix(pathname, '/securetoken.googleapis.com')
  return tokenPath !== null && isAllowedSecureTokenPath(tokenPath, method)
}

function isAllowedFirestorePath(pathname, method, allowedFirestoreProjectIds) {
  if (FIRESTORE_WEBCHANNEL_PATHS.has(pathname)) {
    return method === 'GET' || method === 'POST' || method === 'OPTIONS'
  }
  for (const projectId of allowedFirestoreProjectIds ?? []) {
    const databasePath = `/v1/${firestoreDatabase(projectId)}`
    if ([
      `${databasePath}/documents:batchGet`,
      `${databasePath}/documents:commit`,
      `${databasePath}/documents:runQuery`,
    ].includes(pathname)) return method === 'POST' || method === 'OPTIONS'

    const documentsPrefix = `${databasePath}/documents/`
    if (!pathname.startsWith(documentsPrefix)) continue
    const documentPath = pathname.slice(documentsPrefix.length)
    if (!/^(?:families|invites|users)(?:\/[^/]+)*$/.test(documentPath)) return false
    return ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)
  }
  return false
}

export function resolveUpgradeNetworkRequest(rawUrl, {
  endpoints = DEFAULT_ENDPOINTS,
  allowedFileRoot,
  method = 'GET',
  allowedApiKeySha256s = buildUpgradeTransportPolicy('demo').allowedApiKeySha256s,
  allowedFirestoreProjectIds = buildUpgradeTransportPolicy('demo').allowedFirestoreProjectIds,
} = {}) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return { action: 'block', category: 'external' }
  }

  if (url.hash || url.username || url.password) return { action: 'block', category: 'external' }
  const requestMethod = normalizedMethod(method)
  if (url.protocol === 'about:' && url.href === 'about:blank') {
    return { action: 'allow', category: 'local-resource' }
  }
  if (url.protocol === 'data:') return { action: 'allow', category: 'local-resource' }
  if (url.protocol === 'file:' && isAllowedFileUrl(url, allowedFileRoot)) {
    return { action: 'allow', category: 'local-resource' }
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 0))
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname)) {
    const rawAuthority = /^http:\/\/([^/?#]+)/i.exec(String(rawUrl))?.[1]?.toLowerCase()
    const exactAuthorities = new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ])
    if (!rawAuthority || !exactAuthorities.has(rawAuthority)) {
      return { action: 'block', category: 'external' }
    }
    if (port === endpoints.auth.port
      && isAllowedLoopbackAuthPath(url.pathname, requestMethod)
      && hasExactAllowedApiKey(url, allowedApiKeySha256s)) {
      return { action: 'allow', category: 'auth-loopback' }
    }
    if (port === endpoints.firestore.port
      && isAllowedFirestorePath(url.pathname, requestMethod, allowedFirestoreProjectIds)
      && hasExactFirestoreDatabase(url, allowedFirestoreProjectIds)) {
      return { action: 'allow', category: 'firestore-loopback' }
    }
    return { action: 'block', category: 'external' }
  }

  if (url.protocol !== 'https:') return { action: 'block', category: 'external' }
  if (hostname === 'identitytoolkit.googleapis.com'
    && isAllowedIdentityToolkitPath(url.pathname, requestMethod)
    && hasExactAllowedApiKey(url, allowedApiKeySha256s)) {
    return {
      action: 'rewrite',
      category: url.pathname === IDENTITY_TOOLKIT_PASSWORD_POLICY_PATH
        ? 'auth-password-policy'
        : 'auth',
      url: rewrittenUrl(url, endpoints.auth.host, endpoints.auth.port, '/identitytoolkit.googleapis.com'),
    }
  }
  if (hostname === 'securetoken.googleapis.com'
    && isAllowedSecureTokenPath(url.pathname, requestMethod)
    && hasExactAllowedApiKey(url, allowedApiKeySha256s)) {
    return {
      action: 'rewrite',
      category: 'secure-token',
      url: rewrittenUrl(url, endpoints.auth.host, endpoints.auth.port, '/securetoken.googleapis.com'),
    }
  }
  if (hostname === 'firestore.googleapis.com'
    && isAllowedFirestorePath(url.pathname, requestMethod, allowedFirestoreProjectIds)
    && hasExactFirestoreDatabase(url, allowedFirestoreProjectIds)) {
    return {
      action: 'rewrite',
      category: 'firestore',
      url: rewrittenUrl(url, endpoints.firestore.host, endpoints.firestore.port),
    }
  }
  return { action: 'block', category: 'external' }
}

function evidenceKey(decision, offline) {
  if (offline && ['rewrite', 'allow'].includes(decision.action)
    && !['local-resource'].includes(decision.category)) return 'expectedOfflineBlocks'
  if (decision.action === 'block') return 'externalBlocks'
  if (decision.category === 'auth') return 'rewrittenAuth'
  if (decision.category === 'auth-password-policy') return 'rewrittenPasswordPolicy'
  if (decision.category === 'secure-token') return 'rewrittenSecureToken'
  if (decision.category === 'firestore') return 'rewrittenFirestore'
  if (decision.category === 'auth-loopback') return 'allowedAuthLoopback'
  if (decision.category === 'firestore-loopback') return 'allowedFirestoreLoopback'
  return 'allowedLocalResources'
}

/**
 * Installs raw Fetch-domain request-stage interception on one renderer target.
 * Evidence contains only categories/counts and one value-free blocked shape;
 * URLs and credentials are never retained. `setOffline(true)` intentionally blocks emulator traffic while
 * leaving local app resources available so a durable pending event can form.
 */
export async function installCdpUpgradeNetworkGuard(page, {
  endpoints = DEFAULT_ENDPOINTS,
  allowedFileRoot,
  allowedApiKeySha256s = buildUpgradeTransportPolicy('demo').allowedApiKeySha256s,
  allowedFirestoreProjectIds = buildUpgradeTransportPolicy('demo').allowedFirestoreProjectIds,
} = {}) {
  const session = await page.context().newCDPSession(page)
  const evidence = {
    rewrittenAuth: 0,
    rewrittenPasswordPolicy: 0,
    rewrittenSecureToken: 0,
    rewrittenFirestore: 0,
    allowedAuthLoopback: 0,
    allowedFirestoreLoopback: 0,
    allowedLocalResources: 0,
    expectedOfflineBlocks: 0,
    externalBlocks: 0,
  }
  let offline = false
  let closed = false
  let requestHandlingFailed = false
  let firstExternalBlock
  let runtimeRequestKeySha256
  const pendingRequests = new Set()

  const handlePaused = async event => {
    if (closed) return
    const decision = resolveUpgradeNetworkRequest(event?.request?.url, {
      endpoints,
      allowedFileRoot,
      method: event?.request?.method ?? '',
      allowedApiKeySha256s,
      allowedFirestoreProjectIds,
    })
    const key = evidenceKey(decision, offline)
    evidence[key] += 1
    if (decision.action === 'block' && !firstExternalBlock) {
      firstExternalBlock = describeUpgradeBlockedRequest(event?.request?.url, {
        endpoints,
        method: event?.request?.method ?? '',
      })
    }
    if (decision.action !== 'block'
      && ['auth', 'auth-password-policy', 'secure-token', 'auth-loopback'].includes(decision.category)) {
      const requestUrl = new URL(event.request.url)
      const keys = requestUrl.searchParams.getAll('key')
      invariant(keys.length === 1, 'authorized Firebase request key shape changed')
      const digest = sha256(keys[0])
      invariant(runtimeRequestKeySha256 === undefined || runtimeRequestKeySha256 === digest,
        'authorized Firebase request key changed within one renderer phase')
      runtimeRequestKeySha256 = digest
    }
    const blockForOffline = offline && decision.category !== 'local-resource'
    if (decision.action === 'block' || blockForOffline) {
      await session.send('Fetch.failRequest', {
        requestId: event.requestId,
        errorReason: 'BlockedByClient',
      })
      return
    }
    await session.send('Fetch.continueRequest', {
      requestId: event.requestId,
      ...(decision.action === 'rewrite' ? { url: decision.url } : {}),
    })
  }

  const onPaused = event => {
    const task = handlePaused(event)
    pendingRequests.add(task)
    void task.catch(() => { requestHandlingFailed = true })
      .finally(() => pendingRequests.delete(task))
    return task
  }

  const assertRequestsHandled = async () => {
    await Promise.allSettled([...pendingRequests])
    invariant(!requestHandlingFailed, 'network guard request handling failed')
  }

  session.on('Fetch.requestPaused', onPaused)
  await session.send('Network.setBypassServiceWorker', { bypass: true })
  await session.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    handleAuthRequests: false,
  })

  return {
    setOffline(value) {
      invariant(typeof value === 'boolean', 'offline state must be boolean')
      offline = value
    },
    getEvidence() {
      return {
        ...evidence,
        ...(firstExternalBlock ? {
          firstExternalBlock: {
            ...firstExternalBlock,
            queryParameterNames: [...firstExternalBlock.queryParameterNames],
          },
        } : {}),
        ...(runtimeRequestKeySha256 ? { runtimeRequestKeySha256 } : {}),
      }
    },
    async assertReady() {
      await assertRequestsHandled()
    },
    async close() {
      if (closed) return
      closed = true
      session.off?.('Fetch.requestPaused', onPaused)
      let requestError
      try {
        await assertRequestsHandled()
      } catch (error) {
        requestError = error
      }
      try {
        await session.send('Fetch.disable')
      } finally {
        await session.detach()
      }
      if (requestError) throw requestError
    },
  }
}

/** Remove credential material before an error can reach console or disk. */
export function redactUpgradeCredentialText(value) {
  let text = String(value ?? '')
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
  text = text.replace(/\b(password|passwd|api[_-]?key|id[_-]?token|refresh[_-]?token|access[_-]?token|token|email)\s*[:=]\s*[^\s&]+/gi,
    (_match, key) => `${key}=[REDACTED]`)
  return text
}

function decodeFirestoreValue(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value),
    'Firestore emulator returned an invalid value')
  if (Object.prototype.hasOwnProperty.call(value, 'nullValue')) return null
  if (typeof value.stringValue === 'string') return value.stringValue
  if (typeof value.booleanValue === 'boolean') return value.booleanValue
  if (typeof value.integerValue === 'string') {
    const parsed = Number(value.integerValue)
    invariant(Number.isSafeInteger(parsed), 'Firestore emulator integer is unsafe')
    return parsed
  }
  if (typeof value.doubleValue === 'number' && Number.isFinite(value.doubleValue)) return value.doubleValue
  if (typeof value.timestampValue === 'string') return value.timestampValue
  if (value.mapValue && typeof value.mapValue === 'object') {
    return decodeFirestoreFields(value.mapValue.fields ?? {})
  }
  if (value.arrayValue && typeof value.arrayValue === 'object') {
    return (value.arrayValue.values ?? []).map(decodeFirestoreValue)
  }
  throw new Error('Firestore emulator returned an unsupported value')
}

function decodeFirestoreFields(fields) {
  invariant(fields && typeof fields === 'object' && !Array.isArray(fields),
    'Firestore emulator returned invalid fields')
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeFirestoreValue(value)]))
}

async function fetchEmulatorJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { Authorization: 'Bearer owner' },
    signal: AbortSignal.timeout(10_000),
  })
  invariant(response?.ok === true, `Firebase emulator evidence request failed with status ${response?.status ?? 'unknown'}`)
  const result = await response.json()
  invariant(result && typeof result === 'object' && !Array.isArray(result),
    'Firebase emulator evidence response is invalid')
  return result
}

/** Reads emulator admin truth; returned data contains no ID/refresh token. */
export async function readUpgradeEmulatorEvidence({
  uid,
  familyId,
  pendingEvent,
  endpoints = DEFAULT_ENDPOINTS,
  firestoreProjectId = V038_DEFAULT_FIREBASE_CONFIG.projectId,
  fetchImpl = fetch,
}) {
  invariant(typeof uid === 'string' && uid.length > 0, 'emulator evidence uid is required')
  invariant(typeof familyId === 'string' && familyId.length > 0, 'emulator evidence family id is required')
  invariant(pendingEvent && typeof pendingEvent.id === 'string' && Number.isSafeInteger(pendingEvent.rev),
    'emulator evidence pending event is invalid')
  invariant(firestoreProjectId === V038_DEFAULT_FIREBASE_CONFIG.projectId,
    'emulator evidence Firestore project is not the exact v0.3.8 project')

  const authBase = `http://${endpoints.auth.host}:${endpoints.auth.port}`
  const firestoreBase = `http://${endpoints.firestore.host}:${endpoints.firestore.port}`
  const accounts = await fetchEmulatorJson(
    fetchImpl,
    `${authBase}/emulator/v1/projects/${UPGRADE_FIREBASE_PROJECT_ID}/accounts`,
  )
  const users = Array.isArray(accounts.users) ? accounts.users : []
  const account = users.find(item => item?.localId === uid)
  invariant(account && typeof account.email === 'string', 'restored Auth emulator account is missing')

  const documentRoot = `${firestoreBase}/v1/projects/${firestoreProjectId}/databases/(default)/documents`
  const family = await fetchEmulatorJson(
    fetchImpl,
    `${documentRoot}/families/${encodeURIComponent(familyId)}`,
  )
  const familyData = decodeFirestoreFields(family.fields ?? {})
  invariant(typeof familyData.inviteCode === 'string' && /^[A-Z0-9]{6}$/.test(familyData.inviteCode),
    'Firestore emulator family invite is missing')
  invariant(familyData.members && typeof familyData.members === 'object' && !Array.isArray(familyData.members),
    'Firestore emulator family members are missing')

  const cloudEvents = []
  let pageToken
  for (let page = 0; page < 32; page += 1) {
    const query = new URLSearchParams({ pageSize: '1000' })
    if (pageToken) query.set('pageToken', pageToken)
    const pageData = await fetchEmulatorJson(
      fetchImpl,
      `${documentRoot}/families/${encodeURIComponent(familyId)}/events?${query}`,
    )
    for (const document of pageData.documents ?? []) {
      const decoded = decodeFirestoreFields(document?.fields ?? {})
      const event = decoded.event && typeof decoded.event === 'object' ? decoded.event : decoded
      if (event && typeof event.id === 'string') cloudEvents.push(event)
    }
    if (!pageData.nextPageToken) {
      pageToken = undefined
      break
    }
    invariant(typeof pageData.nextPageToken === 'string' && pageData.nextPageToken !== pageToken,
      'Firestore emulator pagination did not advance')
    pageToken = pageData.nextPageToken
  }
  invariant(pageToken === undefined, 'Firestore emulator event pagination exceeded its bound')

  return {
    uid,
    email: account.email,
    familyId,
    inviteCode: familyData.inviteCode,
    memberUids: Object.keys(familyData.members).sort(),
    cloudPendingCopies: cloudEvents.filter(event => (
      event.id === pendingEvent.id && event.rev === pendingEvent.rev
    )).length,
    cloudEventIds: [...new Set(cloudEvents.map(event => event.id))].sort(),
  }
}

function normalizedEvent(event, label) {
  invariant(event && typeof event === 'object' && !Array.isArray(event), `${label} event is missing`)
  invariant(typeof event.id === 'string' && event.id.length > 0, `${label} event id is missing`)
  invariant(Number.isSafeInteger(event.rev) && event.rev >= 1, `${label} event revision is invalid`)
  invariant(typeof event.deleted === 'boolean', `${label} event deletion state is invalid`)
  // v0.3.9 must retain the immutable v0.3.8 source on disk, but uploads a
  // second, auth-bound derivative. The full physical-source proof belongs to
  // projectUpgradeSemantics/assertSemanticPreservation; continuity compares
  // the care-record semantics while ignoring only that expected envelope.
  const {
    mutationId: _mutationId,
    sync: _sync,
    migration: _migration,
    ...semanticEvent
  } = event
  if (semanticEvent.author && typeof semanticEvent.author === 'object'
    && !Array.isArray(semanticEvent.author)) {
    const { uid: _uid, ...semanticAuthor } = semanticEvent.author
    semanticEvent.author = semanticAuthor
  }
  return {
    idSha256: sha256(event.id),
    rev: event.rev,
    deleted: event.deleted,
    semanticSha256: sha256(stableJson(semanticEvent)),
  }
}

/** Builds a credential-free projection suitable for the run-owned comparison file. */
export function snapshotUpgradeContinuity(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'upgrade continuity input is missing')
  invariant(typeof value.uid === 'string' && value.uid.length > 0, 'upgrade account uid is missing')
  invariant(typeof value.email === 'string' && value.email.includes('@'), 'upgrade account email is invalid')
  invariant(typeof value.familyId === 'string', 'upgrade family id is invalid')
  invariant(typeof value.inviteCode === 'string' && /^[A-Z0-9]{6}$/.test(value.inviteCode),
    'upgrade invite code is invalid')
  invariant(Array.isArray(value.memberUids) && value.memberUids.every(item => typeof item === 'string'),
    'upgrade family members are invalid')
  invariant(Number.isSafeInteger(value.pendingCount) && value.pendingCount >= 0,
    'upgrade pending count is invalid')
  invariant(Number.isSafeInteger(value.cloudPendingCopies) && value.cloudPendingCopies >= 0,
    'upgrade cloud pending copy count is invalid')
  invariant(typeof value.authFormVisible === 'boolean' && typeof value.signupAttempted === 'boolean',
    'upgrade auth UI evidence is invalid')
  return {
    version: 2,
    uidSha256: sha256(value.uid),
    emailSha256: sha256(value.email.trim().toLowerCase()),
    familyIdSha256: sha256(value.familyId),
    inviteCodeSha256: sha256(value.inviteCode),
    memberUidSha256s: [...new Set(value.memberUids.map(uid => sha256(uid)))].sort(),
    onlineEvent: normalizedEvent(value.onlineEvent, 'online'),
    pendingEvent: normalizedEvent(value.pendingEvent, 'pending'),
    pendingCount: value.pendingCount,
    cloudPendingCopies: value.cloudPendingCopies,
    authFormVisible: value.authFormVisible,
    signupAttempted: value.signupAttempted,
    ...(value.secondDevice ? {
      secondDevice: {
        uidSha256: sha256(value.secondDevice.uid),
        familyIdSha256: sha256(value.secondDevice.familyId),
        convergedEventIdSha256s: [
          ...new Set((value.secondDevice.convergedEventIds ?? []).map(id => sha256(id))),
        ].sort(),
      },
    } : {}),
  }
}

function sameEvent(left, right) {
  return left?.idSha256 === right?.idSha256
    && left?.rev === right?.rev
    && left?.deleted === right?.deleted
    && left?.semanticSha256 === right?.semanticSha256
}

/** Candidate must restore; it is forbidden to pass by signing up again. */
export function assertUpgradeContinuity(before, after, mode) {
  invariant(before?.version === 2 && after?.version === 2, 'upgrade continuity projection is invalid')
  invariant(after.uidSha256 === before.uidSha256, 'restored account uid changed')
  invariant(after.emailSha256 === before.emailSha256, 'restored account email changed')
  invariant(typeof before.familyIdSha256 === 'string' && after.familyIdSha256 === before.familyIdSha256,
    'restored family identity changed or was cleared')
  invariant(after.inviteCodeSha256 === before.inviteCodeSha256, 'restored family invite changed')
  invariant(after.memberUidSha256s.includes(before.uidSha256), 'restored account is not a family member')
  invariant(sameEvent(after.onlineEvent, before.onlineEvent), 'online event continuity changed')
  invariant(sameEvent(after.pendingEvent, before.pendingEvent), 'pending event continuity changed')
  invariant(after.authFormVisible === false, 'candidate exposed an auth form instead of restoring login')
  invariant(after.signupAttempted === false, 'candidate attempted a forbidden signup fallback')
  invariant(after.pendingCount === 0, 'pending event did not drain after upgrade')
  invariant(after.cloudPendingCopies === 1, 'pending event did not reach cloud exactly once')

  if (mode === 'candidate-first-run') {
    invariant(after.secondDevice && typeof after.secondDevice.uidSha256 === 'string',
      'second-device convergence evidence is missing')
    invariant(after.secondDevice.familyIdSha256 === before.familyIdSha256,
      'second-device family identity did not converge')
    const converged = new Set(after.secondDevice.convergedEventIdSha256s)
    invariant(converged.has(before.onlineEvent.idSha256) && converged.has(before.pendingEvent.idSha256),
      'second-device events did not converge')
  }
}
