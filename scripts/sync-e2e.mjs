/**
 * Two-device packaged Electron sync E2E.
 *
 * This runner is deliberately fail-closed:
 * - it launches only a packaged Windows/macOS executable;
 * - it pins firebase-tools and a demo-* project;
 * - it accepts only the loopback Auth/Firestore emulator ports below;
 * - each app receives a distinct temporary BABYDIARY_TEST_USERDATA directory.
 *
 * Usage: node scripts/sync-e2e.mjs
 */

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { v5 as uuidv5 } from 'uuid'

export const FIREBASE_CLI_VERSION = '15.23.0'
export const FIREBASE_PROJECT_ID = 'demo-baby-diary'
export const FIREBASE_AUTH_PORT = 9099
export const FIRESTORE_PORT = 8080

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
const E2E_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 10_000
const CONTENT_ID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const DEFAULT_FILE_SYSTEM = { existsSync, lstatSync, realpathSync }

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

export function parseEmulatorAddress(value, label, expectedPort) {
  invariant(typeof value === 'string' && value.length > 0, `${label} is required`)
  const match = /^([A-Za-z0-9.-]+):(\d+)$/.exec(value)
  invariant(match, `${label} must use host:port without a URL scheme`)

  const host = match[1].toLowerCase()
  invariant(host === '127.0.0.1' || host === 'localhost', `${label} must use a loopback host`)
  const port = Number(match[2])
  invariant(port === expectedPort, `${label} must use port ${expectedPort}`)
  return { host: '127.0.0.1', port }
}

export function assertEmulatorEnvironment(env) {
  invariant(env.BABYDIARY_FIREBASE_EMULATOR === '1', 'BABYDIARY_FIREBASE_EMULATOR must be 1')
  invariant(
    env.BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID === FIREBASE_PROJECT_ID,
    `Firebase emulator project must be ${FIREBASE_PROJECT_ID}`,
  )
  return {
    projectId: FIREBASE_PROJECT_ID,
    auth: parseEmulatorAddress(
      env.FIREBASE_AUTH_EMULATOR_HOST,
      'FIREBASE_AUTH_EMULATOR_HOST',
      FIREBASE_AUTH_PORT,
    ),
    firestore: parseEmulatorAddress(
      env.FIRESTORE_EMULATOR_HOST,
      'FIRESTORE_EMULATOR_HOST',
      FIRESTORE_PORT,
    ),
  }
}

export function readJavaMajor(versionOutput) {
  const match = /(?:openjdk|java) version\s+"(\d+)(?:[._][^"]*)?"/i.exec(versionOutput)
  invariant(match, 'Java version could not be parsed')
  return Number(match[1])
}

