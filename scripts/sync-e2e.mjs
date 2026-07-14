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
import { EventEmitter } from 'node:events'
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
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { v5 as uuidv5 } from 'uuid'

export const FIREBASE_CLI_VERSION = '15.23.0'
export const FIREBASE_PROJECT_ID = 'demo-baby-diary'
export const FIREBASE_AUTH_PORT = 9099
export const FIRESTORE_PORT = 8080

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
const APP_PACKAGE = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const APP_PACKAGE_NAME = APP_PACKAGE.name
const APP_VERSION = APP_PACKAGE.version
const APP_PACKAGE_MAIN = APP_PACKAGE.main
const E2E_TIMEOUT_MS = 30_000
const PACKAGED_LAUNCH_TIMEOUT_MS = 60_000
const CDP_CONNECT_ATTEMPT_TIMEOUT_MS = 2_000
const CLOSE_TIMEOUT_MS = 10_000
const CLOSE_CLEANUP_TIMEOUT_MS = 5_000
const WINDOWS_PROCESS_POLL_MS = 75
const CONTENT_ID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const BABY_INFO_JOURNAL_FILE = 'baby-info-journal-v1.jsonl'
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
    const executableDirectory = path.dirname(executablePath)
    const directoryName = path.basename(executableDirectory).toLowerCase()
    const sourceSegments = path.resolve(executablePath).split(/[\\/]+/).map(segment => segment.toLowerCase())
    if (sourceSegments.includes('node_modules') || sourceSegments.includes('electron')) return null
    if (!new Set(['win-unpacked', 'baby diary', 'baby-diary']).has(directoryName)) return null
    return path.join(executableDirectory, 'resources', 'app.asar')
  }

  if (platform === 'darwin') {
    const macosDirectory = path.dirname(executablePath)
    const contentsDirectory = path.dirname(macosDirectory)
    const appDirectory = path.dirname(contentsDirectory)
    if (
      path.basename(executablePath) !== 'Baby Diary'
      || path.basename(macosDirectory) !== 'MacOS'
      || path.basename(contentsDirectory) !== 'Contents'
      || path.basename(appDirectory) !== 'Baby Diary.app'
    ) {
      return null
    }
    return path.join(contentsDirectory, 'Resources', 'app.asar')
  }

  return null
}

function comparablePath(value, platform) {
  const pathApi = platform === 'win32'
    ? path.win32
    : platform === 'darwin'
      ? path.posix
      : path
  let normalized = pathApi.normalize(pathApi.resolve(value))
  if (platform === 'darwin') {
    if (normalized === '/var' || normalized.startsWith('/var/')) {
      normalized = `/private${normalized}`
    } else if (normalized === '/tmp' || normalized.startsWith('/tmp/')) {
      normalized = `/private${normalized}`
    }
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function assertPackagedRuntimeAttestation(attestation, {
  executablePath,
  resourcePath,
  platform,
  expectedVersion,
}) {
  const validIdentity = attestation
    && attestation.name === APP_PACKAGE_NAME
    && attestation.isPackaged === true
    && attestation.version === expectedVersion
  const validPaths = validIdentity
    && comparablePath(attestation.executablePath, platform) === comparablePath(executablePath, platform)
    && comparablePath(attestation.appPath, platform) === comparablePath(resourcePath, platform)
  invariant(
    validIdentity && validPaths,
    `Expected packaged Baby Diary runtime ${expectedVersion} at ${executablePath}`,
  )
  return attestation
}

export async function readPackagedArtifactAttestation({
  executablePath,
  resourcePath,
  extractFile,
  platform = process.platform,
  fileSystem = DEFAULT_FILE_SYSTEM,
}) {
  const realExecutablePath = assertRealRegularFile(
    executablePath,
    'Packaged executable',
    platform,
    fileSystem,
  )
  const realResourcePath = assertRealRegularFile(
    resourcePath,
    'Packaged app.asar',
    platform,
    fileSystem,
  )
  let extract = extractFile
  if (!extract) {
    const asar = await import('@electron/asar')
    extract = asar.extractFile ?? asar.default?.extractFile
  }
  invariant(typeof extract === 'function', 'Packaged app.asar reader is unavailable')
  let metadata
  try {
    const raw = await extract(realResourcePath, 'package.json')
    metadata = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw))
  } catch (error) {
    throw new Error(`Packaged app.asar metadata could not be read: ${error?.message ?? String(error)}`)
  }
  invariant(
    metadata
      && typeof metadata.name === 'string'
      && typeof metadata.version === 'string'
      && metadata.main === APP_PACKAGE_MAIN,
    'Packaged app.asar metadata is invalid',
  )
  return {
    name: metadata.name,
    version: metadata.version,
    isPackaged: true,
    appPath: realResourcePath,
    executablePath: realExecutablePath,
  }
}

export function resolveCanonicalUpgradeProfile({
  override,
  platform = process.platform,
  env = process.env,
  fileSystem = DEFAULT_FILE_SYSTEM,
} = {}) {
  invariant(typeof override === 'string' && override.length > 0,
    'Canonical upgraded profile path is required')
  let expected
  if (platform === 'win32') {
    invariant(typeof env.APPDATA === 'string' && env.APPDATA.length > 0, 'APPDATA is required')
    expected = path.resolve(env.APPDATA, 'baby-diary')
  } else if (platform === 'darwin') {
    invariant(typeof env.HOME === 'string' && env.HOME.length > 0, 'HOME is required')
    expected = path.resolve(env.HOME, 'Library', 'Application Support', 'baby-diary')
  } else {
    throw new Error('Canonical upgraded profile continuation supports Windows and macOS only')
  }
  const candidate = path.resolve(override)
  invariant(
    comparablePath(candidate, platform) === comparablePath(expected, platform),
    `Sync continuation must use the canonical upgraded profile: ${expected}`,
  )
  invariant(fileSystem.existsSync(candidate), `Canonical upgraded profile not found: ${candidate}`)
  const profile = fileSystem.lstatSync(candidate)
  invariant(profile.isDirectory() && !profile.isSymbolicLink(),
    'Canonical upgraded profile must be a real directory')
  const real = fileSystem.realpathSync(candidate)
  invariant(comparablePath(real, platform) === comparablePath(candidate, platform),
    'Canonical upgraded profile resolves through a link/reparse point')
  const settingsPath = path.join(candidate, 'settings.json')
  const dataPath = path.join(candidate, 'data')
  invariant(fileSystem.existsSync(settingsPath) && fileSystem.existsSync(dataPath),
    'Canonical upgraded profile is missing settings or data')
  const settings = fileSystem.lstatSync(settingsPath)
  const data = fileSystem.lstatSync(dataPath)
  invariant(settings.isFile() && !settings.isSymbolicLink()
    && data.isDirectory() && !data.isSymbolicLink(),
  'Canonical upgraded profile settings/data must not use links or reparse points')
  return real
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
    babyInfoJournal: { version: 1, projectedFamilyId: '' },
    babyInfoRevision: 1,
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
  invariant(original && Number.isSafeInteger(original.rev) && original.rev >= 1, 'Original event revision is required')
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

export function nextExpectedHybridLogicalClock(priorRev, updatedAt) {
  invariant(
    Number.isSafeInteger(priorRev) && priorRev >= 0 && priorRev < Number.MAX_SAFE_INTEGER,
    'Prior event revision logical clock is invalid or exhausted',
  )
  const updatedAtMs = Date.parse(updatedAt)
  invariant(
    Number.isSafeInteger(updatedAtMs) && updatedAtMs >= 0,
    'Expected mutation updatedAt logical clock is invalid',
  )
  return Math.max(priorRev + 1, updatedAtMs)
}

function expectedEventSyncMetadata(event) {
  return {
    version: 1,
    encodedEventId: encodeURIComponent(event.id),
    eventAtMs: Date.parse(event.at),
    createdAtMs: Date.parse(event.createdAt),
    updatedAtMs: Date.parse(event.updatedAt),
  }
}

export function matchesExpectedLocalOperationMutation(event, {
  prior,
  expectedAt,
  expectedDeleted,
  startedAt,
  finishedAt,
}) {
  const updatedAtMs = Date.parse(event?.updatedAt)
  return event?.id === prior?.id
    && event.at === expectedAt
    && event.deleted === expectedDeleted
    && Number.isSafeInteger(event.rev)
    && event.rev > prior.rev
    && Number.isSafeInteger(updatedAtMs)
    && updatedAtMs >= startedAt
    && updatedAtMs <= finishedAt
    && typeof event.mutationId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.mutationId)
    && event.mutationId !== prior.mutationId
    && event.migration === undefined
}

