/** Shared packaged-application driver for the v0.3.8 -> v0.3.9 upgrade gate. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  V038_SOURCE,
  assertSemanticIdempotence,
  assertSemanticPreservation,
  buildV038Fixture,
  canonicalJson,
  getBabyInfoMutationKey,
  materializeV038AuxiliaryFixture,
  projectUpgradeSemantics,
  semanticProjectionHash,
  validateV038Fixture,
} from './upgrade-data-contract.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = path.dirname(path.dirname(SCRIPT_PATH))
const RUN_ID_PATTERN = /^[0-9a-f]{32}$/
const SHA_PATTERN = /^[0-9a-f]{40}$/

export const DEFAULT_PHASE_TIMEOUTS = Object.freeze({
  launchMs: 45_000,
  firstWindowMs: 30_000,
  rendererMs: 30_000,
  closeMs: 30_000,
})

export const UPGRADE_MODES = Object.freeze([
  'baseline-initialize',
  'candidate-first-run',
  'candidate-second-run',
])

const CLI_FIELDS = Object.freeze({
  '--mode': 'mode',
  '--executable': 'executablePath',
  '--profile-root': 'profileRoot',
  '--temp-root': 'tempRoot',
  '--run-id': 'runId',
  '--diagnostic': 'diagnosticPath',
  '--projection-output': 'projectionOutputPath',
  '--comparison-projection': 'comparisonProjectionPath',
  '--source-sha': 'sourceSha',
  '--expected-version': 'expectedVersion',
  '--expected-arch': 'expectedArch',
  '--forbidden-root': 'forbiddenRoot',
})

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function normalizeForComparison(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function isStrictDescendant(parent, child) {
  const relative = path.relative(parent, child)
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function isEqualOrDescendant(parent, child) {
  return normalizeForComparison(parent) === normalizeForComparison(child) || isStrictDescendant(parent, child)
}

export function parseUpgradeCli(args) {
  invariant(Array.isArray(args), 'upgrade arguments must be an array')
  const parsed = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    const field = CLI_FIELDS[flag]
    if (!field) throw new Error(`unknown or secret-bearing upgrade argument: ${String(flag)}`)
    if (Object.prototype.hasOwnProperty.call(parsed, field)) throw new Error(`duplicate upgrade argument: ${flag}`)
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      throw new Error(`upgrade argument value is required: ${flag}`)
    }
    parsed[field] = value
  }
  const required = [
    'mode',
    'executablePath',
    'profileRoot',
    'tempRoot',
    'runId',
    'diagnosticPath',
    'projectionOutputPath',
    'sourceSha',
    'expectedVersion',
    'expectedArch',
  ]
  for (const field of required) invariant(typeof parsed[field] === 'string', `required upgrade argument is missing: ${field}`)
  invariant(UPGRADE_MODES.includes(parsed.mode), `upgrade mode is invalid: ${parsed.mode}`)
  if (parsed.mode !== 'baseline-initialize') {
    invariant(typeof parsed.comparisonProjectionPath === 'string', 'comparison projection is required for candidate mode')
  }
  return {
    ...parsed,
    forbiddenRoots: parsed.forbiddenRoot ? [parsed.forbiddenRoot] : [],
    platform: process.platform,
    env: process.env,
  }
}

export function canonicalProfileForPlatform(platform, env) {
  if (platform === 'win32') {
    invariant(typeof env.APPDATA === 'string' && env.APPDATA.length > 0, 'APPDATA is required')
    return path.win32.resolve(env.APPDATA, 'baby-diary')
  }
  if (platform === 'darwin') {
    invariant(typeof env.HOME === 'string' && env.HOME.length > 0, 'HOME is required')
    return path.posix.resolve(env.HOME, 'Library', 'Application Support', 'baby-diary')
  }
  if (platform === 'linux') {
    invariant(typeof env.HOME === 'string' && env.HOME.length > 0, 'HOME is required')
    const appData = env.XDG_CONFIG_HOME || path.posix.resolve(env.HOME, '.config')
    return path.posix.resolve(appData, 'baby-diary')
  }
  throw new Error(`unsupported upgrade platform: ${platform}`)
}

async function assertExistingComponentsAreUnlinked(root, target, label) {
  let current = root
  const relative = path.relative(root, target)
  const components = relative.length === 0 ? [] : relative.split(path.sep)
  for (const component of components) {
    current = path.join(current, component)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink()) throw new Error(`${label} crosses a link/reparse point`)
      if (!stats.isDirectory() && normalizeForComparison(current) !== normalizeForComparison(target)) {
        throw new Error(`${label} crosses a non-directory path component`)
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

/** Validate only run-owned paths; it never creates or removes them. */
export async function validateNonceOwnedPaths({
  tempRoot,
  profileRoot,
  outputPaths = [],
  runId,
  forbiddenRoots = [],
}) {
  invariant(RUN_ID_PATTERN.test(runId), 'upgrade run id must be a lowercase 32-hex nonce')
  const canonicalTemp = path.resolve(tempRoot)
  const canonicalProfile = path.resolve(profileRoot)
  invariant(path.basename(canonicalTemp).includes(runId), 'upgrade temp root is not bound to the run nonce')
  const tempStats = await lstat(canonicalTemp)
  invariant(tempStats.isDirectory() && !tempStats.isSymbolicLink(), 'upgrade temp root must be a regular directory')
  invariant(normalizeForComparison(await realpath(canonicalTemp)) === normalizeForComparison(canonicalTemp),
    'upgrade temp root resolves through a link/reparse point')
  invariant(canonicalProfile !== canonicalTemp, 'profile root must not equal the temp root')
  invariant(isStrictDescendant(canonicalTemp, canonicalProfile), 'profile root is outside the nonce-owned temp root')
  for (const forbidden of forbiddenRoots) {
    if (typeof forbidden !== 'string' || forbidden.length === 0) continue
    invariant(!isEqualOrDescendant(path.resolve(forbidden), canonicalProfile), 'profile root is inside a real/forbidden root')
  }
  await assertExistingComponentsAreUnlinked(canonicalTemp, canonicalProfile, 'profile root')

  const canonicalOutputs = []
  for (const output of outputPaths.filter(Boolean)) {
    const canonicalOutput = path.resolve(output)
    invariant(isStrictDescendant(canonicalTemp, canonicalOutput), 'upgrade output path is outside the nonce-owned temp root')
    await assertExistingComponentsAreUnlinked(canonicalTemp, canonicalOutput, 'upgrade output path')
    canonicalOutputs.push(canonicalOutput)
  }
  return { tempRoot: canonicalTemp, profileRoot: canonicalProfile, outputPaths: canonicalOutputs }
}