function quoteForInnerCommand(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`
}

export function buildFirebaseCliInvocation({ platform, nodePath, scriptPath }) {
  const npxPrefix = platform === 'win32'
    ? [path.win32.join(path.win32.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npx-cli.js')]
    : []
  const command = platform === 'win32' ? nodePath : 'npx'
  const innerCommand = `${quoteForInnerCommand(nodePath)} ${quoteForInnerCommand(scriptPath)} --inside-emulators`
  const packageArgs = ['--yes', `firebase-tools@${FIREBASE_CLI_VERSION}`]
  return {
    command,
    args: [
      ...npxPrefix,
      ...packageArgs,
      'emulators:exec',
      '--project',
      FIREBASE_PROJECT_ID,
      '--only',
      'auth,firestore',
      innerCommand,
    ],
    versionArgs: [...npxPrefix, ...packageArgs, '--version'],
  }
}

export function packagedResourcePath(executablePath, platform) {
  if (platform === 'win32') {
    if (path.basename(executablePath).toLowerCase() !== 'baby diary.exe') return null
    if (path.basename(path.dirname(executablePath)).toLowerCase() !== 'win-unpacked') return null
    return path.join(path.dirname(executablePath), 'resources', 'app.asar')
  }

  if (platform === 'darwin') {
    const macosDirectory = path.dirname(executablePath)
    const contentsDirectory = path.dirname(macosDirectory)
    const appDirectory = path.dirname(contentsDirectory)
    const unpackedDirectory = path.basename(path.dirname(appDirectory))
    if (
      path.basename(executablePath) !== 'Baby Diary'
      || path.basename(macosDirectory) !== 'MacOS'
      || path.basename(contentsDirectory) !== 'Contents'
      || path.basename(appDirectory) !== 'Baby Diary.app'
      || !['mac', 'mac-arm64', 'mac-universal', 'mac-x64'].includes(unpackedDirectory)
    ) {
      return null
    }
    return path.join(contentsDirectory, 'Resources', 'app.asar')
  }

  return null
}

function comparablePath(value, platform) {
  const normalized = path.normalize(path.resolve(value))
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function assertRealRegularFile(candidate, label, platform, fileSystem) {
  invariant(fileSystem.existsSync(candidate), `${label} not found: ${candidate}`)
  const entry = fileSystem.lstatSync(candidate)
  invariant(
    entry.isFile() && !entry.isSymbolicLink(),
    `${label} must be a real regular file: ${candidate}`,
  )
  const real = fileSystem.realpathSync(candidate)
  invariant(
    comparablePath(real, platform) === comparablePath(candidate, platform),
    `${label} real path must not escape or traverse a symbolic link: ${candidate} -> ${real}`,
  )
  return real
}

export function resolvePackagedExecutable({
  root = ROOT,
  platform = process.platform,
  override,
  fileSystem = DEFAULT_FILE_SYSTEM,
} = {}) {
  invariant(
    platform === 'win32' || platform === 'darwin',
    'Packaged sync E2E supports Windows and macOS only',
  )

  let candidates
  if (override) {
    candidates = [path.resolve(override)]
    invariant(
      packagedResourcePath(candidates[0], platform),
      `Executable must be a packaged Baby Diary app for ${platform}: ${candidates[0]}`,
    )
  } else if (platform === 'win32') {
    candidates = [path.join(root, 'release', 'win-unpacked', 'Baby Diary.exe')]
  } else if (platform === 'darwin') {
    candidates = ['mac', 'mac-arm64', 'mac-universal', 'mac-x64'].map(directory =>
      path.join(root, 'release', directory, 'Baby Diary.app', 'Contents', 'MacOS', 'Baby Diary'),
    )
  }

  const executable = candidates.find(candidate => {
    const resourcePath = packagedResourcePath(candidate, platform)
    return resourcePath && fileSystem.existsSync(candidate) && fileSystem.existsSync(resourcePath)
  })
  const missingMessage = override
    ? `Packaged executable not found: ${candidates[0]}`
    : `Packaged executable not found. Checked: ${candidates.join(', ')}`
  invariant(executable, missingMessage)
  const resourcePath = packagedResourcePath(executable, platform)
  invariant(resourcePath, `Executable must be a packaged Baby Diary app for ${platform}: ${executable}`)
  const realExecutable = assertRealRegularFile(executable, 'Packaged executable', platform, fileSystem)
  assertRealRegularFile(resourcePath, 'Packaged app.asar', platform, fileSystem)
  return realExecutable
}

export function buildSeedSettings(deviceName) {
  const slug = deviceName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return {
    baby: { name: 'Sync Baby', birthdate: '2026-01-15' },
    profile: { uid: `e2e-placeholder-${slug}`, name: deviceName, role: 'mom' },
    familyId: '',
    firebase: {
      apiKey: 'demo-api-key',
      authDomain: `${FIREBASE_PROJECT_ID}.firebaseapp.com`,
      projectId: FIREBASE_PROJECT_ID,
      storageBucket: `${FIREBASE_PROJECT_ID}.appspot.com`,
      messagingSenderId: '1234567890',
      appId: '1:1234567890:web:sync-e2e',
    },
    language: 'ko',
    theme: 'light',
  }
}

export function normalizeConvergence(events) {
  const grouped = new Map()
  for (const event of events) {
    if (!event || typeof event.id !== 'string') continue
    const group = grouped.get(event.id) ?? []
    group.push(event)
    grouped.set(event.id, group)
  }
  return [...grouped.values()].map(group => {
    const event = selectMutationWinner(group)
    return {
      id: event.id,
      rev: event.rev,
      deleted: Boolean(event.deleted),
      ...(event.mutationId ? { mutationId: event.mutationId } : {}),
    }
  }).sort((a, b) => a.id.localeCompare(b.id))
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

export function semanticEventPayload(event) {
  if (!event) return null
  return {
    id: event.id,
    type: event.type,
    at: event.at,
    data: event.data,
    author: event.author,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    rev: event.rev,
    deleted: event.deleted,
    mutationId: event.mutationId,
  }
}

export function semanticEventsEqual(left, right) {
  return stableJson(semanticEventPayload(left)) === stableJson(semanticEventPayload(right))
}

export function normalizeSemanticEvents(events) {
  const grouped = new Map()
  for (const event of events) {
    if (!event || typeof event.id !== 'string') continue
    const group = grouped.get(event.id) ?? []
    group.push(event)
    grouped.set(event.id, group)
  }
  return [...grouped.values()]
    .map(group => semanticEventPayload(selectMutationWinner(group)))
    .sort((left, right) => left.id.localeCompare(right.id))
}

function validateExpectedMutationDynamic(original, dynamic, { startedAt, finishedAt }) {
  invariant(original && Number.isInteger(original.rev) && original.rev >= 1, 'Original event revision is required')
  invariant(
    dynamic && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(dynamic.mutationId),
    'Expected mutation id must be UUID v4',
  )
  invariant(dynamic.mutationId !== original.mutationId, 'Expected mutation id must differ from the original mutation')
  invariant(Number.isFinite(startedAt) && Number.isFinite(finishedAt) && startedAt <= finishedAt, 'Mutation operation bounds are invalid')
  const updatedAt = Date.parse(dynamic.updatedAt)
  invariant(Number.isFinite(updatedAt), 'Expected mutation updatedAt must be valid')
  invariant(
    updatedAt >= startedAt && updatedAt <= finishedAt,
    `Expected mutation updatedAt is outside operation bounds: ${dynamic.updatedAt}`,
  )
}

export function buildExpectedEditedEvent(original, expectedAt, dynamic, bounds) {
  invariant(original && original.deleted === false, 'Only an active original event can be edited')
  invariant(Number.isFinite(Date.parse(expectedAt)), 'Expected edited event time must be valid')
  validateExpectedMutationDynamic(original, dynamic, bounds)
  return {
    ...original,
    at: expectedAt,
    updatedAt: dynamic.updatedAt,
    rev: original.rev + 1,
    mutationId: dynamic.mutationId,
  }
}

export function buildExpectedDeletedEvent(original, dynamic, bounds) {
  invariant(original && original.deleted === false, 'Only an active original event can be deleted')
  validateExpectedMutationDynamic(original, dynamic, bounds)
  return {
    ...original,
    deleted: true,
    updatedAt: dynamic.updatedAt,
    rev: original.rev + 1,
    mutationId: dynamic.mutationId,
  }
}

function compareStrings(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function mutationIdentity(event) {
  if (typeof event.mutationId === 'string') {
    return `mutation:${encodeURIComponent(event.id)}:${event.rev}:${event.mutationId}`
  }
  return `legacy:${encodeURIComponent(event.id)}:${event.rev}:${stableJson(event)}`
}

export function compareMutationEvents(left, right) {
  if (left.rev !== right.rev) return left.rev < right.rev ? -1 : 1
  if (Boolean(left.deleted) !== Boolean(right.deleted)) return left.deleted ? 1 : -1
  const leftUpdatedAt = Number.isFinite(Date.parse(left.updatedAt)) ? Date.parse(left.updatedAt) : -Infinity
  const rightUpdatedAt = Number.isFinite(Date.parse(right.updatedAt)) ? Date.parse(right.updatedAt) : -Infinity
  if (leftUpdatedAt !== rightUpdatedAt) return leftUpdatedAt < rightUpdatedAt ? -1 : 1
  const identityOrder = compareStrings(mutationIdentity(left), mutationIdentity(right))
  if (identityOrder !== 0) return identityOrder
  return compareStrings(stableJson(left), stableJson(right))
}

export function selectMutationWinner(events) {
  invariant(Array.isArray(events) && events.length > 0, 'At least one mutation is required')
  return events.reduce((winner, event) => compareMutationEvents(event, winner) > 0 ? event : winner)
}

export function makeMutationDocId(event) {
  invariant(typeof event.id === 'string' && event.id.length > 0, 'Event id is required')
  invariant(Number.isInteger(event.rev) && event.rev >= 1, 'Event revision is required')
  invariant(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.mutationId), 'Mutation id must be UUID v4')
  const contentId = uuidv5(`baby-diary:event-content:${stableJson(event)}`, CONTENT_ID_NAMESPACE)
  return `m3|${encodeURIComponent(event.id)}|${event.rev}|${event.mutationId}|${contentId}`
}

export function buildSameRevisionConflicts(baseEvent, nowMs = Date.now()) {
  invariant(baseEvent && typeof baseEvent.id === 'string', 'A base event is required')
  invariant(Number.isInteger(baseEvent.rev) && baseEvent.rev >= 1, 'Base event rev must be positive')

  const shiftedAt = minuteDelta => {
    const value = new Date(baseEvent.at)
    invariant(!Number.isNaN(value.getTime()), 'Base event at must be valid')
    value.setMinutes(value.getMinutes() + minuteDelta)
    return value.toISOString()
  }

  return [
    {
      ...baseEvent,
      mutationId: '11111111-1111-4111-8111-111111111111',
      at: shiftedAt(-45),
      updatedAt: new Date(nowMs).toISOString(),
      rev: baseEvent.rev + 1,
      deleted: false,
    },
    {
      ...baseEvent,
      mutationId: '22222222-2222-4222-8222-222222222222',
      at: shiftedAt(45),
      updatedAt: new Date(nowMs).toISOString(),
      rev: baseEvent.rev + 1,
      deleted: false,
    },
  ]
}

function javaEnvironment(env) {
  const javaOverride = env.BABYDIARY_SYNC_E2E_JAVA
  if (!javaOverride) return { command: 'java', env: { ...env } }

  const command = path.resolve(javaOverride)
  invariant(existsSync(command), `Java executable not found: ${command}`)
  const binDir = path.dirname(command)
  const javaHome = path.dirname(binDir)
  return {
    command,
    env: {
      ...env,
      JAVA_HOME: javaHome,
      PATH: `${binDir}${path.delimiter}${env.PATH ?? ''}`,
    },
  }
}

function verifyJava21(env) {
  const java = javaEnvironment(env)
  const result = spawnSync(java.command, ['-version'], { encoding: 'utf8', env: java.env })
  invariant(!result.error, `Java 21 is required: ${result.error?.message ?? 'java failed'}`)
  invariant(result.status === 0, `Java -version failed with exit ${result.status}`)
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const major = readJavaMajor(output)
  invariant(major === 21, `Java 21 is required; found Java ${major}`)
  return java.env
}

function verifyFirebaseCli(invocation, env) {
  const result = spawnSync(
    invocation.command,
    invocation.versionArgs,
    { cwd: ROOT, encoding: 'utf8', env },
  )
  invariant(!result.error, `Firebase CLI preflight failed: ${result.error?.message ?? 'spawn failed'}`)
  invariant(result.status === 0, `Firebase CLI preflight exited ${result.status}: ${result.stderr ?? ''}`)
  invariant(result.stdout.trim() === FIREBASE_CLI_VERSION, `Expected Firebase CLI ${FIREBASE_CLI_VERSION}, got ${result.stdout.trim()}`)
}

function writeSeed(userData, deviceName) {
  mkdirSync(userData, { recursive: true })
  writeFileSync(
    path.join(userData, 'settings.json'),
    `${JSON.stringify(buildSeedSettings(deviceName), null, 2)}\n`,
    'utf8',
  )
}

function appendOfflineEvent(userData, event) {
  const date = new Date(event.at)
  invariant(!Number.isNaN(date.getTime()), 'Offline event at must be valid')
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const dataDirectory = path.join(userData, 'data')
  mkdirSync(dataDirectory, { recursive: true })
  const eventLogPath = path.join(dataDirectory, `events-${year}-${month}.jsonl`)
  const fd = openSync(eventLogPath, 'a')
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`, undefined, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function isAllowedNetworkUrl(rawUrl, { resourcePath } = {}) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }

  if (url.protocol === 'about:') return url.href === 'about:blank'
  if (url.protocol === 'file:') {
    if (!resourcePath) return false
    let requestedPath
    try {
      requestedPath = fileURLToPath(url)
    } catch {
      return false
    }
    const resource = path.normalize(path.resolve(resourcePath))
    const requested = path.normalize(path.resolve(requestedPath))
    const comparisonResource = process.platform === 'win32' ? resource.toLowerCase() : resource
    const comparisonRequested = process.platform === 'win32' ? requested.toLowerCase() : requested
    return comparisonRequested === comparisonResource
      || comparisonRequested.startsWith(`${comparisonResource}${path.sep}`)
  }

  if (url.username || url.password) return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return false
  const port = Number(url.port)
  if (url.protocol === 'http:') {
    return port === FIREBASE_AUTH_PORT || port === FIRESTORE_PORT
  }
  if (url.protocol === 'ws:') return port === FIRESTORE_PORT
  return false
}