export function buildExpectedCanonicalMutation(source, writerUid) {
  invariant(typeof writerUid === 'string' && writerUid.length > 0, 'Writer uid is required')
  invariant(source.migration === undefined, 'Auth-bound derivative cannot be rebound')
  const sourceContentId = uuidv5(
    `baby-diary:event-content:${stableJson(source)}`,
    CONTENT_ID_NAMESPACE,
  )
  return {
    ...source,
    rev: nextExpectedHybridLogicalClock(source.rev, source.updatedAt),
    mutationId: source.mutationId,
    author: { ...source.author, uid: writerUid },
    sync: expectedEventSyncMetadata(source),
    migration: {
      version: 1,
      kind: 'legacy-author-v1',
      sourceContentId,
    },
  }
}

export function buildExpectedEditedEvent(original, expectedAt, dynamic, bounds) {
  invariant(original && original.deleted === false, 'Only an active original event can be edited')
  invariant(Number.isFinite(Date.parse(expectedAt)), 'Expected edited event time must be valid')
  validateExpectedMutationDynamic(original, dynamic, bounds)
  const { migration: _priorMigration, ...freshSource } = original
  const expected = {
    ...freshSource,
    at: expectedAt,
    updatedAt: dynamic.updatedAt,
    rev: nextExpectedHybridLogicalClock(original.rev, dynamic.updatedAt),
    mutationId: dynamic.mutationId,
  }
  return { ...expected, sync: expectedEventSyncMetadata(expected) }
}

