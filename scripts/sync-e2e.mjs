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
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIREBASE_CLI_VERSION = '15.23.0'
export const FIREBASE_PROJECT_ID = 'demo-baby-diary'
export const FIREBASE_AUTH_PORT = 9099
export const FIRESTORE_PORT = 8080

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
const E2E_TIMEOUT_MS = 30_000

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

function packagedResourcePath(executablePath, platform) {
  if (platform === 'win32') {
    if (path.basename(executablePath).toLowerCase() !== 'baby diary.exe') return null
    return path.join(path.dirname(executablePath), 'resources', 'app.asar')
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

export function resolvePackagedExecutable({
  root = ROOT,
  platform = process.platform,
  override,
  exists = existsSync,
} = {}) {
  invariant(
    platform === 'win32' || platform === 'darwin',
    'Packaged sync E2E supports Windows and macOS only',
  )

  if (override) {
    const resolved = path.resolve(override)
    invariant(exists(resolved), `Packaged executable not found: ${resolved}`)
    const resourcePath = packagedResourcePath(resolved, platform)
    invariant(resourcePath, `Executable must be a packaged Baby Diary app for ${platform}: ${resolved}`)
    invariant(exists(resourcePath), `Packaged app.asar not found: ${resourcePath}`)
    return resolved
  }

  let candidates
  if (platform === 'win32') {
    candidates = [path.join(root, 'release', 'win-unpacked', 'Baby Diary.exe')]
  } else if (platform === 'darwin') {
    candidates = ['mac', 'mac-arm64', 'mac-universal', 'mac-x64'].map(directory =>
      path.join(root, 'release', directory, 'Baby Diary.app', 'Contents', 'MacOS', 'Baby Diary'),
    )
  }

  const executable = candidates.find(candidate => {
    const resourcePath = packagedResourcePath(candidate, platform)
    return resourcePath && exists(candidate) && exists(resourcePath)
  })
  invariant(executable, `Packaged executable not found. Checked: ${candidates.join(', ')}`)
  return executable
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
  const latest = new Map()
  for (const event of events) {
    if (!event || typeof event.id !== 'string') continue
    const current = latest.get(event.id)
    if (
      !current
      || event.rev > current.rev
      || (event.rev === current.rev && event.deleted && !current.deleted)
    ) {
      latest.set(event.id, {
        id: event.id,
        rev: event.rev,
        deleted: Boolean(event.deleted),
      })
    }
  }
  return [...latest.values()].sort((a, b) => a.id.localeCompare(b.id))
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
      at: shiftedAt(-45),
      updatedAt: new Date(nowMs).toISOString(),
      rev: baseEvent.rev + 1,
      deleted: false,
    },
    {
      ...baseEvent,
      at: shiftedAt(45),
      updatedAt: new Date(nowMs + 1).toISOString(),
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

export function isAllowedNetworkUrl(rawUrl) {
  const url = new URL(rawUrl)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return true
  const host = url.hostname.toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost') return false
  return Number(url.port) === FIREBASE_AUTH_PORT || Number(url.port) === FIRESTORE_PORT
}

export function assertCleanDiagnostics(blockedRequests, consoleErrors) {
  invariant(
    blockedRequests.length === 0,
    `Blocked non-emulator network requests: ${blockedRequests.join(' | ')}`,
  )
  invariant(
    consoleErrors.length === 0,
    `Unexpected renderer errors: ${consoleErrors.join(' | ')}`,
  )
}

async function launchDevice({ executablePath, userData, name, consoleErrors, blockedRequests }) {
  const { _electron: electron } = await import('playwright')
  const app = await electron.launch({
    executablePath,
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      BABYDIARY_TEST_USERDATA: userData,
      BABYDIARY_FIREBASE_EMULATOR: '1',
      BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID: FIREBASE_PROJECT_ID,
      FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${FIREBASE_AUTH_PORT}`,
      FIRESTORE_EMULATOR_HOST: `127.0.0.1:${FIRESTORE_PORT}`,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  })

  const context = app.context()
  await context.route('**/*', async route => {
    const url = route.request().url()
    if (isAllowedNetworkUrl(url)) {
      await route.continue()
    } else {
      blockedRequests.push(`${name}: ${url}`)
      await route.abort('blockedbyclient')
    }
  })

  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1200, height: 800 })
  page.on('console', message => {
    if (message.type() !== 'error') return
    consoleErrors.push(`${name}: ${message.text()}`)
  })
  page.on('pageerror', error => consoleErrors.push(`${name}: ${error.message}`))
  await page.waitForSelector('[data-tour="navigation"]', { timeout: E2E_TIMEOUT_MS })
  return { app, page, userData, name }
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
    settings: await window.babyDiary.getSettings(),
    dataInfo: await window.babyDiary.getDataInfo(),
  }))
}

function convergencePayload(event) {
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
  }
}

async function waitForConflictConvergence(deviceA, deviceB, eventId, allowedAt) {
  const deadline = Date.now() + E2E_TIMEOUT_MS
  let lastA = null
  let lastB = null
  while (Date.now() < deadline) {
    const [snapshotA, snapshotB] = await Promise.all([
      readSnapshot(deviceA),
      readSnapshot(deviceB),
    ])
    lastA = convergencePayload(snapshotA.events.find(event => event.id === eventId))
    lastB = convergencePayload(snapshotB.events.find(event => event.id === eventId))
    if (
      lastA?.rev >= 2
      && lastB?.rev >= 2
      && JSON.stringify(lastA) === JSON.stringify(lastB)
      && allowedAt.includes(lastA.at)
    ) {
      return lastA
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }

  throw new Error(
    `Same-revision conflict did not converge: ${JSON.stringify(lastA)} / ${JSON.stringify(lastB)}`,
  )
}

async function waitForEvent(device, expected) {
  await device.page.waitForFunction(
    async value => {
      const events = await window.babyDiary.listEvents()
      return events.some(event =>
        event.id === value.id
        && event.rev >= value.rev
        && (value.deleted == null || event.deleted === value.deleted),
      )
    },
    expected,
    { timeout: E2E_TIMEOUT_MS },
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
  await modal.locator('[data-time-edit-action="confirm"]').click()
  await waitForEvent(device, { id: event.id, rev: event.rev + 1, deleted: false })
  return expectedAt
}

async function deleteEvent(device, event) {
  await openHome(device)
  const item = device.page.locator(`[data-event-id="${event.id}"]`)
  await item.locator('[data-event-action="delete"]').click()
  await item.locator('[data-event-action="confirm-delete"]').click()
  await waitForEvent(device, { id: event.id, rev: event.rev + 1, deleted: true })
}

async function closeDevice(device) {
  if (!device?.app) return
  await device.app.close()
  device.app = null
}

async function runInsideEmulators() {
  assertEmulatorEnvironment(process.env)
  const executablePath = resolvePackagedExecutable({
    override: process.env.BABYDIARY_SYNC_E2E_EXECUTABLE,
  })
  const rootTemp = mkdtempSync(path.join(os.tmpdir(), 'baby-diary-sync-e2e-'))
  const userDataA = path.join(rootTemp, 'device-a')
  const userDataB = path.join(rootTemp, 'device-b')
  invariant(userDataA !== userDataB, 'Device A and B must use different userData directories')
  writeSeed(userDataA, 'Device A')
  writeSeed(userDataB, 'Device B')

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const password = `Sync-E2E-${suffix}!9`
  const emailA = `sync-e2e-a-${suffix}@example.test`
  const emailB = `sync-e2e-b-${suffix}@example.test`
  const consoleErrors = []
  const blockedRequests = []
  let a
  let b

  try {
    console.log('[sync-e2e] launch isolated packaged apps A and B')
    a = await launchDevice({ executablePath, userData: userDataA, name: 'A', consoleErrors, blockedRequests })
    b = await launchDevice({ executablePath, userData: userDataB, name: 'B', consoleErrors, blockedRequests })
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
    await waitForEvent(b, { id: firstA.id, rev: 1, deleted: false })
    const firstB = await addQuickEvent(b, 'poop')
    invariant(firstB.author.uid === uidB, `B event author mismatch: ${firstB.author.uid}/${uidB}`)
    await waitForEvent(a, { id: firstB.id, rev: 1, deleted: false })

    console.log('[sync-e2e] close B, create on A, relaunch B and restore auth/family/missing event')
    await closeDevice(b)
    const offlineForB = await addQuickEvent(a, 'pee')
    b = await launchDevice({ executablePath, userData: userDataB, name: 'B-relaunch', consoleErrors, blockedRequests })
    await dismissFirstLaunch(b)
    await openSettings(b)
    await b.page.locator('[data-sync-state="online"]').waitFor({ state: 'visible', timeout: E2E_TIMEOUT_MS })
    invariant(await b.page.locator('[data-sync-auth-form]').count() === 0, 'B relaunch did not restore authentication')
    await waitForEvent(b, { id: offlineForB.id, rev: 1, deleted: false })
    invariant((await readSnapshot(b)).settings.familyId === familyA, 'B relaunch did not restore family identity')

    console.log('[sync-e2e] revision edit and tombstone convergence')
    const expectedEditedAt = await editEventTime(b, firstA)
    await waitForEvent(a, { id: firstA.id, rev: 2, deleted: false })
    await deleteEvent(a, firstB)
    await waitForEvent(b, { id: firstB.id, rev: 2, deleted: true })

    const [finalA, finalB] = await Promise.all([readSnapshot(a), readSnapshot(b)])
    const normalizedA = normalizeConvergence(finalA.events)
    const normalizedB = normalizeConvergence(finalB.events)
    invariant(JSON.stringify(normalizedA) === JSON.stringify(normalizedB), `Final convergence mismatch: ${JSON.stringify(normalizedA)} / ${JSON.stringify(normalizedB)}`)
    invariant(normalizedA.length === 3, `Expected exactly 3 event ids, got ${normalizedA.length}`)
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
      editedA?.type === 'pee' && editedB?.type === 'pee'
      && editedA.at === expectedEditedAt && editedB.at === expectedEditedAt,
      `Edited event payload mismatch: ${editedA?.at}/${editedB?.at}/${expectedEditedAt}`,
    )
    const deletedA = finalA.events.find(event => event.id === firstB.id && event.rev === 2)
    const deletedB = finalB.events.find(event => event.id === firstB.id && event.rev === 2)
    invariant(
      deletedA?.type === 'poop' && deletedB?.type === 'poop'
      && deletedA.deleted === true && deletedB.deleted === true,
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
    appendOfflineEvent(userDataA, conflictA)
    appendOfflineEvent(userDataB, conflictB)
    ;[a, b] = await Promise.all([
      launchDevice({ executablePath, userData: userDataA, name: 'A-conflict', consoleErrors, blockedRequests }),
      launchDevice({ executablePath, userData: userDataB, name: 'B-conflict', consoleErrors, blockedRequests }),
    ])
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
      offlineForB.id,
      [conflictA.at, conflictB.at],
    )
    invariant(convergedConflict.deleted === false, 'Same-revision conflict unexpectedly deleted the event')
    assertCleanDiagnostics(blockedRequests, consoleErrors)

    console.log(`[sync-e2e] PASS ${JSON.stringify({ familyId: familyA, events: normalizedA, conflictRev: convergedConflict.rev, activeCount: 2 })}`)
  } finally {
    await Promise.allSettled([closeDevice(a), closeDevice(b)])
    rmSync(rootTemp, { recursive: true, force: true })
  }
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