export async function installNetworkGuards(context, {
  name,
  resourcePath,
  blockedRequests,
}) {
  const recordBlocked = rawUrl => blockedRequests.push(`${name}: ${rawUrl}`)
  await context.route('**/*', async route => {
    const url = route.request().url()
    if (isAllowedNetworkUrl(url, { resourcePath })) {
      await route.continue()
      return
    }
    recordBlocked(url)
    await route.abort('blockedbyclient')
  })
  invariant(
    typeof context.routeWebSocket === 'function',
    'Playwright context.routeWebSocket is required for fail-closed sync E2E',
  )
  await context.routeWebSocket('**/*', async webSocket => {
    const url = webSocket.url()
    if (isAllowedNetworkUrl(url, { resourcePath })) {
      webSocket.connectToServer()
      return
    }
    recordBlocked(url)
    await webSocket.close({ code: 1008, reason: 'Blocked by sync E2E network policy' })
  })
}

export function attachRendererDiagnostics({
  app,
  context,
  name,
  rendererErrors,
  blockedRequests,
  isClosing,
  resourcePath,
}) {
  const attached = new WeakSet()
  const recordUnexpected = rawUrl => {
    if (!blockedRequests || isAllowedNetworkUrl(rawUrl, { resourcePath })) return
    const diagnostic = `${name}: ${rawUrl}`
    if (!blockedRequests.includes(diagnostic)) blockedRequests.push(diagnostic)
  }
  const attach = page => {
    if (!page || attached.has(page)) return
    attached.add(page)
    page.on('console', message => {
      if (message.type() !== 'error') return
      rendererErrors.push(`${name}: console ${message.text()}`)
    })
    page.on('pageerror', error => {
      rendererErrors.push(`${name}: pageerror ${error?.message ?? String(error)}`)
    })
    page.on('requestfailed', request => {
      const url = request.url()
      const errorText = request.failure()?.errorText ?? 'unknown failure'
      const expectedCloseAbort = isClosing()
        && isAllowedNetworkUrl(url, { resourcePath })
        && /ERR_ABORTED|ERR_CANCELED|ERR_CONNECTION_CLOSED/i.test(errorText)
      if (!expectedCloseAbort) {
        rendererErrors.push(`${name}: requestfailed ${url} ${errorText}`)
      }
    })
    page.on('request', request => recordUnexpected(request.url()))
    page.on('framenavigated', frame => recordUnexpected(frame.url()))
  }
  for (const page of context.pages()) attach(page)
  app.on('window', attach)
}

export function assertCleanDiagnostics(blockedRequests, rendererErrors) {
  invariant(
    blockedRequests.length === 0,
    `Blocked non-emulator network requests: ${blockedRequests.join(' | ')}`,
  )
  invariant(
    rendererErrors.length === 0,
    `Unexpected renderer errors: ${rendererErrors.join(' | ')}`,
  )
}