export function buildPackagedLaunchEnvironment(sourceEnv = process.env) {
  const safe = {}
  const forbiddenName = /(?:BABYDIARY_TEST_USERDATA|PASSWORD|PASSWD|TOKEN|SECRET|API[_-]?KEY|FIREBASE)/i
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined || forbiddenName.test(key)) continue
    safe[key] = value
  }
  return {
    ...safe,
    NODE_ENV: 'production',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  }
}

export async function hashExecutable(executablePath) {
  const absolute = path.resolve(executablePath)
  const before = await lstat(absolute)
  invariant(before.isFile() && !before.isSymbolicLink(), 'upgrade executable must be a regular file')
  invariant(normalizeForComparison(await realpath(absolute)) === normalizeForComparison(absolute),
    'upgrade executable resolves through a link/reparse point')
  const hash = createHash('sha256')
  let bytes = 0
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(absolute)
    stream.on('data', chunk => {
      bytes += chunk.byteLength
      hash.update(chunk)
    })
    stream.once('error', rejectPromise)
    stream.once('end', resolvePromise)
  })
  const after = await lstat(absolute)
  invariant(after.isFile() && after.size === before.size && after.mtimeMs === before.mtimeMs && bytes === before.size,
    'upgrade executable changed while hashing')
  return hash.digest('hex')
}