export function buildExpectedDeletedEvent(original, dynamic, bounds) {
  invariant(original && original.deleted === false, 'Only an active original event can be deleted')
  validateExpectedMutationDynamic(original, dynamic, bounds)
  const { migration: _priorMigration, ...freshSource } = original
  const expected = {
    ...freshSource,
    deleted: true,
    updatedAt: dynamic.updatedAt,
    rev: nextExpectedHybridLogicalClock(original.rev, dynamic.updatedAt),
    mutationId: dynamic.mutationId,
  }
  return { ...expected, sync: expectedEventSyncMetadata(expected) }
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

function mutationContentId(event) {
  return uuidv5(`baby-diary:event-content:${stableJson(event)}`, CONTENT_ID_NAMESPACE)
}

function mutationStorageKey(event) {
  return `${mutationIdentity(event)}:${mutationContentId(event)}`
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
  invariant(/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.mutationId), 'Mutation id must be UUID v4 or v5')
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

  const updatedAt = new Date(nowMs).toISOString()
  const rev = nextExpectedHybridLogicalClock(baseEvent.rev, updatedAt)
  const { migration: _priorMigration, sync: _priorSync, ...freshSource } = baseEvent
  const conflicts = [
    {
      ...freshSource,
      mutationId: '11111111-1111-4111-8111-111111111111',
      at: shiftedAt(-2),
      updatedAt,
      rev,
      deleted: false,
    },
    {
      ...freshSource,
      mutationId: '22222222-2222-4222-8222-222222222222',
      at: shiftedAt(2),
      updatedAt,
      rev,
      deleted: false,
    },
  ]
  return conflicts.map(conflict => ({
    ...conflict,
    sync: expectedEventSyncMetadata(conflict),
  }))
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

export function writeSeed(userData, deviceName) {
  mkdirSync(userData, { recursive: true })
  writeFileSync(
    path.join(userData, 'settings.json'),
    `${JSON.stringify(buildSeedSettings(deviceName), null, 2)}\n`,
    'utf8',
  )
  writeFileSync(path.join(userData, BABY_INFO_JOURNAL_FILE), '', 'utf8')
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

export function isExpectedFirestoreWriteChannelCancellation(rawUrl, errorText, method) {
  if (method !== 'GET' || errorText !== 'net::ERR_ABORTED') return false
  let url
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
    || url.port !== String(FIRESTORE_PORT)
    || url.pathname !== '/google.firestore.v1.Firestore/Write/channel'
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
  const canonicalNonNegativeInteger = value => /^(?:0|[1-9]\d*)$/.test(value)
    && Number.isSafeInteger(Number(value))
  const canonicalPositiveInteger = value => /^[1-9]\d*$/.test(value)
    && Number.isSafeInteger(Number(value))

  return url.searchParams.get('VER') === '8'
    && url.searchParams.get('database') === `projects/${FIREBASE_PROJECT_ID}/databases/(default)`
    && url.searchParams.get('RID') === 'rpc'
    && sid.length <= 256
    && /^[A-Za-z0-9_-]{1,254}={0,2}$/.test(sid)
    && canonicalNonNegativeInteger(aid)
    && /^(?:0|1)$/.test(url.searchParams.get('CI') ?? '')
    && url.searchParams.get('TYPE') === 'xmlhttp'
    && /^[a-z0-9]{1,64}$/.test(zx)
    && canonicalPositiveInteger(attempt)
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
      const method = typeof request.method === 'function' ? request.method() : ''
      const expectedCloseAbort = isClosing()
        && isAllowedNetworkUrl(url, { resourcePath })
        && /ERR_ABORTED|ERR_CANCELED|ERR_CONNECTION_CLOSED/i.test(errorText)
      const expectedWriteChannelCancellation = isExpectedFirestoreWriteChannelCancellation(url, errorText, method)
      if (!expectedCloseAbort && !expectedWriteChannelCancellation) {
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
  const safeConsoleSummary = message => {
    if (typeof message !== 'string') return 'unavailable'
    let summary = message
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
      .replace(/\b(?:https?|wss?|ftp|file):\/\/[^\s<>"'`]+/gi, '[url]')
      .replace(/\b[A-Za-z]:\\(?:[^\\\s"'<>|]+\\)*[^\\\s"'<>|]*/g, '[path]')
      .replace(
        /(^|[\s("'`])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]*/g,
        (_match, prefix) => `${prefix}[path]`,
      )
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
      .replace(
        /(["']?)([A-Za-z0-9_-]*(?:api[_-]?key|password|token|secret|authorization|credential)[A-Za-z0-9_-]*)\1\s*[:=]\s*(?:\[redacted\]|"[^"\r\n]*"|'[^'\r\n]*'|Bearer\s+[^\s,;)}\]&]+|[^\s,;)}\]&]+)/gi,
        (_match, _quote, key) => `${key}=[redacted]`,
      )
      .replace(/\bBearer\s+[^\s,;)}\]&]+/gi, 'Bearer [redacted]')
      .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[jwt]')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[uuid]')
      .replace(
        /(^|[^A-Za-z0-9+/_=-])([A-Za-z0-9+/_-]{24,}={0,2})(?=$|[^A-Za-z0-9+/_=-])/g,
        (_match, prefix) => `${prefix}[redacted]`,
      )
      .replace(/\s+/g, ' ')
      .trim()
    if (!summary) return 'unavailable'
    if (summary.length > 240) summary = `${summary.slice(0, 239).trimEnd()}…`
    return summary || 'unavailable'
  }
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
      if (record.kind === 'console-error') {
        if (record.phase === 'closing') continue
        const protocol = typeof record.protocol === 'string' ? record.protocol : 'unknown'
        const destination = typeof record.destination === 'string' ? record.destination : 'unknown'
        const port = typeof record.port === 'number' ? ` port=${record.port}` : ''
        const line = typeof record.line === 'number' ? ` line=${record.line}` : ''
        const summary = safeConsoleSummary(record.summary)
        rendererErrors.push(`${diagnosticFile.name}: early console-error ${protocol} ${destination}${port}${line} summary=${summary}`)
        continue
      }
      if (['load-failed', 'preload-error', 'renderer-unresponsive'].includes(record.kind)) {
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

async function reserveLoopbackPort({ createServerImpl = createServer } = {}) {
  const server = createServerImpl()
  server.unref?.()
  return new Promise((resolve, reject) => {
    const fail = error => {
      server.close?.(() => undefined)
      reject(error)
    }
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      server.off?.('error', fail)
      const address = server.address()
      if (!address || typeof address === 'string' || !Number.isInteger(address.port)) {
        server.close(() => reject(new Error('Could not reserve a loopback CDP port')))
        return
      }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

/**
 * Launch a packaged Electron executable like a user does, then attach only to
 * Chromium's remote-debugging endpoint. Playwright's `_electron.launch` also
 * enables Electron's Node inspector (`--inspect=0`); Electron 43 can race that
 * inspector startup across rapid relaunches and crash a sandboxed renderer on
 * both Windows and macOS.
 */
export async function launchCdpElectronApplication({
  executablePath,
  cwd,
  env,
  timeoutMs = PACKAGED_LAUNCH_TIMEOUT_MS,
  platform = process.platform,
  allocatePort = reserveLoopbackPort,
  spawnImpl = spawn,
  connectOverCDP,
  sleep = delay,
  cleanupProcess = killOwnedProcessTree,
  extraArgs = [],
}) {
  invariant(typeof connectOverCDP === 'function', 'CDP connector is required')
  invariant(platform === 'win32' || platform === 'darwin', `Unsupported CDP launch platform: ${platform}`)
  invariant(
    Array.isArray(extraArgs) && extraArgs.every(argument => typeof argument === 'string'),
    'Packaged Electron extra arguments must be strings',
  )
  for (const argument of extraArgs) {
    invariant(
      !/^--(?:inspect(?:[-=]|$)|remote-debugging-(?:address|port)(?:=|$)|user-data-dir(?:=|$))/i.test(argument),
      `Reserved packaged Electron argument cannot be overridden: ${argument}`,
    )
  }
  const port = await allocatePort()
  invariant(Number.isInteger(port) && port > 0 && port <= 65_535, `Invalid CDP port: ${port}`)

  const childEnv = { ...env }
  // Never pass a parent Node loader into the packaged Electron main process.
  // Windows environment keys are case-insensitive, so strip every casing.
  for (const key of Object.keys(childEnv)) {
    if (key.toUpperCase() === 'NODE_OPTIONS' || key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') {
      delete childEnv[key]
    }
  }
  const child = spawnImpl(executablePath, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    ...extraArgs,
  ], {
    cwd,
    env: childEnv,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  invariant(child && typeof child === 'object', 'Packaged Electron launch did not return a child process')

  let spawnError
  let stderr = ''
  const captureSpawnError = error => { spawnError = error }
  child.on?.('error', captureSpawnError)
  child.stderr?.on?.('data', chunk => {
    if (stderr.length < 8_192) stderr += String(chunk).slice(0, 8_192 - stderr.length)
  })

  const endpoint = `http://127.0.0.1:${port}`
  const deadline = Date.now() + timeoutMs
  let browser
  let lastConnectError
  try {
    while (!browser) {
      if (spawnError) throw new Error(`Packaged Electron process could not start: ${spawnError.message ?? String(spawnError)}`)
      if (childProcessExited(child)) {
        const details = stderr.trim()
        throw new Error(`Packaged Electron process exited before CDP was ready${details ? `: ${details}` : ''}`)
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(`Packaged Electron CDP endpoint was not ready: ${lastConnectError?.message ?? 'timeout'}`)
      }
      try {
        const connectTimeoutMs = Math.min(CDP_CONNECT_ATTEMPT_TIMEOUT_MS, remaining)
        browser = await withTimeout(
          Promise.resolve().then(() => connectOverCDP(endpoint, { timeout: connectTimeoutMs })),
          remaining,
          'Packaged Electron CDP connection',
        )
      } catch (error) {
        lastConnectError = error
        const afterAttempt = deadline - Date.now()
        if (afterAttempt <= 0) continue
        await sleep(Math.min(50, afterAttempt))
      }
    }

    const contexts = browser.contexts()
    invariant(Array.isArray(contexts) && contexts.length === 1,
      `Expected exactly one packaged Electron CDP context, got ${contexts?.length ?? 0}`)
    const context = contexts[0]
    const app = new EventEmitter()
    const forwardWindow = page => app.emit('window', page)
    context.on('page', forwardWindow)
    let closePromise
    app.process = () => child
    app.context = () => context
    app.firstWindow = async options => {
      const existing = context.pages()[0]
      return existing ?? context.waitForEvent('page', options)
    }
    app.close = async () => {
      if (closePromise) return closePromise
      closePromise = (async () => {
        const pages = context.pages()
        invariant(pages.length > 0 || childProcessExited(child),
          'Packaged Electron CDP context had no window to close gracefully')
        // Close auxiliary windows first and the main window last. On Windows,
        // window-all-closed triggers the app's durable backup + quit path.
        for (const page of [...pages].reverse()) {
          await page.close({ runBeforeUnload: true })
        }
        // Closing the last window exits the Windows app. macOS intentionally
        // keeps an app alive with no windows, so the validated isolated E2E
        // guard converts SIGTERM into app.quit() and the durable backup hook.
        if (platform === 'darwin' && !childProcessExited(child)) {
          invariant(typeof child.kill === 'function', 'Packaged macOS Electron process cannot be signaled')
          const signaled = child.kill('SIGTERM')
          invariant(signaled || childProcessExited(child), 'Packaged macOS Electron process rejected graceful quit')
        }
        context.off?.('page', forwardWindow)
      })()
      return closePromise
    }
    return app
  } catch (primaryError) {
    const cleanupErrors = []
    try {
      await browser?.close?.()
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (!childProcessExited(child)) {
      try {
        const pid = child.pid
        invariant(Number.isInteger(pid) && pid > 1 && pid !== process.pid,
          'Failed CDP launch did not expose a safe owned pid')
        await cleanupProcess(pid)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    throw aggregateErrors(primaryError, cleanupErrors, 'Packaged Electron CDP launch cleanup failed')
  }
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

function normalizeWindowsProcessRows(rows) {
  invariant(Array.isArray(rows), 'Windows process snapshot must be an array')
  const seen = new Set()
  return rows.map(row => {
    invariant(row && typeof row === 'object', 'Windows process snapshot row is invalid')
    const pid = Number(row.pid)
    const parentPid = Number(row.parentPid)
    const startedAt = String(row.startedAt ?? '')
    const executablePath = String(row.executablePath ?? '')
    invariant(Number.isInteger(pid) && pid >= 0, 'Windows process snapshot pid is invalid')
    invariant(Number.isInteger(parentPid) && parentPid >= 0, 'Windows process snapshot parent pid is invalid')
    invariant(startedAt === '' || /^\d+$/.test(startedAt),
      `Windows process snapshot start identity is invalid for pid ${pid}`)
    invariant(!seen.has(pid), `Windows process snapshot contains duplicate pid ${pid}`)
    seen.add(pid)
    return { pid, parentPid, startedAt, executablePath }
  })
}

export function queryWindowsProcessTable({ spawnSyncImpl = spawnSync } = {}) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$rows = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {',
    '  $startedAt = if ($null -eq $_.CreationDate) { "" } else { $_.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) }',
    '  [PSCustomObject]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; startedAt = $startedAt; executablePath = [string]$_.ExecutablePath }',
    '})',
    'ConvertTo-Json -InputObject $rows -Compress',
  ].join('; ')
  const result = spawnSyncImpl('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  invariant(!result.error, `Windows process snapshot query failed: ${result.error?.message ?? 'spawn failed'}`)
  invariant(result.status === 0, `Windows process snapshot query failed: ${String(result.stderr ?? '').trim()}`)
  let parsed
  try {
    parsed = JSON.parse(String(result.stdout ?? ''))
  } catch (error) {
    throw new Error(`Windows process snapshot query returned invalid JSON: ${error?.message ?? String(error)}`)
  }
  return normalizeWindowsProcessRows(parsed)
}

function captureWindowsOwnedProcessSnapshot(rootPid, rows) {
  const normalized = normalizeWindowsProcessRows(rows)
  const byPid = new Map(normalized.map(row => [row.pid, row]))
  invariant(byPid.has(rootPid), `Windows process snapshot did not contain owned root pid ${rootPid}`)
  return ownedProcessTreePids(rootPid, normalized).map(pid => {
    const identity = byPid.get(pid)
    invariant(/^\d+$/.test(identity.startedAt),
      `Windows owned process start identity is missing for pid ${pid}`)
    return { ...identity }
  })
}

function sameWindowsProcessIdentity(expected, actual) {
  return expected.pid === actual.pid
    && expected.startedAt === actual.startedAt
    && (!expected.executablePath
      || !actual.executablePath
      || expected.executablePath.toLowerCase() === actual.executablePath.toLowerCase())
}

function lingeringWindowsOwnedProcesses(snapshot, rows) {
  const currentByPid = new Map(normalizeWindowsProcessRows(rows).map(row => [row.pid, row]))
  return snapshot.filter(expected => {
    const actual = currentByPid.get(expected.pid)
    invariant(!actual || /^\d+$/.test(actual.startedAt),
      `Windows owned process start identity became unavailable for pid ${expected.pid}`)
    return actual && sameWindowsProcessIdentity(expected, actual)
  })
}

async function waitForWindowsOwnedProcessExit(snapshot, {
  queryProcessTable,
  timeoutMs,
  pollIntervalMs,
  sleep,
  label,
}) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    let rows
    try {
      rows = queryProcessTable()
    } catch (error) {
      throw new Error(`Windows owned process snapshot query failed during ${label}: ${error?.message ?? String(error)}`)
    }
    const lingering = lingeringWindowsOwnedProcesses(snapshot, rows)
    if (lingering.length === 0) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`${label} timed out with owned Windows process identities still live: ${lingering.map(row => row.pid).join(', ')}`)
    }
    await withTimeout(
      Promise.resolve().then(() => sleep(Math.min(pollIntervalMs, remaining))),
      remaining,
      `${label} process poll`,
    )
  }
}

async function killAndConfirmWindowsOwnedSnapshot(snapshot, {
  queryProcessTable,
  killTree,
  timeoutMs,
  pollIntervalMs,
  sleep,
  label,
}) {
  for (const expected of snapshot) {
    const lingering = lingeringWindowsOwnedProcesses(snapshot, queryProcessTable())
    if (!lingering.some(current => sameWindowsProcessIdentity(expected, current))) continue
    try {
      await killTree(expected.pid)
    } catch (error) {
      const afterFailure = lingeringWindowsOwnedProcesses(snapshot, queryProcessTable())
      if (afterFailure.some(current => sameWindowsProcessIdentity(expected, current))) throw error
    }
  }
  await waitForWindowsOwnedProcessExit(snapshot, {
    queryProcessTable,
    timeoutMs,
    pollIntervalMs,
    sleep,
    label: `${label} forced cleanup`,
  })
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

function childProcessExited(childProcess) {
  return childProcess?.exitCode != null || childProcess?.signalCode != null
}

async function waitForChildProcessExit(childProcess, timeoutMs, label) {
  if (!childProcess || childProcessExited(childProcess)) return
  invariant(typeof childProcess.once === 'function', `${label} did not expose an observable child process`)
  let onExit
  const exited = new Promise(resolve => {
    onExit = () => resolve()
    childProcess.once('exit', onExit)
    // Close the status/listener race if the process exited between the first
    // status read and listener registration.
    if (childProcessExited(childProcess)) resolve()
  })
  try {
    await withTimeout(exited, timeoutMs, `${label} child exit`)
  } finally {
    childProcess.off?.('exit', onExit)
  }
}

function remainingCloseBudget(deadline, label) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error(`${label} timed out before teardown completed`)
  return remaining
}

export async function closeDevice(
  device,
  {
    timeoutMs = CLOSE_TIMEOUT_MS,
    cleanupTimeoutMs = CLOSE_CLEANUP_TIMEOUT_MS,
    killTree = killOwnedProcessTree,
    platform = process.platform,
    queryWindowsProcessTable: queryProcessTable = queryWindowsProcessTable,
    processPollSleep = delay,
    processPollIntervalMs = WINDOWS_PROCESS_POLL_MS,
  } = {},
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
  const label = `${device.name ?? 'device'} close`
  const deadline = Date.now() + timeoutMs
  let windowsSnapshot
  try {
    if (platform === 'win32') {
      invariant(Number.isInteger(pid) && pid > 1 && pid !== process.pid,
        `${device.name ?? 'device'} did not expose a safe owned pid`)
      windowsSnapshot = captureWindowsOwnedProcessSnapshot(pid, queryProcessTable())
    }
    await withTimeout(
      Promise.resolve().then(() => app.close()),
      remainingCloseBudget(deadline, label),
      label,
    )
    await waitForChildProcessExit(
      childProcess,
      remainingCloseBudget(deadline, label),
      label,
    )
    if (windowsSnapshot) {
      await waitForWindowsOwnedProcessExit(windowsSnapshot, {
        queryProcessTable,
        timeoutMs: remainingCloseBudget(deadline, label),
        pollIntervalMs: processPollIntervalMs,
        sleep: processPollSleep,
        label,
      })
    }
  } catch (error) {
    closeErrors.push(error)
    const childStillRunning = childProcess?.exitCode == null && childProcess?.signalCode == null
    if (windowsSnapshot) {
      try {
        await killAndConfirmWindowsOwnedSnapshot(windowsSnapshot, {
          queryProcessTable,
          killTree,
          timeoutMs: cleanupTimeoutMs,
          pollIntervalMs: processPollIntervalMs,
          sleep: processPollSleep,
          label,
        })
      } catch (killError) {
        closeErrors.push(killError)
      }
    } else if (childStillRunning && Number.isInteger(pid) && pid > 1 && pid !== process.pid) {
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
  canonicalUpgradeProfile,
  name,
  rendererErrors,
  blockedRequests,
  diagnosticFiles,
}) {
  const playwright = await import('playwright')
  const resourcePath = packagedResourcePath(executablePath, process.platform)
  invariant(resourcePath, `${name}: packaged resource path could not be derived`)
  const guardToken = randomBytes(32).toString('hex')
  const selectedUserData = canonicalUpgradeProfile ?? userData
  if (canonicalUpgradeProfile) {
    invariant(
      comparablePath(canonicalUpgradeProfile, process.platform) === comparablePath(userData, process.platform),
      `${name}: canonical upgraded profile must be the exact launch userData`,
    )
  }
  const diagnosticPath = path.join(selectedUserData, `sync-e2e-diagnostics-${guardToken}.jsonl`)
  diagnosticFiles.push({ name, path: diagnosticPath })
  const device = { app: null, page: null, userData: selectedUserData, name, closing: false }
  try {
    const launchEnvironment = {
      ...process.env,
      NODE_ENV: 'production',
      BABYDIARY_TEST_USERDATA: canonicalUpgradeProfile ?? userData,
      BABYDIARY_SYNC_E2E_EARLY_GUARD: '1',
      BABYDIARY_SYNC_E2E_GUARD_TOKEN: guardToken,
      BABYDIARY_SYNC_E2E_DIAGNOSTICS: diagnosticPath,
      BABYDIARY_FIREBASE_EMULATOR: '1',
      BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID: FIREBASE_PROJECT_ID,
      FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${FIREBASE_AUTH_PORT}`,
      FIRESTORE_EMULATOR_HOST: `127.0.0.1:${FIRESTORE_PORT}`,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    }
    const app = await launchCdpElectronApplication({
      executablePath,
      cwd: ROOT,
      env: launchEnvironment,
      timeoutMs: PACKAGED_LAUNCH_TIMEOUT_MS,
      platform: process.platform,
      connectOverCDP: (endpoint, options) => playwright.chromium.connectOverCDP(endpoint, options),
    })
    device.app = app
    const attestation = await readPackagedArtifactAttestation({ executablePath, resourcePath })
    assertPackagedRuntimeAttestation(attestation, {
      executablePath,
      resourcePath,
      platform: process.platform,
      expectedVersion: APP_VERSION,
    })
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

export function classifyFirstLaunchState({ persistedLanguage, langChosen, tutorialState }) {
  let tutorialComplete = false
  try {
    const parsed = JSON.parse(tutorialState ?? 'null')
    tutorialComplete = parsed?.version === 2
      && (parsed.status === 'completed' || parsed.status === 'skipped')
      && typeof parsed.updatedAt === 'string'
  } catch {
    tutorialComplete = false
  }
  if (tutorialComplete) return 'complete'
  return persistedLanguage === 'ko' || persistedLanguage === 'ja' || langChosen
    ? 'tour'
    : 'picker'
}

async function readFirstLaunchState(page) {
  return page.evaluate(async () => {
    const settings = await window.babyDiary.getSettings()
    return {
      persistedLanguage: settings?.language ?? null,
      langChosen: localStorage.getItem('babydiary.langChosen') === '1',
      tutorialState: localStorage.getItem('babydiary.tutorial.v2'),
    }
  })
}

async function dismissFirstLaunch(device) {
  const { page, name } = device
  const requiredSurface = classifyFirstLaunchState(await readFirstLaunchState(page))
  if (requiredSurface === 'complete') return

  // App.tsx makes its first-launch decision asynchronously. Wait for the
  // exact state-derived surface instead of assuming a fixed renderer speed.
  const firstLaunchSurface = requiredSurface === 'picker'
    ? page.locator('.lang-picker-overlay')
    : page.locator('.tour-card')
  await firstLaunchSurface.waitFor({
    state: 'visible',
    timeout: E2E_TIMEOUT_MS,
  })
  if (requiredSurface === 'picker') {
    await page.locator('.lang-picker-btn[lang="ko"]').click()
    await page.locator('.tour-card').waitFor({ state: 'visible', timeout: E2E_TIMEOUT_MS })
  }

  const tour = page.locator('.tour-card')
  if (await tour.isVisible().catch(() => false)) {
    await page.locator('.tour-skip-button').first().click()
    await tour.waitFor({ state: 'detached', timeout: E2E_TIMEOUT_MS })
  }
  invariant(
    classifyFirstLaunchState(await readFirstLaunchState(page)) === 'complete',
    `${name}: first-launch tutorial completion was not persisted`,
  )
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

export function assertCanonicalUpgradeProfileSnapshot(snapshot, canonicalUpgradeProfile) {
  invariant(snapshot && typeof snapshot === 'object', 'Canonical upgraded profile snapshot is missing')
  invariant(snapshot.settings?.baby?.name === '하루・ハル'
    && snapshot.settings?.baby?.birthdate === '2026-01-15',
  'Canonical upgraded profile baby identity was replaced')
  invariant(snapshot.settings?.upgradeOpaque?.deep?.nested?.ko === '보존'
    && snapshot.settings?.upgradeOpaque?.deep?.nested?.ja === '保持',
  'Canonical upgraded profile unknown/deep settings were lost')
  invariant(Array.isArray(snapshot.events), 'Canonical upgraded profile events are missing')
  const winners = new Map(snapshot.events.map(event => [event.id, event]))
  for (const expected of [
    { id: 'legacy-pee', rev: 1, deleted: false },
    { id: 'legacy-formula', rev: 2, deleted: false },
    { id: 'legacy-diary-tombstone', rev: 2, deleted: true },
  ]) {
    const actual = winners.get(expected.id)
    invariant(actual?.rev === expected.rev && actual?.deleted === expected.deleted,
      `Canonical upgraded profile legacy winner changed: ${expected.id}`)
  }
  invariant(typeof snapshot.dataInfo?.dataDir === 'string'
    && comparablePath(path.dirname(snapshot.dataInfo.dataDir), process.platform)
      === comparablePath(canonicalUpgradeProfile, process.platform),
  'Canonical upgraded profile IPC resolved a fresh or different userData directory')
  return snapshot
}

async function runCanonicalUpgradeProfileContinuation({
  executablePath,
  canonicalUpgradeProfile,
  email,
  password,
  rendererErrors,
  blockedRequests,
  diagnosticFiles,
}) {
  let device
  try {
    device = await launchDevice({
      executablePath,
      userData: canonicalUpgradeProfile,
      canonicalUpgradeProfile,
      name: 'upgrade-canonical',
      rendererErrors,
      blockedRequests,
      diagnosticFiles,
    })
    await dismissFirstLaunch(device)
    const before = assertCanonicalUpgradeProfileSnapshot(
      await readSnapshot(device),
      canonicalUpgradeProfile,
    )
    await openSettings(device)
    await device.page.locator('[data-sync-state="signed-out"]').waitFor({
      state: 'visible',
      timeout: E2E_TIMEOUT_MS,
    })
    await device.page.evaluate(async () => {
      const settings = await window.babyDiary.getSettings()
      await window.babyDiary.saveSettings({ ...settings, familyId: '' })
    })
    await signUpDevice(device, email, password)
    await createFamilyOn(device)
    const continued = await addQuickEvent(device, 'pee')
    const after = assertCanonicalUpgradeProfileSnapshot(
      await readSnapshot(device),
      canonicalUpgradeProfile,
    )
    invariant(after.events.some(event => semanticEventsEqual(event, continued)),
      'Canonical upgraded profile emulator continuation did not persist its new event')
    invariant(after.events.length > before.events.length,
      'Canonical upgraded profile emulator continuation replaced legacy events')
  } finally {
    if (device) await closeDevice(device)
  }
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
      lastA?.rev === expectedEvent.rev
      && lastB?.rev === expectedEvent.rev
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

export async function signInExistingAuthEmulatorAccount(email, password, fetchImpl = fetch) {
  invariant(typeof email === 'string' && email.length > 0, 'Auth emulator account email is required')
  invariant(typeof password === 'string' && password.length > 0, 'Auth emulator account password is required')
  const endpoint = `http://127.0.0.1:${FIREBASE_AUTH_PORT}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
    signal: AbortSignal.timeout(E2E_TIMEOUT_MS),
  })
  invariant(response.ok, `Auth emulator account sign-in failed: ${response.status}`)
  const payload = await response.json()
  invariant(typeof payload?.idToken === 'string' && payload.idToken.length > 0,
    'Auth emulator sign-in did not return an ID token')
  invariant(typeof payload?.localId === 'string' && payload.localId.length > 0,
    'Auth emulator sign-in did not return an account id')
  return { idToken: payload.idToken, localId: payload.localId }
}

export async function readCloudEventDocuments(familyId, idToken, fetchImpl = fetch) {
  invariant(typeof idToken === 'string' && idToken.length > 0, 'Firestore emulator ID token is required')
  const endpoint = `http://127.0.0.1:${FIRESTORE_PORT}/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/families/${encodeURIComponent(familyId)}/events?pageSize=1000`
  const response = await fetchImpl(endpoint, {
    headers: { Authorization: `Bearer ${idToken}` },
    signal: AbortSignal.timeout(E2E_TIMEOUT_MS),
  })
  invariant(response.ok, `Firestore emulator document listing failed: ${response.status}`)
  const payload = await response.json()
  const documents = payload.documents ?? []
  invariant(Array.isArray(documents), 'Firestore emulator document listing is invalid')
  return documents.map(decodeFirestoreEventDocument)
}

async function waitForExactCloudMutationSet(familyId, idToken, expectedEvents, absentEvents = []) {
  invariant(expectedEvents.length > 0, 'Expected cloud mutation set is required')
  const { id, rev } = expectedEvents[0]
  invariant(expectedEvents.every(event => event.id === id && event.rev === rev),
    'Expected cloud mutation set must share one event id and revision')
  const expectedPayloads = new Map(expectedEvents.map(event => [makeMutationDocId(event), stableJson(event)]))
  const absentDocIds = new Set(absentEvents.map(makeMutationDocId))
  const relevantRevisions = new Set([...expectedEvents, ...absentEvents].map(event => event.rev))
  const deadline = Date.now() + E2E_TIMEOUT_MS
  let lastRelevant = []
  while (Date.now() < deadline) {
    const documents = await readCloudEventDocuments(familyId, idToken)
    lastRelevant = documents.filter(document => (
      document.event.id === id && relevantRevisions.has(document.event.rev)
    ))
    const unexpected = lastRelevant.filter(document => (
      absentDocIds.has(document.docId) || !expectedPayloads.has(document.docId)
    ))
    invariant(unexpected.length === 0,
      `Cloud contains unexpected same-id/rev mutations: ${stableJson(unexpected)}`)
    const complete = expectedEvents.every(event => lastRelevant.some(document => (
      document.docId === makeMutationDocId(event)
      && stableJson(document.event) === stableJson(event)
    )))
    if (complete) {
      invariant(lastRelevant.length === expectedEvents.length,
        `Cloud mutation count mismatch: ${lastRelevant.length}/${expectedEvents.length}`)
      return lastRelevant
    }
    await delay(100)
  }
  throw new Error(`Exact cloud mutation set did not converge: ${stableJson(lastRelevant)}`)
}

async function waitForLocalOperationSource(device, operation, preMutationStorageKeys) {
  const deadline = Date.now() + E2E_TIMEOUT_MS
  let lastCandidates = []
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot(device)
    lastCandidates = snapshot.mutations.filter(event => (
      !preMutationStorageKeys.has(mutationStorageKey(event))
      && matchesExpectedLocalOperationMutation(event, {
        ...operation,
        finishedAt: Date.now(),
      })
    ))
    invariant(lastCandidates.length <= 1,
      `${device.name}: operation created multiple matching local v4 sources`)
    if (lastCandidates.length === 1) return lastCandidates[0]
    await delay(100)
  }
  throw new Error(`${device.name}: new local operation source was not observed: ${stableJson(lastCandidates)}`)
}

async function waitForDurableCanonicalMutation(device, source, writerUid) {
  const expected = buildExpectedCanonicalMutation(source, writerUid)
  if (expected === source) return source
  const sourcePayload = stableJson(source)
  const expectedPayload = stableJson(expected)
  const deadline = Date.now() + E2E_TIMEOUT_MS
  while (Date.now() < deadline) {
    const mutations = (await readSnapshot(device)).mutations
    const retainedSources = mutations.filter(candidate => stableJson(candidate) === sourcePayload)
    invariant(retainedSources.length === 1,
      `${device.name}: local v4 source must remain exactly once, got ${retainedSources.length}`)
    const derivatives = mutations.filter(candidate => stableJson(candidate) === expectedPayload)
    invariant(derivatives.length <= 1,
      `${device.name}: duplicate exact auth-bound derivatives were appended`)
    const derivativeContentId = mutationContentId(expected)
    const chainedDerivatives = mutations.filter(candidate => (
      candidate.migration?.sourceContentId === derivativeContentId
    ))
    invariant(chainedDerivatives.length === 0,
      `${device.name}: derivative-of-derivative mutation was appended`)
    if (derivatives.length === 1) return expected
    await delay(100)
  }
  throw new Error(`${device.name}: exact durable auth-bound derivative was not observed`)
}

async function waitForExactLocalMutationSet(device, eventId, expectedMutations) {
  const expectedPayloads = new Set(expectedMutations.map(stableJson))
  const expectedRevisions = new Set(expectedMutations.map(event => event.rev))
  const deadline = Date.now() + E2E_TIMEOUT_MS
  let lastMutations = []
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot(device)
    lastMutations = snapshot.mutations.filter(event => (
      event.id === eventId && expectedRevisions.has(event.rev)
    ))
    const unexpected = lastMutations.filter(event => !expectedPayloads.has(stableJson(event)))
    invariant(unexpected.length === 0,
      `${device.name}: unexpected local same-id/rev mutations: ${stableJson(unexpected)}`)
    const complete = expectedMutations.every(expected => (
      lastMutations.filter(event => stableJson(event) === stableJson(expected)).length === 1
    ))
    if (complete) {
      invariant(lastMutations.length === expectedMutations.length,
        `${device.name}: local mutation count mismatch: ${lastMutations.length}/${expectedMutations.length}`)
      return snapshot
    }
    await delay(100)
  }
  throw new Error(`${device.name}: exact local mutation set did not converge: ${stableJson(lastMutations)}`)
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
  const beforeSnapshot = await readSnapshot(device)
  const before = normalizeConvergence(beforeSnapshot.events)
  const preMutationStorageKeys = new Set(beforeSnapshot.mutations.map(mutationStorageKey))
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
  const deadline = Date.now() + E2E_TIMEOUT_MS
  let source = null
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot(device)
    const candidates = snapshot.mutations.filter(event => (
      !preMutationStorageKeys.has(mutationStorageKey(event))
      && !before.some(previous => previous.id === event.id)
      && event.type === type
      && event.migration === undefined
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(event.mutationId)
    ))
    invariant(candidates.length <= 1, `${device.name}: quick add created multiple local sources`)
    if (candidates.length === 1) {
      source = candidates[0]
      break
    }
    await delay(100)
  }
  invariant(source, `${device.name}: ${type} local source was not created`)
  return waitForDurableCanonicalMutation(device, source, beforeSnapshot.settings.profile.uid)
}

function toLocalDateTime(iso, minuteDelta) {
  const date = new Date(iso)
  date.setMinutes(date.getMinutes() + minuteDelta)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function editEventTime(device, event) {
  await openHome(device)
  const before = await readSnapshot(device)
  const prior = before.events.find(candidate => candidate.id === event.id)
  invariant(prior && !prior.deleted, `${device.name}: live event to edit is missing or deleted`)
  const preMutationStorageKeys = new Set(before.mutations.map(mutationStorageKey))
  const item = device.page.locator(`[data-event-id="${event.id}"]`)
  await item.locator('[data-event-action="edit"]').click()
  const modal = device.page.locator('[data-time-edit-modal]')
  await modal.waitFor({ state: 'visible', timeout: E2E_TIMEOUT_MS })
  const localDateTime = toLocalDateTime(event.at, -30)
  const expectedAt = new Date(localDateTime).toISOString()
  await modal.locator('[data-time-edit-input]').fill(localDateTime)
  const startedAt = Date.now()
  await modal.locator('[data-time-edit-action="confirm"]').click()
  const localSource = await waitForLocalOperationSource(device, {
    prior,
    expectedAt,
    expectedDeleted: false,
    startedAt,
  }, preMutationStorageKeys)
  const expectedSource = buildExpectedEditedEvent(prior, expectedAt, {
    updatedAt: localSource.updatedAt,
    mutationId: localSource.mutationId,
  }, { startedAt, finishedAt: Date.now() })
  invariant(
    stableJson(localSource) === stableJson(expectedSource),
    `${device.name}: local edited source mismatch: ${stableJson(localSource)}/${stableJson(expectedSource)}`,
  )
  const canonical = await waitForDurableCanonicalMutation(device, localSource, before.settings.profile.uid)
  return { source: localSource, canonical }
}

async function deleteEvent(device, event) {
  await openHome(device)
  const before = await readSnapshot(device)
  const prior = before.events.find(candidate => candidate.id === event.id)
  invariant(prior && !prior.deleted, `${device.name}: live event to delete is missing or deleted`)
  const preMutationStorageKeys = new Set(before.mutations.map(mutationStorageKey))
  const item = device.page.locator(`[data-event-id="${event.id}"]`)
  await item.locator('[data-event-action="delete"]').click()
  const startedAt = Date.now()
  await item.locator('[data-event-action="confirm-delete"]').click()
  const localSource = await waitForLocalOperationSource(device, {
    prior,
    expectedAt: prior.at,
    expectedDeleted: true,
    startedAt,
  }, preMutationStorageKeys)
  const expectedSource = buildExpectedDeletedEvent(prior, {
    updatedAt: localSource.updatedAt,
    mutationId: localSource.mutationId,
  }, { startedAt, finishedAt: Date.now() })
  invariant(
    stableJson(localSource) === stableJson(expectedSource),
    `${device.name}: local deleted source mismatch: ${stableJson(localSource)}/${stableJson(expectedSource)}`,
  )
  const canonical = await waitForDurableCanonicalMutation(device, localSource, before.settings.profile.uid)
  return { source: localSource, canonical }
}

async function runInsideEmulators() {
  assertEmulatorEnvironment(process.env)
  const executablePath = resolvePackagedExecutable({
    override: process.env.BABYDIARY_SYNC_E2E_EXECUTABLE,
  })
  const canonicalUpgradeProfile = process.env.BABYDIARY_SYNC_E2E_UPGRADE_PROFILE
    ? resolveCanonicalUpgradeProfile({ override: process.env.BABYDIARY_SYNC_E2E_UPGRADE_PROFILE })
    : null
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
    if (canonicalUpgradeProfile) {
      console.log('[sync-e2e] continue on exact upgraded canonical profile before fresh-device coverage')
      await runCanonicalUpgradeProfileContinuation({
        executablePath,
        canonicalUpgradeProfile,
        email: `sync-e2e-upgrade-${suffix}@example.test`,
        password,
        rendererErrors,
        blockedRequests,
        diagnosticFiles,
      })
    }
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
    const cloudReadAuth = await signInExistingAuthEmulatorAccount(emailA, password)
    invariant(cloudReadAuth.localId === uidA, 'Cloud verification token does not belong to device A')
    const cloudReadIdToken = cloudReadAuth.idToken

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
    const editedOperation = await editEventTime(b, firstA)
    const expectedEdited = editedOperation.canonical
    await waitForSemanticEvent(a, expectedEdited)
    const deletedOperation = await deleteEvent(a, firstB)
    const expectedDeleted = deletedOperation.canonical
    await waitForSemanticEvent(b, expectedDeleted)

    const [finalA, finalB, operationCloudDocuments] = await Promise.all([
      readSnapshot(a),
      readSnapshot(b),
      readCloudEventDocuments(familyA, cloudReadIdToken),
    ])
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
      normalizedA.some(event => event.id === firstA.id && event.rev === expectedEdited.rev && !event.deleted),
      `Edited event did not converge at rev ${expectedEdited.rev}`,
    )
    invariant(
      normalizedA.some(event => event.id === firstB.id && event.rev === expectedDeleted.rev && event.deleted),
      `Deleted event tombstone did not converge at rev ${expectedDeleted.rev}`,
    )
    invariant(
      normalizedA.some(event => event.id === offlineForB.id && event.rev === offlineForB.rev && !event.deleted),
      `Offline-created event did not converge at rev ${offlineForB.rev}`,
    )
    const editedA = finalA.events.find(event => event.id === firstA.id && event.rev === expectedEdited.rev)
    const editedB = finalB.events.find(event => event.id === firstA.id && event.rev === expectedEdited.rev)
    invariant(
      semanticEventsEqual(editedA, expectedEdited) && semanticEventsEqual(editedB, expectedEdited),
      `Edited event payload mismatch: ${stableJson(semanticEventPayload(editedA))}/${stableJson(semanticEventPayload(editedB))}`,
    )
    invariant(
      stableJson(editedA) === stableJson(expectedEdited) && stableJson(editedB) === stableJson(expectedEdited),
      `Edited event did not converge to the exact canonical derivative on both devices`,
    )
    const deletedA = finalA.events.find(event => event.id === firstB.id && event.rev === expectedDeleted.rev)
    const deletedB = finalB.events.find(event => event.id === firstB.id && event.rev === expectedDeleted.rev)
    invariant(
      semanticEventsEqual(deletedA, expectedDeleted) && semanticEventsEqual(deletedB, expectedDeleted),
      'Deleted poop tombstone payload did not converge',
    )
    invariant(
      stableJson(deletedA) === stableJson(expectedDeleted) && stableJson(deletedB) === stableJson(expectedDeleted),
      'Deleted tombstone did not converge to the exact canonical derivative on both devices',
    )
    for (const [label, operation] of [['edit', editedOperation], ['delete', deletedOperation]]) {
      const canonicalDocuments = operationCloudDocuments.filter(
        document => document.docId === makeMutationDocId(operation.canonical),
      )
      invariant(canonicalDocuments.length === 1,
        `Cloud must contain exactly one ${label} canonical derivative, got ${canonicalDocuments.length}`)
      invariant(stableJson(canonicalDocuments[0].event) === stableJson(operation.canonical),
        `Cloud ${label} canonical derivative bytes differ from the deterministic expected event`)
      if (stableJson(operation.source) !== stableJson(operation.canonical)) {
        const sourceDocuments = operationCloudDocuments.filter(
          document => document.docId === makeMutationDocId(operation.source),
        )
        invariant(sourceDocuments.length === 0,
          `Cloud must not contain the local-only ${label} v4 source, got ${sourceDocuments.length}`)
        const chainedDocuments = operationCloudDocuments.filter(
          document => document.event.migration?.sourceContentId === mutationContentId(operation.canonical),
        )
        invariant(chainedDocuments.length === 0,
          `Cloud must not contain a ${label} derivative-of-derivative, got ${chainedDocuments.length}`)
      }
    }
    invariant(finalA.dataInfo.eventCount === 2 && finalB.dataInfo.eventCount === 2, `Expected two active events, got ${finalA.dataInfo.eventCount}/${finalB.dataInfo.eventCount}`)
    invariant(finalA.settings.familyId === familyA && finalB.settings.familyId === familyA, 'Final family id was not preserved')
    const expectedBaby = JSON.stringify({ name: 'Sync Baby', birthdate: '2026-01-15' })
    invariant(JSON.stringify(finalA.settings.baby) === expectedBaby, `A baby identity changed: ${JSON.stringify(finalA.settings.baby)}`)
    invariant(JSON.stringify(finalB.settings.baby) === expectedBaby, `B baby identity changed: ${JSON.stringify(finalB.settings.baby)}`)

    console.log('[sync-e2e] deterministic offline same-id/rev payload conflict')
    await Promise.all([closeDevice(a), closeDevice(b)])
    const [conflictA, conflictB] = buildSameRevisionConflicts(offlineForB)
    const canonicalConflicts = [
      buildExpectedCanonicalMutation(conflictA, uidA),
      buildExpectedCanonicalMutation(conflictB, uidB),
    ]
    const expectedConflict = selectMutationWinner(canonicalConflicts)
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
      waitForExactLocalMutationSet(a, offlineForB.id, [conflictA, ...canonicalConflicts]),
      waitForExactLocalMutationSet(b, offlineForB.id, [conflictB, ...canonicalConflicts]),
      waitForExactCloudMutationSet(familyA, cloudReadIdToken, canonicalConflicts, [conflictA, conflictB]),
    ])
    const expectedLocalConflicts = [
      ['A', conflictSnapshotA, [conflictA, ...canonicalConflicts]],
      ['B', conflictSnapshotB, [conflictB, ...canonicalConflicts]],
    ]
    for (const [name, snapshot, expectedMutations] of expectedLocalConflicts) {
      const expectedRevisions = new Set(expectedMutations.map(event => event.rev))
      const localMutations = snapshot.mutations
        .filter(event => event.id === offlineForB.id && expectedRevisions.has(event.rev))
      invariant(localMutations.length === expectedMutations.length,
        `${name} conflict mutation count mismatch: ${localMutations.length}/${expectedMutations.length}`)
      for (const conflict of expectedMutations) {
        const conflictPayload = stableJson(conflict)
        const matchingMutations = localMutations.filter(event => stableJson(event) === conflictPayload)
        invariant(
          matchingMutations.length === 1,
          `${name} must preserve the exact conflict mutation once: ${conflict.mutationId}`,
        )
      }
      const chainedDerivatives = localMutations.filter(event => (
        canonicalConflicts.some(canonical => event.migration?.sourceContentId === mutationContentId(canonical))
      ))
      invariant(chainedDerivatives.length === 0, `${name} retained a derivative-of-derivative conflict`)
    }
    for (const conflict of canonicalConflicts) {
      const cloudDocument = cloudDocuments.find(
        document => document.docId === makeMutationDocId(conflict),
      )
      invariant(
        cloudDocument && stableJson(cloudDocument.event) === stableJson(conflict),
        `Cloud canonical conflict payload mismatch for mutation ${conflict.mutationId}`,
      )
    }
    invariant(!cloudDocuments.some(document => document.docId === makeMutationDocId(conflictB)),
      'Cloud retained the local-only B conflict source')
    const visibleConflictA = conflictSnapshotA.events.find(event => event.id === expectedConflict.id)
    const visibleConflictB = conflictSnapshotB.events.find(event => event.id === expectedConflict.id)
    invariant(
      stableJson(visibleConflictA) === stableJson(expectedConflict)
      && stableJson(visibleConflictB) === stableJson(expectedConflict),
      'Both devices must expose the exact deterministic canonical conflict winner',
    )
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