export function collectPersistentGuardDiagnostics(
  diagnosticFiles,
  blockedRequests,
  rendererErrors,
) {
  for (const diagnosticFile of diagnosticFiles) {
    invariant(
      diagnosticFile
        && typeof diagnosticFile.name === 'string'
        && typeof diagnosticFile.path === 'string',
      'Persistent guard diagnostic descriptor is invalid',
    )
    invariant(existsSync(diagnosticFile.path), `${diagnosticFile.name}: persistent guard diagnostic file is missing`)
    const entry = lstatSync(diagnosticFile.path)
    invariant(
      entry.isFile() && !entry.isSymbolicLink(),
      `${diagnosticFile.name}: persistent guard diagnostic must be a real regular file`,
    )
    invariant(
      comparablePath(realpathSync(diagnosticFile.path), process.platform)
        === comparablePath(diagnosticFile.path, process.platform),
      `${diagnosticFile.name}: persistent guard diagnostic path traversed a symbolic link`,
    )

    const lines = readFileSync(diagnosticFile.path, 'utf8')
      .split(/\r?\n/)
      .filter(line => line.length > 0)
    let readyCount = 0
    for (let index = 0; index < lines.length; index += 1) {
      let record
      try {
        record = JSON.parse(lines[index])
      } catch {
        throw new Error(`${diagnosticFile.name}: malformed persistent guard diagnostic at line ${index + 1}`)
      }
      invariant(record && typeof record === 'object' && !Array.isArray(record), `${diagnosticFile.name}: invalid persistent guard diagnostic at line ${index + 1}`)
      if (record.kind === 'guard-ready') {
        readyCount += 1
        continue
      }
      if (record.kind === 'network-blocked' || record.kind === 'navigation-blocked') {
        const protocol = typeof record.protocol === 'string' ? record.protocol : 'unknown'
        const destination = typeof record.destination === 'string' ? record.destination : 'unknown'
        blockedRequests.push(`${diagnosticFile.name}: early ${record.kind} ${protocol} ${destination}`)
        continue
      }
      if (record.kind === 'renderer-gone') {
        const reason = typeof record.reason === 'string' ? record.reason : 'unknown'
        const exitCode = typeof record.exitCode === 'number' ? ` (${record.exitCode})` : ''
        rendererErrors.push(`${diagnosticFile.name}: early renderer-gone ${reason}${exitCode}`)
        continue
      }
      if (['console-error', 'load-failed', 'preload-error', 'renderer-unresponsive'].includes(record.kind)) {
        rendererErrors.push(`${diagnosticFile.name}: early ${record.kind}`)
        continue
      }
      throw new Error(`${diagnosticFile.name}: unknown persistent guard diagnostic kind at line ${index + 1}`)
    }
    invariant(readyCount === 1, `${diagnosticFile.name}: expected exactly one guard-ready diagnostic, got ${readyCount}`)
  }
}

function aggregateErrors(primaryError, additionalErrors, message) {
  const errors = [primaryError, ...additionalErrors].filter(Boolean)
  if (errors.length === 1) return errors[0]
  return new AggregateError(errors, message)
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function withTimeout(promise, timeoutMs, label) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function parseProcessTable(output) {
  return String(output).split(/\r?\n/).flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]) }] : []
  })
}

export function ownedProcessTreePids(rootPid, rows) {
  invariant(Number.isInteger(rootPid) && rootPid > 1, `Refusing unsafe process id: ${rootPid}`)
  const children = new Map()
  for (const row of rows) {
    const values = children.get(row.parentPid) ?? []
    values.push(row.pid)
    children.set(row.parentPid, values)
  }
  const result = []
  const visit = pid => {
    for (const childPid of children.get(pid) ?? []) visit(childPid)
    result.push(pid)
  }
  visit(rootPid)
  return [...new Set(result)]
}