export async function withTimeout(promise, timeoutMs, label) {
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'timeout must be a positive integer')
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} exceeded its bounded timeout`)
          error.code = 'UPGRADE_TIMEOUT'
          error.phase = label
          rejectPromise(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Bounds acquisition while retaining ownership of a resource that resolves
 * late. The disposer remains attached to the original promise after timeout,
 * preventing a late Electron launch from becoming an orphan.
 */
export async function acquireWithTimeout(acquisition, timeoutMs, label, disposeLate) {
  invariant(typeof disposeLate === 'function', 'late-resource disposer is required')
  const observed = Promise.resolve(acquisition)
  try {
    return await withTimeout(observed, timeoutMs, label)
  } catch (error) {
    if (error?.code === 'UPGRADE_TIMEOUT') {
      void observed.then(resource => disposeLate(resource)).catch(() => {
        // The phase already failed. The outer bounded process-tree guard is
        // the final cleanup backstop if even the late disposer cannot close.
      })
    }
    throw error
  }
}

function childHasExited(child) {
  return Boolean(child) && (child.exitCode !== null || child.signalCode !== null)
}

async function waitForChildExit(child, timeoutMs, label) {
  if (childHasExited(child)) return
  await new Promise((resolvePromise, rejectPromise) => {
    let timer
    const onExit = () => {
      clearTimeout(timer)
      child.off?.('exit', onExit)
      child.off?.('close', onExit)
      resolvePromise()
    }
    child.once('exit', onExit)
    child.once('close', onExit)
    timer = setTimeout(() => {
      child.off?.('exit', onExit)
      child.off?.('close', onExit)
      const error = new Error(`${label} exceeded its bounded timeout`)
      error.code = 'UPGRADE_TIMEOUT'
      error.phase = label
      rejectPromise(error)
    }, timeoutMs)
  })
}

async function terminateElectronChild(child, timeoutMs) {
  invariant(child && typeof child.kill === 'function', 'Electron child process is unavailable for cleanup')
  if (childHasExited(child)) return
  child.kill('SIGTERM')
  try {
    await waitForChildExit(child, timeoutMs, 'Electron graceful termination')
    return
  } catch (error) {
    if (error?.code !== 'UPGRADE_TIMEOUT') throw error
  }
  child.kill('SIGKILL')
  await waitForChildExit(child, timeoutMs, 'Electron forced termination')
  invariant(childHasExited(child), 'Electron child process did not exit after forced termination')
}

/** Close normally, then terminate and reap the real child if close is stuck. */
export async function closeElectronApplication(electronApp, timeoutMs) {
  try {
    await withTimeout(Promise.resolve().then(() => electronApp.close()), timeoutMs, 'Electron close')
  } catch (closeError) {
    try {
      await terminateElectronChild(electronApp.process(), timeoutMs)
    } catch (cleanupError) {
      const aggregate = new AggregateError(
        [closeError, cleanupError],
        'Electron close failed and bounded child-process cleanup did not complete',
      )
      aggregate.code = closeError?.code ?? 'UPGRADE_CLEANUP_FAILED'
      aggregate.phase = closeError?.phase ?? 'Electron close'
      throw aggregate
    }
    throw closeError
  }
}

export function sanitizeUpgradeDiagnostic(value) {
  return {
    sourceSha: value.sourceSha ?? null,
    executableSha256: value.executableSha256 ?? null,
    appVersion: value.appVersion ?? null,
    hostArchitecture: value.hostArchitecture ?? null,
    canonicalUserDataPath: value.canonicalUserDataPath ?? null,
    fixtureProjectionHash: value.fixtureProjectionHash ?? null,
    phase: value.phase ?? null,
    passed: value.passed === true,
    ...(value.failureCode ? { failureCode: String(value.failureCode).slice(0, 80) } : {}),
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, filePath)
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function waitForVisible(page, selector, timeoutMs, label) {
  const locator = page.locator(selector).first()
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs })
  } catch {
    throw new Error(`${label} is not visible in the packaged renderer`)
  }
  return locator
}

async function assertInputValue(page, selector, expected, timeoutMs, label) {
  const locator = await waitForVisible(page, selector, timeoutMs, label)
  await page.waitForFunction(
    ({ selector: inputSelector, expectedValue }) => {
      const input = document.querySelector(inputSelector)
      return input instanceof HTMLInputElement && input.value === expectedValue
    },
    { selector, expectedValue: expected },
    { timeout: timeoutMs },
  )
  invariant(await locator.inputValue() === expected, `${label} changed in the visible settings form`)
}

/**
 * Proves that the preserved candidate state is discoverable through the real
 * History and Settings routes, not only through an in-page IPC evaluation.
 */
export async function assertCandidateUiVisibility(page, publicView, timeoutMs) {
  invariant(isPlainObject(publicView?.identity), 'candidate UI identity is missing')
  invariant(Array.isArray(publicView.events), 'candidate UI event projection is missing')
  const formulaWinner = publicView.events.find(item => item?.id === 'legacy-formula')
  const deletedWinner = publicView.events.find(item => item?.id === 'legacy-diary-tombstone')
  invariant(formulaWinner?.rev === 2 && formulaWinner.deleted === false,
    'candidate IPC did not expose the preserved formula winner')
  invariant(deletedWinner?.rev === 2 && deletedWinner.deleted === true,
    'candidate IPC did not expose the preserved deleted winner')

  const tutorialSkip = page.locator('.tour-skip-button').first()
  if (await tutorialSkip.isVisible().catch(() => false)) await tutorialSkip.click()

  await (await waitForVisible(page, '[data-tour="nav-history"]', timeoutMs, 'History navigation')).click()
  await waitForVisible(page, '[data-tour="calendar"]', timeoutMs, 'History page')

  const targetDaySelector = '[data-history-date="2026-07-01"]'
  let targetDay
  for (let month = 0; month < 240; month += 1) {
    const candidate = page.locator(targetDaySelector).first()
    if (await candidate.isVisible().catch(() => false)) {
      targetDay = candidate
      break
    }
    await (await waitForVisible(
      page,
      '[data-history-period="previous"]',
      timeoutMs,
      'History previous-period control',
    )).click()
  }
  invariant(targetDay, 'preserved fixture day was not reachable through bounded History navigation')
  await targetDay.click()
  await (await waitForVisible(page, '[data-history-preview-action]', timeoutMs, 'History day details')).click()

  await waitForVisible(
    page,
    '[data-event-id="legacy-formula"][data-event-rev="2"]',
    timeoutMs,
    'preserved formula revision',
  )
  await waitForVisible(
    page,
    '[data-event-id="legacy-poop"][data-event-rev="1"]',
    timeoutMs,
    'preserved legacy event',
  )
  invariant(await page.locator('[data-event-id="legacy-diary-tombstone"]').count() === 0,
    'deleted winner was rendered in History')

  await (await waitForVisible(page, '[data-tour="nav-settings"]', timeoutMs, 'Settings navigation')).click()
  await waitForVisible(page, '[data-tour="settings-main"]', timeoutMs, 'Settings page')
  await assertInputValue(
    page,
    '[data-settings-baby-name]',
    publicView.identity.baby.name,
    timeoutMs,
    'baby name',
  )
  await assertInputValue(
    page,
    '[data-settings-baby-birthdate]',
    publicView.identity.baby.birthdate,
    timeoutMs,
    'baby birthdate',
  )
  await assertInputValue(
    page,
    '[data-settings-account-name]',
    publicView.identity.account.name,
    timeoutMs,
    'account name',
  )
  const expectedRole = publicView.identity.account.role
  const role = await waitForVisible(
    page,
    `[data-settings-account-role="${expectedRole}"]`,
    timeoutMs,
    'account role',
  )
  invariant((await role.getAttribute('class'))?.split(/\s+/).includes('selected'),
    'preserved account role is not selected in Settings')

  const koButton = await waitForVisible(page, '[data-settings-language="ko"]', timeoutMs, 'Korean language option')
  const jaButton = await waitForVisible(page, '[data-settings-language="ja"]', timeoutMs, 'Japanese language option')
  invariant((await koButton.textContent())?.trim(), 'Korean language option has no visible label')
  invariant((await jaButton.textContent())?.trim(), 'Japanese language option has no visible label')
  const expectedLanguage = publicView.identity.preferences.language
  invariant(expectedLanguage === 'ko' || expectedLanguage === 'ja', 'preserved language is invalid')
  const expectedLanguageButton = expectedLanguage === 'ko' ? koButton : jaButton
  invariant((await expectedLanguageButton.getAttribute('class'))?.split(/\s+/).includes('selected'),
    'preserved language is not selected in Settings')
  await waitForVisible(page, '[data-sync-state]', timeoutMs, 'Sync status')
}

async function defaultRunPackagedSession({
  mode,
  executablePath,
  profileRoot,
  env,
  expectedBabyInfoKeys = [],
  timeouts = DEFAULT_PHASE_TIMEOUTS,
}) {
  const { _electron: electron } = await import('playwright')
  let electronApp
  try {
    electronApp = await acquireWithTimeout(electron.launch({
      executablePath,
      cwd: ROOT,
      env: buildPackagedLaunchEnvironment(env),
    }), timeouts.launchMs, 'Electron launch', lateApplication => (
      closeElectronApplication(lateApplication, timeouts.closeMs)
    ))
    const [{ version, architecture }, page] = await Promise.all([
      withTimeout(electronApp.evaluate(({ app }) => ({
        version: app.getVersion(),
        architecture: process.arch,
      })), timeouts.rendererMs, 'main-process attestation'),
      withTimeout(electronApp.firstWindow(), timeouts.firstWindowMs, 'first BrowserWindow'),
    ])
    await withTimeout(page.waitForFunction(() => Boolean(window.babyDiary)), timeouts.rendererMs, 'preload bridge')
    const fixture = mode === 'baseline-initialize' ? buildV038Fixture() : null
    const rendererResult = await withTimeout(page.evaluate(async payload => {
      const api = window.babyDiary
      if (payload.fixture) {
        await api.saveSettings(payload.fixture.settings)
        for (const item of payload.fixture.events) {
          const result = await api.appendEvent(item)
          if (result !== 'ok') throw new Error('baseline fixture append did not return ok')
        }
      }
      const [settings, events, dataInfo] = await Promise.all([
        api.getSettings(),
        api.listEvents(),
        api.getDataInfo(),
      ])
      const identity = {
        baby: {
          name: settings.baby.name,
          birthdate: settings.baby.birthdate,
          ...(settings.baby.gender === undefined ? {} : { gender: settings.baby.gender }),
        },
        account: {
          uid: settings.profile.uid,
          name: settings.profile.name,
          role: settings.profile.role,
        },
        familyId: settings.familyId,
        preferences: {
          language: settings.language ?? null,
          theme: settings.theme ?? null,
        },
      }
      let babyInfo
      if (payload.mode === 'baseline-initialize') {
        babyInfo = {
          kind: 'legacy-settings',
          mutations: settings.babyInfoSync?.mutations,
          pendingKeys: settings.babyInfoSync?.pendingMutationKeys,
        }
      } else {
        for (const method of ['getBabyInfoSummary', 'listPendingBabyInfo', 'getBabyInfoMutation']) {
          if (typeof api[method] !== 'function') throw new Error(`candidate preload is missing ${method}`)
        }
        const summary = await api.getBabyInfoSummary(settings.familyId)
        const pendingItems = []
        const seenCursors = new Set()
        let afterKey
        for (let pageNumber = 0; pageNumber < 64; pageNumber += 1) {
          const page = await api.listPendingBabyInfo({
            familyId: settings.familyId,
            limit: 500,
            ...(afterKey === undefined ? {} : { afterKey }),
          })
          if (!page || !Array.isArray(page.items)) throw new Error('candidate pending baby-info page is invalid')
          pendingItems.push(...page.items)
          if (page.nextCursor === undefined) {
            afterKey = undefined
            break
          }
          if (typeof page.nextCursor !== 'string' || seenCursors.has(page.nextCursor)) {
            throw new Error('candidate pending baby-info cursor did not advance')
          }
          seenCursors.add(page.nextCursor)
          afterKey = page.nextCursor
        }
        if (afterKey !== undefined) throw new Error('candidate pending baby-info pagination exceeded its bound')
        const mutationEntries = []
        for (const key of payload.expectedBabyInfoKeys) {
          mutationEntries.push([key, await api.getBabyInfoMutation(settings.familyId, key)])
        }
        babyInfo = {
          kind: 'journal-ipc',
          hasLegacyBabyInfoSync: settings.babyInfoSync !== undefined,
          settingsJournal: settings.babyInfoJournal ?? null,
          summary,
          pendingItems,
          mutationEntries,
        }
      }
      return {
        dataDir: dataInfo.dataDir,
        publicView: {
          identity,
          events,
          dataInfoEventCount: dataInfo.eventCount,
          babyInfo,
        },
      }
    }, { mode, fixture, expectedBabyInfoKeys }), timeouts.rendererMs, `${mode} renderer contract`)
    invariant(typeof rendererResult.dataDir === 'string', 'packaged application did not report its data directory')
    const canonicalUserDataPath = path.dirname(rendererResult.dataDir)
    invariant(normalizeForComparison(canonicalUserDataPath) === normalizeForComparison(profileRoot),
      'packaged application selected an unexpected user-data directory')
    if (mode !== 'baseline-initialize') {
      await assertCandidateUiVisibility(page, rendererResult.publicView, timeouts.rendererMs)
    }
    return {
      appVersion: version,
      hostArchitecture: architecture,
      canonicalUserDataPath: path.resolve(canonicalUserDataPath),
      publicView: rendererResult.publicView,
    }
  } finally {
    if (electronApp) await closeElectronApplication(electronApp, timeouts.closeMs)
  }
}

function canonicalMutationMap(items, label) {
  invariant(Array.isArray(items), `${label} mutations must be an array`)
  const result = new Map()
  for (const mutation of items) {
    const key = getBabyInfoMutationKey(mutation)
    invariant(!result.has(key), `${label} exposes a duplicate baby-info mutation`)
    result.set(key, canonicalJson(mutation))
  }
  return result
}

function assertStringSetEquals(actual, expected, label) {
  invariant(Array.isArray(actual) && actual.every(item => typeof item === 'string'), `${label} must be a string array`)
  const normalized = [...new Set(actual)].sort(compareUtf8)
  invariant(normalized.length === actual.length, `${label} contains a duplicate`)
  invariant(canonicalJson(normalized) === canonicalJson([...expected].sort(compareUtf8)), `${label} changed`)
}

/** Proves that preserved bytes remain discoverable through the packaged public IPC surface. */
export function assertRuntimeDiscoverability(projection, runtimeView, mode) {
  invariant(isPlainObject(runtimeView), 'runtime public IPC projection is missing')
  invariant(canonicalJson(runtimeView.identity) === canonicalJson(projection.identity),
    'runtime getSettings account/family/baby identity changed')

  invariant(Array.isArray(runtimeView.events), 'runtime listEvents result is missing')
  const sourcesByCanonical = new Map(projection.eventSources.map(item => [item.canonical, item]))
  const visibleIds = new Set()
  const runtimeWinners = runtimeView.events.map(item => {
    const canonical = canonicalJson(item)
    const source = sourcesByCanonical.get(canonical)
    invariant(source, 'runtime listEvents exposed a substituted or non-source event')
    invariant(!visibleIds.has(source.id), 'runtime listEvents exposed multiple current revisions for one id')
    visibleIds.add(source.id)
    return { id: source.id, rev: source.rev, deleted: source.deleted, contentId: source.contentId }
  }).sort((left, right) => compareUtf8(left.id, right.id))
  invariant(canonicalJson(runtimeWinners) === canonicalJson(projection.eventWinners),
    'runtime listEvents current revision/tombstone visibility changed')
  const expectedVisibleCount = projection.eventWinners.filter(item => !item.deleted).length
  invariant(runtimeView.dataInfoEventCount === expectedVisibleCount,
    'runtime getDataInfo visible event count changed')

  const expectedMutations = new Map(projection.babyInfo.mutations.map(item => [
    item.key,
    canonicalJson(JSON.parse(item.canonical)),
  ]))
  const expectedPending = new Set(projection.babyInfo.pendingKeys)
  const expectedAcknowledged = new Set(projection.babyInfo.acknowledgedKeys)
  const babyInfo = runtimeView.babyInfo
  invariant(isPlainObject(babyInfo), 'runtime baby-info projection is missing')

  if (mode === 'baseline-initialize') {
    invariant(babyInfo.kind === 'legacy-settings', 'baseline getSettings legacy baby-info state is missing')
    const actualMutations = canonicalMutationMap(babyInfo.mutations, 'baseline getSettings')
    invariant(canonicalJson([...actualMutations.entries()].sort(([left], [right]) => compareUtf8(left, right)))
      === canonicalJson([...expectedMutations.entries()].sort(([left], [right]) => compareUtf8(left, right))),
    'baseline getSettings baby-info mutations changed')
    assertStringSetEquals(babyInfo.pendingKeys, expectedPending, 'baseline getSettings pending baby-info keys')
    const actualAcknowledged = new Set([...actualMutations.keys()].filter(key => !expectedPending.has(key)))
    invariant(canonicalJson([...actualAcknowledged].sort(compareUtf8))
      === canonicalJson([...expectedAcknowledged].sort(compareUtf8)),
    'baseline getSettings acknowledged baby-info keys changed')
    return
  }

  invariant(babyInfo.kind === 'journal-ipc', 'candidate baby-info journal IPC projection is missing')
  invariant(babyInfo.hasLegacyBabyInfoSync === false, 'candidate getSettings still exposes legacy babyInfoSync')
  invariant(isPlainObject(babyInfo.settingsJournal)
    && babyInfo.settingsJournal.version === 1
    && babyInfo.settingsJournal.projectedFamilyId === projection.identity.familyId,
  'candidate getSettings journal metadata is invalid')
  invariant(isPlainObject(babyInfo.summary)
    && babyInfo.summary.familyId === projection.identity.familyId
    && babyInfo.summary.mutationCount === expectedMutations.size
    && babyInfo.summary.pendingCount === expectedPending.size
    && babyInfo.summary.totalPendingCount === expectedPending.size,
  'candidate baby-info summary does not expose the preserved pending/ack state')

  const pendingMutations = canonicalMutationMap(babyInfo.pendingItems, 'candidate pending IPC')
  assertStringSetEquals([...pendingMutations.keys()], expectedPending, 'candidate pending baby-info keys')
  for (const [key, canonical] of pendingMutations) {
    invariant(expectedMutations.get(key) === canonical, 'candidate pending baby-info mutation was substituted')
  }

  invariant(Array.isArray(babyInfo.mutationEntries), 'candidate mutation lookup IPC results are missing')
  const lookedUp = new Map()
  for (const entry of babyInfo.mutationEntries) {
    invariant(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string',
      'candidate mutation lookup IPC entry is invalid')
    invariant(!lookedUp.has(entry[0]), 'candidate mutation lookup IPC returned a duplicate key')
    invariant(entry[1] !== undefined && entry[1] !== null, 'candidate mutation lookup hid a preserved mutation')
    invariant(getBabyInfoMutationKey(entry[1]) === entry[0], 'candidate mutation lookup returned a mismatched key')
    lookedUp.set(entry[0], canonicalJson(entry[1]))
  }
  invariant(canonicalJson([...lookedUp.keys()].sort(compareUtf8))
    === canonicalJson([...expectedMutations.keys()].sort(compareUtf8)),
  'candidate mutation lookup did not expose every pending and acknowledged mutation')
  for (const [key, canonical] of lookedUp) {
    invariant(expectedMutations.get(key) === canonical, 'candidate mutation lookup substituted a preserved mutation')
  }
  invariant([...expectedAcknowledged].every(key => lookedUp.has(key)),
    'candidate mutation lookup hid an acknowledged mutation')
}

function validatePhaseOptions(options) {
  invariant(UPGRADE_MODES.includes(options.mode), 'upgrade mode is invalid')
  invariant(SHA_PATTERN.test(options.sourceSha), 'source SHA must be exactly 40 lowercase hexadecimal characters')
  invariant(typeof options.expectedVersion === 'string' && /^\d+\.\d+\.\d+$/.test(options.expectedVersion),
    'expected version is invalid')
  invariant(typeof options.expectedArch === 'string' && options.expectedArch.length > 0, 'expected architecture is required')
  if (options.mode === 'baseline-initialize') {
    invariant(options.sourceSha === V038_SOURCE.commit, 'baseline source SHA is not the immutable v0.3.8 commit')
  } else {
    invariant(typeof options.comparisonProjectionPath === 'string', 'candidate phase requires a comparison projection')
  }
}

/** Execute exactly one closed packaged-app phase and write a redacted diagnostic. */
export async function runUpgradePhase(options, dependencies = {}) {
  validatePhaseOptions(options)
  const expectedProfile = canonicalProfileForPlatform(options.platform, options.env)
  invariant(normalizeForComparison(expectedProfile) === normalizeForComparison(options.profileRoot),
    'profile root is not the canonical OS baby-diary path')
  const owned = await validateNonceOwnedPaths({
    tempRoot: options.tempRoot,
    profileRoot: options.profileRoot,
    outputPaths: [
      options.diagnosticPath,
      options.projectionOutputPath,
      options.comparisonProjectionPath,
    ],
    runId: options.runId,
    forbiddenRoots: options.forbiddenRoots ?? [],
  })
  const executablePath = path.resolve(options.executablePath)
  const executableStats = await lstat(executablePath)
  invariant(executableStats.isFile() && !executableStats.isSymbolicLink(), 'upgrade executable must be a regular file')
  invariant(normalizeForComparison(await realpath(executablePath)) === normalizeForComparison(executablePath),
    'upgrade executable resolves through a link/reparse point')

  const hash = dependencies.hashExecutable ?? hashExecutable
  const runSession = dependencies.runPackagedSession ?? defaultRunPackagedSession
  const project = dependencies.projectUpgradeSemantics ?? projectUpgradeSemantics
  const validateFixture = dependencies.validateV038Fixture ?? validateV038Fixture
  const comparisonProjection = options.mode === 'baseline-initialize'
    ? undefined
    : await readJson(path.resolve(options.comparisonProjectionPath))
  const expectedBabyInfoKeys = comparisonProjection?.babyInfo?.mutations?.map(item => item.key)
  invariant(options.mode === 'baseline-initialize'
    || (Array.isArray(expectedBabyInfoKeys) && expectedBabyInfoKeys.every(key => typeof key === 'string')),
  'candidate comparison projection has invalid baby-info mutation keys')
  let diagnostic = {
    sourceSha: options.sourceSha,
    executableSha256: null,
    appVersion: null,
    hostArchitecture: null,
    canonicalUserDataPath: owned.profileRoot,
    fixtureProjectionHash: null,
    phase: options.mode,
    passed: false,
  }
  try {
    diagnostic.executableSha256 = await hash(executablePath)
    const runtime = await runSession({
      mode: options.mode,
      executablePath,
      profileRoot: owned.profileRoot,
      tempRoot: owned.tempRoot,
      env: options.env,
      expectedBabyInfoKeys: expectedBabyInfoKeys ?? [],
      timeouts: options.timeouts ?? DEFAULT_PHASE_TIMEOUTS,
    })
    invariant(runtime.appVersion === options.expectedVersion,
      `packaged version mismatch: expected ${options.expectedVersion}`)
    invariant(runtime.hostArchitecture === options.expectedArch,
      `packaged architecture mismatch: expected ${options.expectedArch}`)
    invariant(normalizeForComparison(runtime.canonicalUserDataPath) === normalizeForComparison(owned.profileRoot),
      'runtime user-data path does not match the wrapper-owned canonical path')

    if (options.mode === 'baseline-initialize') {
      await materializeV038AuxiliaryFixture(owned.profileRoot)
    }

    const projection = options.mode === 'baseline-initialize'
      ? await validateFixture(owned.profileRoot)
      : await project(owned.profileRoot)
    assertRuntimeDiscoverability(projection, runtime.publicView, options.mode)
    if (options.mode === 'candidate-first-run') {
      assertSemanticPreservation(comparisonProjection, projection)
    } else if (options.mode === 'candidate-second-run') {
      assertSemanticIdempotence(comparisonProjection, projection)
    }
    await writeJsonAtomic(path.resolve(options.projectionOutputPath), projection)
    diagnostic = {
      ...diagnostic,
      appVersion: runtime.appVersion,
      hostArchitecture: runtime.hostArchitecture,
      canonicalUserDataPath: path.resolve(runtime.canonicalUserDataPath),
      fixtureProjectionHash: semanticProjectionHash(projection),
      passed: true,
    }
    const sanitized = sanitizeUpgradeDiagnostic(diagnostic)
    await writeJsonAtomic(path.resolve(options.diagnosticPath), sanitized)
    return sanitized
  } catch (error) {
    const sanitized = sanitizeUpgradeDiagnostic({
      ...diagnostic,
      failureCode: error instanceof Error ? error.name : 'UnknownFailure',
      passed: false,
    })
    await writeJsonAtomic(path.resolve(options.diagnosticPath), sanitized)
    throw error
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH
if (isDirectRun) {
  let diagnosticPath
  try {
    const options = parseUpgradeCli(process.argv.slice(2))
    diagnosticPath = options.diagnosticPath
    const result = await runUpgradePhase(options)
    console.log(JSON.stringify({ phase: result.phase, passed: result.passed, diagnosticPath }))
  } catch (error) {
    const failureName = error instanceof Error ? error.name : 'UnknownFailure'
    console.error(`[upgrade-e2e] FAIL ${failureName}${diagnosticPath ? `; diagnostic=${diagnosticPath}` : ''}`)
    process.exitCode = 1
  }
}