export async function killOwnedProcessTree(
  pid,
  { platform = process.platform, spawnSyncImpl = spawnSync, killImpl = process.kill } = {},
) {
  invariant(Number.isInteger(pid) && pid > 1 && pid !== process.pid, `Refusing unsafe process id: ${pid}`)
  if (platform === 'win32') {
    const result = spawnSyncImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    invariant(!result.error, `taskkill failed: ${result.error?.message ?? 'spawn failed'}`)
    invariant(result.status === 0, `taskkill failed for owned pid ${pid}: ${result.stderr ?? ''}`)
    return
  }
  invariant(platform === 'darwin', `Unsupported cleanup platform: ${platform}`)
  const result = spawnSyncImpl('/bin/ps', ['-ax', '-o', 'pid=,ppid='], { encoding: 'utf8' })
  invariant(!result.error && result.status === 0, `ps failed while cleaning owned pid ${pid}`)
  for (const ownedPid of ownedProcessTreePids(pid, parseProcessTable(result.stdout))) {
    try {
      killImpl(ownedPid, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
}

export async function closeDevice(
  device,
  { timeoutMs = CLOSE_TIMEOUT_MS, killTree = killOwnedProcessTree } = {},
) {
  if (!device?.app) return
  const app = device.app
  let childProcess
  let pid
  try {
    childProcess = app.process()
    pid = childProcess?.pid
  } catch {
    pid = undefined
  }
  device.closing = true
  const closeErrors = []
  try {
    await withTimeout(Promise.resolve().then(() => app.close()), timeoutMs, `${device.name ?? 'device'} close`)
  } catch (error) {
    closeErrors.push(error)
    const childStillRunning = childProcess?.exitCode == null && childProcess?.signalCode == null
    if (childStillRunning && Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
      try {
        await killTree(pid)
      } catch (killError) {
        closeErrors.push(killError)
      }
    } else if (childStillRunning) {
      closeErrors.push(new Error(`${device.name ?? 'device'} did not expose a safe owned pid`))
    }
  } finally {
    device.app = null
  }
  if (closeErrors.length === 1) throw closeErrors[0]
  if (closeErrors.length > 1) {
    throw new AggregateError(closeErrors, `${device.name ?? 'device'} cleanup failed`)
  }
}

export async function cleanupPartialDevice(device, primaryError, close = closeDevice) {
  const cleanupErrors = []
  try {
    await close(device)
  } catch (error) {
    cleanupErrors.push(error)
  }
  throw aggregateErrors(primaryError, cleanupErrors, `${device?.name ?? 'device'} launch and cleanup failed`)
}

export async function removeTempDirectoryWithRetry(
  rootTemp,
  { remove = candidate => rmSync(candidate, { recursive: true, force: true }), retries = 4 } = {},
) {
  let lastError
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      await remove(rootTemp)
      return
    } catch (error) {
      lastError = error
      if (attempt + 1 < retries) await delay(100 * (attempt + 1))
    }
  }
  throw lastError ?? new Error(`Failed to remove temporary directory: ${rootTemp}`)
}

export async function finalizeRun({
  devices,
  rootTemp,
  diagnosticFiles = [],
  blockedRequests,
  rendererErrors,
  primaryError,
  close = closeDevice,
  removeTemp = removeTempDirectoryWithRetry,
}) {
  const finalErrors = []
  const closeResults = await Promise.allSettled(devices.filter(Boolean).map(device => close(device)))
  for (const result of closeResults) {
    if (result.status === 'rejected') finalErrors.push(result.reason)
  }
  try {
    collectPersistentGuardDiagnostics(diagnosticFiles, blockedRequests, rendererErrors)
  } catch (error) {
    finalErrors.push(error)
  }
  try {
    assertCleanDiagnostics(blockedRequests, rendererErrors)
  } catch (error) {
    finalErrors.push(error)
  }
  try {
    await removeTemp(rootTemp)
  } catch (error) {
    finalErrors.push(error)
  }
  if (primaryError || finalErrors.length > 0) {
    throw aggregateErrors(primaryError, finalErrors, 'Packaged sync E2E failed or leaked resources')
  }
}

async function launchDevice({
  executablePath,
  userData,
  name,
  rendererErrors,
  blockedRequests,
  diagnosticFiles,
}) {
  const { _electron: electron } = await import('playwright')
  const resourcePath = packagedResourcePath(executablePath, process.platform)
  invariant(resourcePath, `${name}: packaged resource path could not be derived`)
  const guardToken = randomBytes(32).toString('hex')
  const diagnosticPath = path.join(userData, `sync-e2e-diagnostics-${guardToken}.jsonl`)
  diagnosticFiles.push({ name, path: diagnosticPath })
  const device = { app: null, page: null, userData, name, closing: false }
  try {
    const app = await electron.launch({
      executablePath,
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        BABYDIARY_TEST_USERDATA: userData,
        BABYDIARY_SYNC_E2E_EARLY_GUARD: '1',
        BABYDIARY_SYNC_E2E_GUARD_TOKEN: guardToken,
        BABYDIARY_SYNC_E2E_DIAGNOSTICS: diagnosticPath,
        BABYDIARY_FIREBASE_EMULATOR: '1',
        BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID: FIREBASE_PROJECT_ID,
        FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${FIREBASE_AUTH_PORT}`,
        FIRESTORE_EMULATOR_HOST: `127.0.0.1:${FIRESTORE_PORT}`,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
    })
    device.app = app
    const context = app.context()
    await installNetworkGuards(context, { name, resourcePath, blockedRequests })
    attachRendererDiagnostics({
      app,
      context,
      name,
      rendererErrors,
      blockedRequests,
      isClosing: () => device.closing,
      resourcePath,
    })
    const page = await app.firstWindow({ timeout: E2E_TIMEOUT_MS })
    device.page = page
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.waitForSelector('[data-tour="navigation"]', { timeout: E2E_TIMEOUT_MS })
    return device
  } catch (error) {
    await cleanupPartialDevice(device, error)
  }
}

async function dismissFirstLaunch(device) {
  const { page } = device
  const onboardingComplete = await page.evaluate(() => (
    localStorage.getItem('babydiary.langChosen') === '1'
    && localStorage.getItem('babydiary.tutorial.v2') !== null
  ))
  if (onboardingComplete) return

  // App.tsx makes its first-launch decision asynchronously. Wait for the
  // decision itself instead of assuming a fixed renderer speed in CI.
  await page.locator('.lang-picker-overlay, .tour-card').first().waitFor({
    state: 'visible',
    timeout: E2E_TIMEOUT_MS,
  })
  const picker = page.locator('.lang-picker-overlay')
  if (await picker.isVisible().catch(() => false)) {
    await page.locator('.lang-picker-btn[lang="ko"]').click()
    await page.locator('.tour-card').waitFor({ state: 'visible', timeout: E2E_TIMEOUT_MS })
  }

  const tour = page.locator('.tour-card')
  if (await tour.isVisible().catch(() => false)) {
    await page.locator('.tour-skip-button').first().click()
    await tour.waitFor({ state: 'detached', timeout: E2E_TIMEOUT_MS })
  }
}

async function openSettings(device) {
  const { page } = device
  await page.locator('[data-tour="nav-settings"]').click()
  await page.waitForSelector('[data-tour="settings-main"]', { timeout: E2E_TIMEOUT_MS })
  const container = page.locator('[data-sync-settings]')
  await container.scrollIntoViewIfNeeded()
  const details = container.locator('details')
  if (!(await details.evaluate(element => element.open))) {
    await container.locator('summary').click()
  }
  await container.locator('[data-sync-state]').waitFor({ state: 'visible', timeout: E2E_TIMEOUT_MS })
}

async function signUpDevice(device, email, password) {
  const { page, name } = device
  await openSettings(device)
  await page.locator('[data-sync-auth-form="login"]').waitFor({ state: 'visible', timeout: E2E_TIMEOUT_MS })
  await page.locator('[data-sync-switch-mode]').click()
  await page.locator('[data-sync-auth-form="signup"]').waitFor({ state: 'visible', timeout: E2E_TIMEOUT_MS })
  invariant(await page.locator('[data-sync-keep-logged-in]').isChecked(), `${name}: keep logged in must default to checked`)
  const keepLoggedInTarget = await page.locator('[data-sync-keep-logged-in-hit-target]').boundingBox()
  invariant(
    keepLoggedInTarget && keepLoggedInTarget.height >= 40,
    `${name}: keep logged in target must be at least 40px high`,
  )
  await page.locator('[data-sync-email]').fill(email)
  await page.locator('[data-sync-password]').fill(password)
  await page.locator('[data-sync-submit]').click()
  await page.locator('[data-sync-family-choice="create"]').waitFor({ state: 'visible', timeout: E2E_TIMEOUT_MS })
  await page.waitForFunction(
    async () => {
      const settings = await window.babyDiary.getSettings()
      return Boolean(settings.profile?.uid && !settings.profile.uid.startsWith('e2e-placeholder-'))
    },
    undefined,
    { timeout: E2E_TIMEOUT_MS },
  )
}

async function createFamilyOn(device) {
  const { page } = device
  await page.locator('[data-sync-family-choice="create"]').click()
  await page.locator('[data-sync-family-submit="create"]').click()
  await page.locator('[data-sync-state="online"]').waitFor({ state: 'visible', timeout: E2E_TIMEOUT_MS })
  await page.waitForFunction(
    () => /^[A-Z0-9]{6}$/.test(document.querySelector('[data-sync-invite-code-value]')?.textContent?.trim() ?? ''),
    undefined,
    { timeout: E2E_TIMEOUT_MS },
  )
  const inviteCode = (await page.locator('[data-sync-invite-code-value]').textContent())?.trim() ?? ''
  invariant(/^[A-Z0-9]{6}$/.test(inviteCode), `Expected a six-character invite code, got ${inviteCode}`)
  return inviteCode
}

async function joinFamilyOn(device, inviteCode) {
  const { page } = device
  await page.locator('[data-sync-family-choice="join"]').click()
  await page.locator('[data-sync-invite-code-input]').fill(inviteCode)
  await page.locator('[data-sync-family-submit="join"]').click()
  await page.locator('[data-sync-state="online"]').waitFor({ state: 'visible', timeout: E2E_TIMEOUT_MS })
}

async function openHome(device) {
  await device.page.locator('[data-tour="nav-home"]').click()
  await device.page.waitForSelector('[data-tour="quick-row"]', { timeout: E2E_TIMEOUT_MS })
}

async function readSnapshot(device) {
  return device.page.evaluate(async () => ({
    events: await window.babyDiary.listEvents(),
    mutations: await window.babyDiary.listEventMutations(),
    settings: await window.babyDiary.getSettings(),
    dataInfo: await window.babyDiary.getDataInfo(),
  }))
}

function convergencePayload(event) {
  return semanticEventPayload(event)
}

async function waitForConflictConvergence(deviceA, deviceB, expectedEvent) {
  const deadline = Date.now() + E2E_TIMEOUT_MS
  const expected = convergencePayload(expectedEvent)
  let lastA = null
  let lastB = null
  while (Date.now() < deadline) {
    const [snapshotA, snapshotB] = await Promise.all([
      readSnapshot(deviceA),
      readSnapshot(deviceB),
    ])
    lastA = convergencePayload(snapshotA.events.find(event => event.id === expectedEvent.id))
    lastB = convergencePayload(snapshotB.events.find(event => event.id === expectedEvent.id))
    if (
      lastA?.rev >= 2
      && lastB?.rev >= 2
      && semanticEventsEqual(lastA, lastB)
      && semanticEventsEqual(lastA, expected)
    ) {
      return lastA
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  throw new Error(
    `Same-revision conflict did not converge: ${JSON.stringify(lastA)} / ${JSON.stringify(lastB)}`,
  )
}

function decodeFirestoreValue(value) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'Firestore value must be an object')
  const variants = [
    'nullValue',
    'stringValue',
    'booleanValue',
    'integerValue',
    'doubleValue',
    'timestampValue',
    'mapValue',
    'arrayValue',
  ].filter(key => Object.prototype.hasOwnProperty.call(value, key))
  invariant(variants.length === 1, 'Firestore value must contain exactly one supported type')
  switch (variants[0]) {
    case 'nullValue':
      invariant(value.nullValue === null, 'Firestore nullValue is invalid')
      return null
    case 'stringValue':
      invariant(typeof value.stringValue === 'string', 'Firestore stringValue is invalid')
      return value.stringValue
    case 'booleanValue':
      invariant(typeof value.booleanValue === 'boolean', 'Firestore booleanValue is invalid')
      return value.booleanValue
    case 'integerValue': {
      invariant(typeof value.integerValue === 'string' && /^-?\d+$/.test(value.integerValue), 'Firestore integerValue is invalid')
      const integer = Number(value.integerValue)
      invariant(Number.isSafeInteger(integer), 'Firestore integerValue exceeds the safe range')
      return integer
    }
    case 'doubleValue': {
      const double = typeof value.doubleValue === 'number'
        ? value.doubleValue
        : Number(value.doubleValue)
      invariant(Number.isFinite(double), 'Firestore doubleValue is invalid')
      return double
    }
    case 'timestampValue':
      invariant(typeof value.timestampValue === 'string' && Number.isFinite(Date.parse(value.timestampValue)), 'Firestore timestampValue is invalid')
      return value.timestampValue
    case 'mapValue': {
      invariant(value.mapValue && typeof value.mapValue === 'object' && !Array.isArray(value.mapValue), 'Firestore mapValue is invalid')
      const fields = value.mapValue.fields ?? {}
      invariant(fields && typeof fields === 'object' && !Array.isArray(fields), 'Firestore map fields are invalid')
      return Object.fromEntries(
        Object.entries(fields).map(([key, entry]) => [key, decodeFirestoreValue(entry)]),
      )
    }
    case 'arrayValue': {
      invariant(value.arrayValue && typeof value.arrayValue === 'object' && !Array.isArray(value.arrayValue), 'Firestore arrayValue is invalid')
      const values = value.arrayValue.values ?? []
      invariant(Array.isArray(values), 'Firestore array values are invalid')
      return values.map(decodeFirestoreValue)
    }
    default:
      throw new Error('Unsupported Firestore value type')
  }
}

export function decodeFirestoreEventDocument(document) {
  invariant(document && typeof document === 'object' && !Array.isArray(document), 'Firestore document is invalid')
  invariant(typeof document.name === 'string' && document.name.length > 0, 'Firestore document name is required')
  invariant(document.fields && typeof document.fields === 'object' && !Array.isArray(document.fields), 'Firestore document fields are required')
  invariant(Object.prototype.hasOwnProperty.call(document.fields, 'event'), 'Firestore document event field is required')
  const docId = document.name.split('/').at(-1)
  invariant(typeof docId === 'string' && docId.length > 0, 'Firestore document id is required')
  const event = decodeFirestoreValue(document.fields.event)
  invariant(event && typeof event === 'object' && !Array.isArray(event), 'Firestore event payload is invalid')
  return { docId, event }
}

async function readCloudEventDocuments(familyId) {
  const endpoint = `http://127.0.0.1:${FIRESTORE_PORT}/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/families/${encodeURIComponent(familyId)}/events?pageSize=1000`
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(E2E_TIMEOUT_MS) })
  invariant(response.ok, `Firestore emulator document listing failed: ${response.status}`)
  const payload = await response.json()
  const documents = payload.documents ?? []
  invariant(Array.isArray(documents), 'Firestore emulator document listing is invalid')
  return documents.map(decodeFirestoreEventDocument)
}

async function waitForRevision(device, expected) {
  const deadline = Date.now() + E2E_TIMEOUT_MS
  let last = null
  while (Date.now() < deadline) {
    last = (await readSnapshot(device)).events.find(event => event.id === expected.id) ?? null
    if (
      last?.rev >= expected.rev
      && (expected.deleted == null || last.deleted === expected.deleted)
    ) return last
    await delay(200)
  }
  throw new Error(`${device.name}: revision did not converge: ${stableJson(last)} / ${stableJson(expected)}`)
}

async function waitForSemanticEvent(device, expectedEvent) {
  const deadline = Date.now() + E2E_TIMEOUT_MS
  let last = null
  while (Date.now() < deadline) {
    last = (await readSnapshot(device)).events.find(event => event.id === expectedEvent.id) ?? null
    if (semanticEventsEqual(last, expectedEvent)) return last
    await delay(200)
  }
  throw new Error(
    `${device.name}: semantic event did not converge: ${stableJson(semanticEventPayload(last))} / ${stableJson(semanticEventPayload(expectedEvent))}`,
  )
}

async function addQuickEvent(device, type) {
  const before = normalizeConvergence((await readSnapshot(device)).events)
  await openHome(device)
  await device.page.locator(`[data-quick-record="${type}"]`).click()
  await device.page.waitForFunction(
    async ids => {
      const events = await window.babyDiary.listEvents()
      return events.some(event => !ids.includes(event.id))
    },
    before.map(event => event.id),
    { timeout: E2E_TIMEOUT_MS },
  )
  const after = (await readSnapshot(device)).events
  const created = after.find(event => !before.some(previous => previous.id === event.id))
  invariant(created, `${device.name}: ${type} event was not created`)
  return created
}

function toLocalDateTime(iso, minuteDelta) {
  const date = new Date(iso)
  date.setMinutes(date.getMinutes() + minuteDelta)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function editEventTime(device, event) {
  await openHome(device)
  const item = device.page.locator(`[data-event-id="${event.id}"]`)
  await item.locator('[data-event-action="edit"]').click()
  const modal = device.page.locator('[data-time-edit-modal]')
  await modal.waitFor({ state: 'visible', timeout: E2E_TIMEOUT_MS })
  const localDateTime = toLocalDateTime(event.at, -30)
  const expectedAt = new Date(localDateTime).toISOString()
  await modal.locator('[data-time-edit-input]').fill(localDateTime)
  const startedAt = Date.now()
  await modal.locator('[data-time-edit-action="confirm"]').click()
  const observedEdited = await waitForRevision(device, { id: event.id, rev: event.rev + 1, deleted: false })
  const expectedEdited = buildExpectedEditedEvent(event, expectedAt, {
    updatedAt: observedEdited.updatedAt,
    mutationId: observedEdited.mutationId,
  }, { startedAt, finishedAt: Date.now() })
  invariant(
    semanticEventsEqual(observedEdited, expectedEdited),
    `${device.name}: local edited payload mismatch: ${stableJson(semanticEventPayload(observedEdited))}/${stableJson(semanticEventPayload(expectedEdited))}`,
  )
  return expectedEdited
}

async function deleteEvent(device, event) {
  await openHome(device)
  const item = device.page.locator(`[data-event-id="${event.id}"]`)
  await item.locator('[data-event-action="delete"]').click()
  const startedAt = Date.now()
  await item.locator('[data-event-action="confirm-delete"]').click()
  const observedDeleted = await waitForRevision(device, { id: event.id, rev: event.rev + 1, deleted: true })
  const expectedDeleted = buildExpectedDeletedEvent(event, {
    updatedAt: observedDeleted.updatedAt,
    mutationId: observedDeleted.mutationId,
  }, { startedAt, finishedAt: Date.now() })
  invariant(
    semanticEventsEqual(observedDeleted, expectedDeleted),
    `${device.name}: local deleted payload mismatch: ${stableJson(semanticEventPayload(observedDeleted))}/${stableJson(semanticEventPayload(expectedDeleted))}`,
  )
  return expectedDeleted
}

async function runInsideEmulators() {
  assertEmulatorEnvironment(process.env)
  const executablePath = resolvePackagedExecutable({
    override: process.env.BABYDIARY_SYNC_E2E_EXECUTABLE,
  })
  // macOS commonly exposes /var as a symlink to /private/var. Canonicalize the
  // isolated root before handing it to the fail-closed main-process guard.
  const rootTemp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'baby-diary-sync-e2e-')))
  const userDataA = path.join(rootTemp, 'device-a')
  const userDataB = path.join(rootTemp, 'device-b')

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const password = `Sync-E2E-${suffix}!9`
  const emailA = `sync-e2e-a-${suffix}@example.test`
  const emailB = `sync-e2e-b-${suffix}@example.test`
  const rendererErrors = []
  const blockedRequests = []
  const diagnosticFiles = []
  let a
  let b
  let primaryError
  let passSummary

  try {
    invariant(userDataA !== userDataB, 'Device A and B must use different userData directories')
    writeSeed(userDataA, 'Device A')
    writeSeed(userDataB, 'Device B')
    console.log('[sync-e2e] launch isolated packaged apps A and B')
    a = await launchDevice({ executablePath, userData: userDataA, name: 'A', rendererErrors, blockedRequests, diagnosticFiles })
    b = await launchDevice({ executablePath, userData: userDataB, name: 'B', rendererErrors, blockedRequests, diagnosticFiles })
    await Promise.all([dismissFirstLaunch(a), dismissFirstLaunch(b)])

    console.log('[sync-e2e] unique signups; keep-logged-in default checked')
    await signUpDevice(a, emailA, password)
    const inviteCode = await createFamilyOn(a)
    await signUpDevice(b, emailB, password)
    await joinFamilyOn(b, inviteCode)

    const joinedA = await readSnapshot(a)
    const joinedB = await readSnapshot(b)
    const familyA = joinedA.settings.familyId
    const familyB = joinedB.settings.familyId
    invariant(familyA && familyA === familyB, `Family mismatch after join: ${familyA}/${familyB}`)
    const uidA = joinedA.settings.profile?.uid
    const uidB = joinedB.settings.profile?.uid
    invariant(uidA && uidB && uidA !== uidB, `Expected two distinct account ids, got ${uidA}/${uidB}`)

    console.log('[sync-e2e] A -> B and B -> A delivery')
    const firstA = await addQuickEvent(a, 'pee')
    invariant(firstA.author.uid === uidA, `A event author mismatch: ${firstA.author.uid}/${uidA}`)
    await waitForSemanticEvent(b, firstA)
    const firstB = await addQuickEvent(b, 'poop')
    invariant(firstB.author.uid === uidB, `B event author mismatch: ${firstB.author.uid}/${uidB}`)
    await waitForSemanticEvent(a, firstB)

    console.log('[sync-e2e] close B, create on A, relaunch B and restore auth/family/missing event')
    await closeDevice(b)
    const offlineForB = await addQuickEvent(a, 'pee')
    b = await launchDevice({ executablePath, userData: userDataB, name: 'B-relaunch', rendererErrors, blockedRequests, diagnosticFiles })
    await dismissFirstLaunch(b)
    await openSettings(b)
    await b.page.locator('[data-sync-state="online"]').waitFor({ state: 'visible', timeout: E2E_TIMEOUT_MS })
    invariant(await b.page.locator('[data-sync-auth-form]').count() === 0, 'B relaunch did not restore authentication')
    await waitForSemanticEvent(b, offlineForB)
    invariant((await readSnapshot(b)).settings.familyId === familyA, 'B relaunch did not restore family identity')

    console.log('[sync-e2e] revision edit and tombstone convergence')
    const expectedEdited = await editEventTime(b, firstA)
    await waitForSemanticEvent(a, expectedEdited)
    const expectedDeleted = await deleteEvent(a, firstB)
    await waitForSemanticEvent(b, expectedDeleted)

    const [finalA, finalB] = await Promise.all([readSnapshot(a), readSnapshot(b)])
    const normalizedA = normalizeSemanticEvents(finalA.events)
    const normalizedB = normalizeSemanticEvents(finalB.events)
    invariant(stableJson(normalizedA) === stableJson(normalizedB), `Final convergence mismatch: ${stableJson(normalizedA)} / ${stableJson(normalizedB)}`)
    invariant(normalizedA.length === 3, `Expected exactly 3 event ids, got ${normalizedA.length}`)
    const expectedFinal = normalizeSemanticEvents([expectedEdited, expectedDeleted, offlineForB])
    invariant(
      stableJson(normalizedA) === stableJson(expectedFinal),
      `Final payloads differ from source mutations: ${stableJson(normalizedA)} / ${stableJson(expectedFinal)}`,
    )
    invariant(
      normalizedA.some(event => event.id === firstA.id && event.rev === 2 && !event.deleted),
      'Edited event did not converge at rev 2',
    )
    invariant(
      normalizedA.some(event => event.id === firstB.id && event.rev === 2 && event.deleted),
      'Deleted event tombstone did not converge at rev 2',
    )
    invariant(
      normalizedA.some(event => event.id === offlineForB.id && event.rev === 1 && !event.deleted),
      'Offline-created event did not converge at rev 1',
    )
    const editedA = finalA.events.find(event => event.id === firstA.id && event.rev === 2)
    const editedB = finalB.events.find(event => event.id === firstA.id && event.rev === 2)
    invariant(
      semanticEventsEqual(editedA, expectedEdited) && semanticEventsEqual(editedB, expectedEdited),
      `Edited event payload mismatch: ${stableJson(semanticEventPayload(editedA))}/${stableJson(semanticEventPayload(editedB))}`,
    )
    const deletedA = finalA.events.find(event => event.id === firstB.id && event.rev === 2)
    const deletedB = finalB.events.find(event => event.id === firstB.id && event.rev === 2)
    invariant(
      semanticEventsEqual(deletedA, expectedDeleted) && semanticEventsEqual(deletedB, expectedDeleted),
      'Deleted poop tombstone payload did not converge',
    )
    invariant(finalA.dataInfo.eventCount === 2 && finalB.dataInfo.eventCount === 2, `Expected two active events, got ${finalA.dataInfo.eventCount}/${finalB.dataInfo.eventCount}`)
    invariant(finalA.settings.familyId === familyA && finalB.settings.familyId === familyA, 'Final family id was not preserved')
    const expectedBaby = JSON.stringify({ name: 'Sync Baby', birthdate: '2026-01-15' })
    invariant(JSON.stringify(finalA.settings.baby) === expectedBaby, `A baby identity changed: ${JSON.stringify(finalA.settings.baby)}`)
    invariant(JSON.stringify(finalB.settings.baby) === expectedBaby, `B baby identity changed: ${JSON.stringify(finalB.settings.baby)}`)

    console.log('[sync-e2e] deterministic offline same-id/rev payload conflict')
    await Promise.all([closeDevice(a), closeDevice(b)])
    const [conflictA, conflictB] = buildSameRevisionConflicts(offlineForB)
    const expectedConflict = selectMutationWinner([conflictA, conflictB])
    appendOfflineEvent(userDataA, conflictA)
    appendOfflineEvent(userDataB, conflictB)
    a = await launchDevice({ executablePath, userData: userDataA, name: 'A-conflict', rendererErrors, blockedRequests, diagnosticFiles })
    b = await launchDevice({ executablePath, userData: userDataB, name: 'B-conflict', rendererErrors, blockedRequests, diagnosticFiles })
    await Promise.all([dismissFirstLaunch(a), dismissFirstLaunch(b)])
    await Promise.all([openSettings(a), openSettings(b)])
    await Promise.all([
      a.page.locator('[data-sync-state="online"]').waitFor({ state: 'visible', timeout: E2E_TIMEOUT_MS }),
      b.page.locator('[data-sync-state="online"]').waitFor({ state: 'visible', timeout: E2E_TIMEOUT_MS }),
    ])
    invariant(await a.page.locator('[data-sync-auth-form]').count() === 0, 'A conflict relaunch did not restore authentication')
    invariant(await b.page.locator('[data-sync-auth-form]').count() === 0, 'B conflict relaunch did not restore authentication')
    const convergedConflict = await waitForConflictConvergence(
      a,
      b,
      expectedConflict,
    )
    invariant(convergedConflict.deleted === false, 'Same-revision conflict unexpectedly deleted the event')
    const [conflictSnapshotA, conflictSnapshotB, cloudDocuments] = await Promise.all([
      readSnapshot(a),
      readSnapshot(b),
      readCloudEventDocuments(familyA),
    ])
    const expectedConflicts = [conflictA, conflictB]
    for (const [name, snapshot] of [['A', conflictSnapshotA], ['B', conflictSnapshotB]]) {
      const localMutations = snapshot.mutations
        .filter(event => event.id === offlineForB.id && event.rev === conflictA.rev)
      invariant(localMutations.length === expectedConflicts.length, `${name} did not preserve exactly both conflict mutations: ${localMutations.length}`)
      for (const conflict of expectedConflicts) {
        const localMutation = localMutations.find(event => event.mutationId === conflict.mutationId)
        invariant(
          localMutation && semanticEventsEqual(localMutation, conflict),
          `${name} local conflict payload mismatch for mutation ${conflict.mutationId}`,
        )
      }
    }
    const cloudConflictDocuments = cloudDocuments.filter(
      document => document.event.id === offlineForB.id && document.event.rev === conflictA.rev,
    )
    invariant(cloudConflictDocuments.length === expectedConflicts.length, `Cloud did not preserve exactly both conflict mutations: ${cloudConflictDocuments.length}`)
    for (const conflict of expectedConflicts) {
      const cloudDocument = cloudConflictDocuments.find(
        document => document.docId === makeMutationDocId(conflict),
      )
      invariant(
        cloudDocument && semanticEventsEqual(cloudDocument.event, conflict),
        `Cloud conflict payload mismatch for mutation ${conflict.mutationId}`,
      )
    }
    passSummary = {
      familyId: familyA,
      events: normalizeConvergence(normalizedA),
      conflictRev: convergedConflict.rev,
      activeCount: 2,
    }
  } catch (error) {
    primaryError = error
  }
  await finalizeRun({
    devices: [a, b],
    rootTemp,
    diagnosticFiles,
    blockedRequests,
    rendererErrors,
    primaryError,
  })
  console.log(`[sync-e2e] PASS ${JSON.stringify(passSummary)}`)
}

async function runOuter() {
  const executablePath = resolvePackagedExecutable({
    override: process.env.BABYDIARY_SYNC_E2E_EXECUTABLE,
  })
  const env = verifyJava21(process.env)
  const invocation = buildFirebaseCliInvocation({
    platform: process.platform,
    nodePath: process.execPath,
    scriptPath: SCRIPT_PATH,
  })
  verifyFirebaseCli(invocation, env)

  const child = spawn(invocation.command, invocation.args, {
    cwd: ROOT,
    env: {
      ...env,
      BABYDIARY_SYNC_E2E_EXECUTABLE: executablePath,
      BABYDIARY_FIREBASE_EMULATOR: '1',
      BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID: FIREBASE_PROJECT_ID,
    },
    stdio: 'inherit',
  })
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
  invariant(exitCode === 0, `Firebase emulator E2E exited with code ${exitCode}`)
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH
if (isDirectRun) {
  const inside = process.argv.includes('--inside-emulators')
  ;(inside ? runInsideEmulators() : runOuter()).catch(error => {
    console.error('[sync-e2e] FAIL', error)
    process.exitCode = 1
  })
}
