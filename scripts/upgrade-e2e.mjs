/** Shared packaged-application driver for the v0.3.8 -> v0.3.9 upgrade gate. */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
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
  writeV038FirebaseBootstrap,
} from './upgrade-data-contract.mjs'
import {
  V038_DEFAULT_FIREBASE_EVIDENCE,
  assertUpgradeContinuity,
  buildFailClosedChromiumArgs,
  buildUpgradeTransportPolicy,
  installCdpUpgradeNetworkGuard,
  readUpgradeEmulatorEvidence,
  snapshotUpgradeContinuity,
  startUpgradeDenyProxy,
  validateUpgradeEmulatorEnvironment,
} from './upgrade-firebase-continuity.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = path.dirname(path.dirname(SCRIPT_PATH))
const RUN_ID_PATTERN = /^[0-9a-f]{32}$/
const SHA_PATTERN = /^[0-9a-f]{40}$/

export const V038_USERDATA_OVERRIDE_EVIDENCE = Object.freeze({
  sourceSha: V038_SOURCE.commit,
  sourcePath: 'electron/main.ts',
  blobSha1: '5c578300008b8a005fcc72110d9817feca3d626e',
  byteLength: 10125,
  bytesSha256: 'da05cc989892d0d575be601be6c8e4ca7b456074ee40d5d18545f182987fd7d1',
  environmentVariable: 'BABYDIARY_TEST_USERDATA',
})

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

const PHASE_ENV_FIELDS = Object.freeze({
  BABYDIARY_UPGRADE_PHASE_MODE: 'mode',
  BABYDIARY_UPGRADE_PHASE_EXECUTABLE: 'executablePath',
  BABYDIARY_UPGRADE_PHASE_PROFILE_ROOT: 'profileRoot',
  BABYDIARY_UPGRADE_PHASE_TEMP_ROOT: 'tempRoot',
  BABYDIARY_UPGRADE_PHASE_RUN_ID: 'runId',
  BABYDIARY_UPGRADE_PHASE_DIAGNOSTIC: 'diagnosticPath',
  BABYDIARY_UPGRADE_PHASE_PROJECTION_OUTPUT: 'projectionOutputPath',
  BABYDIARY_UPGRADE_PHASE_COMPARISON_PROJECTION: 'comparisonProjectionPath',
  BABYDIARY_UPGRADE_PHASE_SOURCE_SHA: 'sourceSha',
  BABYDIARY_UPGRADE_PHASE_EXPECTED_VERSION: 'expectedVersion',
  BABYDIARY_UPGRADE_PHASE_EXPECTED_ARCH: 'expectedArch',
  BABYDIARY_UPGRADE_PHASE_FORBIDDEN_ROOT: 'forbiddenRoot',
})

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
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

export function parseUpgradeCli(args, env = process.env, platform = process.platform) {
  invariant(Array.isArray(args), 'upgrade arguments must be an array')
  const parsed = {}
  if (args[0] === 'phase-env') {
    invariant(args.length === 1, 'phase-env must be the exact and only upgrade argument')
    for (const [environmentName, field] of Object.entries(PHASE_ENV_FIELDS)) {
      const value = env[environmentName]
      if (typeof value === 'string' && value.length > 0) parsed[field] = value
    }
  } else {
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
    platform,
    env,
  }
}

/** Resolve only the real interactive profile. This path is never selected for a harness launch. */
export function resolveInteractiveProfileForPlatform(platform, env) {
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

async function lstatOrNull(target, options) {
  try {
    return await lstat(target, options)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
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
      if (normalizeForComparison(await realpath(current)) !== normalizeForComparison(current)) {
        throw new Error(`${label} crosses a link/reparse point`)
      }
      if (!stats.isDirectory() && normalizeForComparison(current) !== normalizeForComparison(target)) {
        throw new Error(`${label} crosses a non-directory path component`)
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

async function assertAbsolutePathComponentsAreUnlinked(target, label) {
  const absolute = path.resolve(target)
  await assertExistingComponentsAreUnlinked(path.parse(absolute).root, absolute, label)
  return absolute
}

function assertProfilesDoNotOverlap(nonceProfileRoot, interactiveProfileRoot, label = 'profile') {
  const nonce = path.resolve(nonceProfileRoot)
  const interactive = path.resolve(interactiveProfileRoot)
  invariant(!isEqualOrDescendant(nonce, interactive) && !isEqualOrDescendant(interactive, nonce),
    `${label} roots are equal or contain one another`)
}

export function assertDistinctProfileIdentities({
  nonceProfileRoot,
  interactiveProfileRoot,
  nonceIdentity,
  interactiveIdentity,
}) {
  if (!nonceIdentity || !interactiveIdentity) return true
  const sameDevice = String(nonceIdentity.dev) === String(interactiveIdentity.dev)
  const sameInode = String(nonceIdentity.ino) === String(interactiveIdentity.ino)
  invariant(!(sameDevice && sameInode),
    `nonce and interactive profiles have the same inode identity: ${path.basename(nonceProfileRoot)} / ${path.basename(interactiveProfileRoot)}`)
  return true
}

/** Validate only run-owned paths; it never creates or removes them. */
export async function validateNonceOwnedPaths({
  tempRoot,
  profileRoot,
  interactiveProfileRoot,
  outputPaths = [],
  runId,
  forbiddenRoots = [],
}) {
  invariant(RUN_ID_PATTERN.test(runId), 'upgrade run id must be a lowercase 32-hex nonce')
  const canonicalTemp = path.resolve(tempRoot)
  const canonicalProfile = path.resolve(profileRoot)
  invariant(typeof interactiveProfileRoot === 'string' && interactiveProfileRoot.length > 0,
    'interactive profile root is required')
  const canonicalInteractive = path.resolve(interactiveProfileRoot)
  invariant(path.basename(canonicalTemp) === `baby-diary-upgrade-${runId}`,
    'upgrade temp root is not exactly bound to the run nonce')
  const tempStats = await lstat(canonicalTemp)
  invariant(tempStats.isDirectory() && !tempStats.isSymbolicLink(), 'upgrade temp root must be a regular directory')
  invariant(normalizeForComparison(await realpath(canonicalTemp)) === normalizeForComparison(canonicalTemp),
    'upgrade temp root resolves through a link/reparse point')
  invariant(canonicalProfile !== canonicalTemp, 'profile root must not equal the temp root')
  invariant(isStrictDescendant(canonicalTemp, canonicalProfile), 'profile root is outside the nonce-owned temp root')
  invariant(normalizeForComparison(canonicalProfile)
    === normalizeForComparison(path.join(canonicalTemp, 'user-data', 'baby-diary')),
  'profile root is not the exact nonce-owned userData path')
  assertProfilesDoNotOverlap(canonicalProfile, canonicalInteractive, 'nonce and interactive profile')
  for (const forbidden of forbiddenRoots) {
    if (typeof forbidden !== 'string' || forbidden.length === 0) continue
    assertProfilesDoNotOverlap(canonicalProfile, path.resolve(forbidden), 'nonce and real/forbidden profile')
  }
  await assertExistingComponentsAreUnlinked(canonicalTemp, canonicalProfile, 'profile root')
  await assertAbsolutePathComponentsAreUnlinked(canonicalInteractive, 'interactive profile root')
  const [nonceStats, interactiveStats] = await Promise.all([
    lstatOrNull(canonicalProfile),
    lstatOrNull(canonicalInteractive),
  ])
  assertDistinctProfileIdentities({
    nonceProfileRoot: canonicalProfile,
    interactiveProfileRoot: canonicalInteractive,
    nonceIdentity: nonceStats,
    interactiveIdentity: interactiveStats,
  })

  const canonicalOutputs = []
  for (const output of outputPaths.filter(Boolean)) {
    const canonicalOutput = path.resolve(output)
    invariant(isStrictDescendant(canonicalTemp, canonicalOutput), 'upgrade output path is outside the nonce-owned temp root')
    await assertExistingComponentsAreUnlinked(canonicalTemp, canonicalOutput, 'upgrade output path')
    canonicalOutputs.push(canonicalOutput)
  }
  return {
    tempRoot: canonicalTemp,
    profileRoot: canonicalProfile,
    interactiveProfileRoot: canonicalInteractive,
    outputPaths: canonicalOutputs,
  }
}

export function buildPackagedLaunchEnvironment(sourceEnv = process.env, { profileRoot, runId } = {}) {
  invariant(typeof profileRoot === 'string' && profileRoot.length > 0,
    'packaged launch profile root is required')
  invariant(RUN_ID_PATTERN.test(runId), 'packaged launch run id must be a lowercase 32-hex nonce')
  const safe = {}
  const forbiddenName = /(?:BABYDIARY_TEST_USERDATA|BABYDIARY_UPGRADE_|PASSWORD|PASSWD|TOKEN|SECRET|API[_-]?KEY|FIREBASE)/i
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined || forbiddenName.test(key)) continue
    safe[key] = value
  }
  return {
    ...safe,
    NODE_ENV: 'production',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    BABYDIARY_TEST_USERDATA: path.resolve(profileRoot),
    BABYDIARY_UPGRADE_ATTEST_RUN_ID: runId,
  }
}

export async function validateV038UserDataOverrideContract({ repositoryRoot = ROOT } = {}) {
  const cwd = path.resolve(repositoryRoot)
  const resolvedCommit = execFileSync('git', [
    'rev-parse', `${V038_USERDATA_OVERRIDE_EVIDENCE.sourceSha}^{commit}`,
  ], { cwd, encoding: 'utf8' }).trim()
  invariant(resolvedCommit === V038_USERDATA_OVERRIDE_EVIDENCE.sourceSha,
    'v0.3.8 userData override source commit changed')
  const blobSha1 = execFileSync('git', [
    'rev-parse', `${V038_USERDATA_OVERRIDE_EVIDENCE.sourceSha}:${V038_USERDATA_OVERRIDE_EVIDENCE.sourcePath}`,
  ], { cwd, encoding: 'utf8' }).trim()
  invariant(blobSha1 === V038_USERDATA_OVERRIDE_EVIDENCE.blobSha1,
    'v0.3.8 userData override source blob changed')
  const sourceBytes = execFileSync('git', ['cat-file', 'blob', blobSha1], {
    cwd,
    encoding: 'buffer',
    maxBuffer: 1024 * 1024,
  })
  invariant(sourceBytes.byteLength === V038_USERDATA_OVERRIDE_EVIDENCE.byteLength,
    'v0.3.8 userData override source byte length changed')
  invariant(sha256(sourceBytes) === V038_USERDATA_OVERRIDE_EVIDENCE.bytesSha256,
    'v0.3.8 userData override source hash changed')
  const source = sourceBytes.toString('utf8')
  invariant(/if\s*\(process\.env\.BABYDIARY_TEST_USERDATA\)\s*\{\s*app\.setPath\(\s*['"]userData['"]\s*,\s*process\.env\.BABYDIARY_TEST_USERDATA\s*\)/m.test(source),
    'v0.3.8 source does not implement the environment userData override')
  invariant(source.includes("app.setPath('userData', path.join(app.getPath('appData'), 'baby-diary'))"),
    'v0.3.8 source default userData branch changed')
  invariant(/if\s*\(!process\.env\.BABYDIARY_TEST_USERDATA\)\s*\{[\s\S]*?requestSingleInstanceLock\(\)/m.test(source),
    'v0.3.8 source does not isolate the override from the interactive single-instance lock')
  return V038_USERDATA_OVERRIDE_EVIDENCE
}

function bigintStatValue(stats, name, millisecondName) {
  if (typeof stats[name] === 'bigint') return stats[name].toString()
  return BigInt(Math.trunc(Number(stats[millisecondName]) * 1_000_000)).toString()
}

async function hashFingerprintFile(filePath, before) {
  const hash = createHash('sha256')
  let bytes = 0
  await new Promise((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath)
    stream.on('data', chunk => {
      bytes += chunk.byteLength
      hash.update(chunk)
    })
    stream.once('error', rejectPromise)
    stream.once('end', resolvePromise)
  })
  const after = await lstat(filePath, { bigint: true })
  invariant(after.isFile() && !after.isSymbolicLink(),
    'interactive profile file changed type while fingerprinting')
  invariant(String(before.dev) === String(after.dev)
    && String(before.ino) === String(after.ino)
    && String(before.size) === String(after.size)
    && bigintStatValue(before, 'mtimeNs', 'mtimeMs') === bigintStatValue(after, 'mtimeNs', 'mtimeMs')
    && BigInt(bytes) === after.size,
  'interactive profile file changed while fingerprinting')
  return hash.digest('hex')
}

function fingerprintMetadata(type, relativePath, stats, contentSha256) {
  return {
    type,
    relativePath,
    mode: String(stats.mode),
    size: String(stats.size),
    mtimeNs: bigintStatValue(stats, 'mtimeNs', 'mtimeMs'),
    ...(contentSha256 ? { contentSha256 } : {}),
  }
}

/** Read-only, value-free fingerprint of the real interactive profile. */
export async function fingerprintProfileTree(profileRoot) {
  invariant(typeof profileRoot === 'string' && profileRoot.length > 0,
    'interactive profile root is required for fingerprinting')
  const canonicalProfile = await assertAbsolutePathComponentsAreUnlinked(
    profileRoot,
    'interactive profile fingerprint root',
  )
  const pathSha256 = sha256(Buffer.from(normalizeForComparison(canonicalProfile), 'utf8'))
  const rootStats = await lstatOrNull(canonicalProfile, { bigint: true })
  if (!rootStats) {
    return {
      version: 1,
      exists: false,
      profilePathSha256: pathSha256,
      rootIdentitySha256: null,
      entryCount: 0,
      fileCount: 0,
      directoryCount: 0,
      totalBytes: 0,
      treeSha256: sha256(`absent\0${pathSha256}`),
    }
  }
  invariant(rootStats.isDirectory() && !rootStats.isSymbolicLink(),
    'interactive profile root must be an unlinked directory')
  invariant(normalizeForComparison(await realpath(canonicalProfile)) === normalizeForComparison(canonicalProfile),
    'interactive profile root resolves through a link/reparse point')

  const records = [fingerprintMetadata('directory', '.', rootStats)]
  let fileCount = 0
  let directoryCount = 1
  let totalBytes = 0
  const walk = async (directory, relativeDirectory) => {
    const names = (await readdir(directory)).sort(compareUtf8)
    for (const name of names) {
      const child = path.join(directory, name)
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name
      const stats = await lstat(child, { bigint: true })
      invariant(!stats.isSymbolicLink(), 'interactive profile tree contains a link/reparse point')
      invariant(normalizeForComparison(await realpath(child)) === normalizeForComparison(child),
        'interactive profile tree contains a link/reparse point')
      if (stats.isDirectory()) {
        directoryCount += 1
        records.push(fingerprintMetadata('directory', relative, stats))
        await walk(child, relative)
      } else if (stats.isFile()) {
        const contentSha256 = await hashFingerprintFile(child, stats)
        const size = Number(stats.size)
        invariant(Number.isSafeInteger(size) && Number.isSafeInteger(totalBytes + size),
          'interactive profile byte count exceeds the safe evidence bound')
        totalBytes += size
        fileCount += 1
        records.push(fingerprintMetadata('file', relative, stats, contentSha256))
      } else {
        throw new Error('interactive profile tree contains a non-file/non-directory entry')
      }
    }
  }
  await walk(canonicalProfile, '')
  return {
    version: 1,
    exists: true,
    profilePathSha256: pathSha256,
    rootIdentitySha256: sha256(`${rootStats.dev}:${rootStats.ino}`),
    entryCount: records.length,
    fileCount,
    directoryCount,
    totalBytes,
    treeSha256: sha256(canonicalJson(records)),
  }
}

function assertFingerprintShape(fingerprint, label) {
  invariant(isPlainObject(fingerprint) && fingerprint.version === 1,
    `${label} fingerprint schema is invalid`)
  invariant(typeof fingerprint.exists === 'boolean', `${label} fingerprint existence is invalid`)
  for (const field of ['profilePathSha256', 'treeSha256']) assertHash(fingerprint[field], `${label} ${field}`)
  invariant(fingerprint.rootIdentitySha256 === null
    || (typeof fingerprint.rootIdentitySha256 === 'string' && /^[0-9a-f]{64}$/.test(fingerprint.rootIdentitySha256)),
  `${label} root identity digest is invalid`)
  for (const field of ['entryCount', 'fileCount', 'directoryCount', 'totalBytes']) {
    invariant(Number.isSafeInteger(fingerprint[field]) && fingerprint[field] >= 0,
      `${label} fingerprint ${field} is invalid`)
  }
}

export function assertProfileFingerprintUnchanged(before, after) {
  assertFingerprintShape(before, 'before')
  assertFingerprintShape(after, 'after')
  invariant(canonicalJson(before) === canonicalJson(after),
    'interactive profile changed; non-interference contract failed')
  return true
}

async function validateFingerprintRunRoot(tempRoot, runId, mustExist) {
  invariant(RUN_ID_PATTERN.test(runId), 'profile fingerprint run id must be a lowercase 32-hex nonce')
  const canonicalTemp = path.resolve(tempRoot)
  invariant(path.basename(canonicalTemp) === `baby-diary-upgrade-${runId}`,
    'profile fingerprint temp root is not exactly nonce-bound')
  const parent = path.dirname(canonicalTemp)
  await assertAbsolutePathComponentsAreUnlinked(parent, 'profile fingerprint temp parent')
  const parentStats = await lstat(parent)
  invariant(parentStats.isDirectory() && !parentStats.isSymbolicLink(),
    'profile fingerprint temp parent must be an unlinked directory')
  invariant(normalizeForComparison(await realpath(parent)) === normalizeForComparison(parent),
    'profile fingerprint temp parent resolves through a link/reparse point')
  const tempStats = await lstatOrNull(canonicalTemp)
  if (mustExist) {
    invariant(tempStats?.isDirectory() && !tempStats.isSymbolicLink(),
      'profile fingerprint temp root is missing or linked')
    invariant(normalizeForComparison(await realpath(canonicalTemp)) === normalizeForComparison(canonicalTemp),
      'profile fingerprint temp root resolves through a link/reparse point')
  } else {
    invariant(!tempStats, 'profile fingerprint temp root already exists')
  }
  return canonicalTemp
}

function validateFingerprintArtifactPath(tempRoot, outputPath, expectedName) {
  const output = path.resolve(outputPath)
  invariant(path.dirname(output) === path.resolve(tempRoot) && path.basename(output) === expectedName,
    `profile fingerprint output must be exactly ${expectedName} inside the nonce root`)
  return output
}

export async function captureProfileFingerprintArtifact({
  interactiveProfileRoot,
  tempRoot,
  runId,
  outputPath = path.join(tempRoot, 'interactive-profile-before.json'),
}) {
  const canonicalInteractive = path.resolve(interactiveProfileRoot)
  const canonicalTemp = path.resolve(tempRoot)
  assertProfilesDoNotOverlap(
    path.join(canonicalTemp, 'user-data', 'baby-diary'),
    canonicalInteractive,
    'planned nonce and interactive profile',
  )
  const fingerprint = await fingerprintProfileTree(canonicalInteractive)
  await validateFingerprintRunRoot(canonicalTemp, runId, false)
  const canonicalOutput = validateFingerprintArtifactPath(
    canonicalTemp,
    outputPath,
    'interactive-profile-before.json',
  )
  await mkdir(canonicalTemp, { recursive: false, mode: 0o700 })
  const artifact = { version: 1, stage: 'before', runId, fingerprint }
  await writeJsonAtomic(canonicalOutput, artifact)
  return artifact
}

export async function verifyProfileNonInterferenceArtifact({
  interactiveProfileRoot,
  tempRoot,
  runId,
  beforePath = path.join(tempRoot, 'interactive-profile-before.json'),
  outputPath = path.join(tempRoot, 'interactive-profile-after.json'),
}) {
  const canonicalTemp = await validateFingerprintRunRoot(tempRoot, runId, true)
  const canonicalBefore = validateFingerprintArtifactPath(
    canonicalTemp,
    beforePath,
    'interactive-profile-before.json',
  )
  const canonicalOutput = validateFingerprintArtifactPath(
    canonicalTemp,
    outputPath,
    'interactive-profile-after.json',
  )
  await assertExistingComponentsAreUnlinked(canonicalTemp, canonicalBefore, 'profile fingerprint before artifact')
  await assertExistingComponentsAreUnlinked(canonicalTemp, canonicalOutput, 'profile fingerprint after artifact')
  const beforeArtifact = await readEvidenceJson(canonicalBefore, 'interactive profile before fingerprint')
  invariant(beforeArtifact.version === 1 && beforeArtifact.stage === 'before'
    && beforeArtifact.runId === runId,
  'interactive profile before fingerprint is not bound to this run')
  assertFingerprintShape(beforeArtifact.fingerprint, 'before')
  const fingerprint = await fingerprintProfileTree(interactiveProfileRoot)
  let unchanged = true
  try {
    assertProfileFingerprintUnchanged(beforeArtifact.fingerprint, fingerprint)
  } catch {
    unchanged = false
  }
  const artifact = { version: 1, stage: 'after', runId, unchanged, fingerprint }
  await writeJsonAtomic(canonicalOutput, artifact)
  invariant(unchanged, 'interactive profile changed; non-interference contract failed')
  return artifact
}

export function validateMainProcessAttestation(attestation, {
  profileRoot,
  runId,
  expectedVersion,
  expectedArch,
}) {
  invariant(isPlainObject(attestation), 'main-process attestation is missing')
  invariant(attestation.beforeUi === true, 'main-process attestation was not captured before UI access')
  invariant(attestation.runId === runId, 'process-reported run-id does not match the wrapper run-id')
  invariant(typeof attestation.userDataPath === 'string'
    && normalizeForComparison(attestation.userDataPath) === normalizeForComparison(profileRoot),
  'process-reported userData path does not match the nonce-owned profile')
  invariant(attestation.appVersion === expectedVersion,
    `process-reported app version mismatch: expected ${expectedVersion}`)
  invariant(attestation.hostArchitecture === expectedArch,
    `process-reported architecture mismatch: expected ${expectedArch}`)
  return {
    runId: attestation.runId,
    userDataPath: path.resolve(attestation.userDataPath),
    appVersion: attestation.appVersion,
    hostArchitecture: attestation.hostArchitecture,
    beforeUi: true,
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
  const networkFields = [
    'rewrittenAuth',
    'rewrittenPasswordPolicy',
    'rewrittenSecureToken',
    'rewrittenFirestore',
    'allowedAuthLoopback',
    'allowedFirestoreLoopback',
    'allowedLocalResources',
    'expectedOfflineBlocks',
    'externalBlocks',
  ]
  const blockHosts = new Set([
    'invalid', 'identity-toolkit', 'secure-token', 'firestore',
    'loopback-auth', 'loopback-firestore', 'loopback-other', 'other',
  ])
  const blockReasons = new Set([
    'invalid-url', 'forbidden-url-components', 'identity-request-shape',
    'secure-token-request-shape', 'firestore-request-shape',
    'loopback-request-shape', 'file-path', 'external-origin',
  ])
  const sanitizeBlockShape = shape => {
    if (!isPlainObject(shape)) return undefined
    invariant(blockHosts.has(shape.host), 'blocked request host enum is invalid')
    invariant(shape.pathname === '<redacted>'
      || (typeof shape.pathname === 'string'
        && /^\/[A-Za-z0-9._:()/-]{1,180}$/.test(shape.pathname)),
    'blocked request pathname is invalid')
    invariant(typeof shape.method === 'string' && /^(?:[A-Z]{1,16}|UNKNOWN)$/.test(shape.method),
      'blocked request method is invalid')
    invariant(Array.isArray(shape.queryParameterNames)
      && shape.queryParameterNames.length <= 16
      && shape.queryParameterNames.every(name => (
        name === '<other>' || (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name))
      )),
    'blocked request query-name evidence is invalid')
    invariant(typeof shape.configuredDemoKeyEquality === 'boolean'
      && typeof shape.hasFragment === 'boolean'
      && typeof shape.hasUserInfo === 'boolean',
    'blocked request boolean evidence is invalid')
    invariant(shape.requestKeySha256 === null
      || (typeof shape.requestKeySha256 === 'string' && /^[0-9a-f]{64}$/.test(shape.requestKeySha256)),
    'blocked request key digest is invalid')
    invariant(blockReasons.has(shape.blockReason), 'blocked request reason enum is invalid')
    return {
      host: shape.host,
      pathname: shape.pathname,
      method: shape.method,
      queryParameterNames: [...shape.queryParameterNames],
      configuredDemoKeyEquality: shape.configuredDemoKeyEquality,
      requestKeySha256: shape.requestKeySha256,
      hasFragment: shape.hasFragment,
      hasUserInfo: shape.hasUserInfo,
      blockReason: shape.blockReason,
    }
  }
  const sanitizeNetwork = evidence => {
    if (!isPlainObject(evidence)) return undefined
    const counts = Object.fromEntries(networkFields.map(field => {
      const count = evidence[field] ?? 0
      invariant(Number.isSafeInteger(count) && count >= 0, 'network evidence count is invalid')
      return [field, count]
    }))
    const firstExternalBlock = sanitizeBlockShape(evidence.firstExternalBlock)
    const runtimeRequestKeySha256 = evidence.runtimeRequestKeySha256
    invariant(runtimeRequestKeySha256 === undefined
      || (typeof runtimeRequestKeySha256 === 'string' && /^[0-9a-f]{64}$/.test(runtimeRequestKeySha256)),
    'runtime Firebase request-key digest is invalid')
    invariant(counts.externalBlocks === 0 || firstExternalBlock,
      'external network block is missing value-free request-shape evidence')
    return {
      ...counts,
      ...(firstExternalBlock ? { firstExternalBlock } : {}),
      ...(runtimeRequestKeySha256 ? { runtimeRequestKeySha256 } : {}),
    }
  }
  const sanitizeFirebaseSettingsEvidence = evidence => {
    if (!isPlainObject(evidence)) return undefined
    for (const field of ['settingsBytesSha256', 'configSha256', 'apiKeySha256']) {
      invariant(typeof evidence[field] === 'string' && /^[0-9a-f]{64}$/.test(evidence[field]),
        `Firebase settings evidence ${field} is invalid`)
    }
    invariant(typeof evidence.configMatchesExactTag === 'boolean',
      'Firebase settings exact-tag evidence is invalid')
    return {
      settingsBytesSha256: evidence.settingsBytesSha256,
      configSha256: evidence.configSha256,
      apiKeySha256: evidence.apiKeySha256,
      configMatchesExactTag: evidence.configMatchesExactTag,
    }
  }
  const sanitizeBaselineUserDataOverrideEvidence = evidence => {
    if (!isPlainObject(evidence)) return undefined
    invariant(canonicalJson(evidence) === canonicalJson(V038_USERDATA_OVERRIDE_EVIDENCE),
      'baseline userData override evidence is not the exact v0.3.8 source contract')
    return { ...V038_USERDATA_OVERRIDE_EVIDENCE }
  }
  const networkEvidence = sanitizeNetwork(value.networkEvidence)
  const secondDeviceNetworkEvidence = sanitizeNetwork(value.secondDeviceNetworkEvidence)
  const firebaseSettingsEvidence = sanitizeFirebaseSettingsEvidence(value.firebaseSettingsEvidence)
  const baselineUserDataOverrideEvidence = sanitizeBaselineUserDataOverrideEvidence(
    value.baselineUserDataOverrideEvidence,
  )
  const uiStateFields = [
    'familyChoiceVisible',
    'createSubmitVisible',
    'createSubmitDisabled',
    'errorClassPresent',
    'inviteVisible',
    'captureFailed',
  ]
  const failureUiState = isPlainObject(value.failureUiState)
    ? Object.fromEntries(uiStateFields
        .filter(field => typeof value.failureUiState[field] === 'boolean')
        .map(field => [field, value.failureUiState[field]]))
    : undefined
  return {
    schemaVersion: 2,
    runId: value.runId ?? null,
    sourceSha: value.sourceSha ?? null,
    executableSha256: value.executableSha256 ?? null,
    executableSize: Number.isSafeInteger(value.executableSize) ? value.executableSize : null,
    appVersion: value.appVersion ?? null,
    hostArchitecture: value.hostArchitecture ?? null,
    canonicalUserDataPath: value.canonicalUserDataPath ?? null,
    processReportedRunId: value.processReportedRunId ?? null,
    attestationBeforeUi: value.attestationBeforeUi === true,
    fixtureProjectionHash: value.fixtureProjectionHash ?? null,
    phase: value.phase ?? null,
    passed: value.passed === true,
    ...(firebaseSettingsEvidence ? { firebaseSettingsEvidence } : {}),
    ...(baselineUserDataOverrideEvidence ? { baselineUserDataOverrideEvidence } : {}),
    ...(networkEvidence ? { networkEvidence } : {}),
    ...(secondDeviceNetworkEvidence ? { secondDeviceNetworkEvidence } : {}),
    ...(failureUiState ? { failureUiState } : {}),
    ...(value.failureCode ? { failureCode: String(value.failureCode).slice(0, 80) } : {}),
    ...(value.failurePhase ? {
      failurePhase: String(value.failurePhase).replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 80),
    } : {}),
  }
}

/**
 * Converts the rich in-memory semantic view into equality-only evidence.
 * Raw account/family/event identifiers and canonical payloads stay inside the
 * closed phase process and are never written to the comparison artifact.
 */
export function redactUpgradeProjection(projection) {
  invariant(isPlainObject(projection) && projection.version === 1,
    'upgrade projection is invalid')
  if (projection.evidenceSchemaVersion === 2) {
    return JSON.parse(JSON.stringify(projection))
  }
  invariant(isPlainObject(projection.identity), 'upgrade projection identity is invalid')
  invariant(Array.isArray(projection.eventSources)
    && Array.isArray(projection.eventDerivatives)
    && Array.isArray(projection.eventWinners),
  'upgrade projection event evidence is invalid')
  invariant(isPlainObject(projection.babyInfo) && isPlainObject(projection.babyInfoJournal),
    'upgrade projection baby-info evidence is invalid')

  const redactJournal = journal => {
    if (journal.kind === 'legacy') {
      invariant(Array.isArray(journal.expectedRecords) && typeof journal.expectedImportSourceId === 'string',
        'legacy baby-info journal evidence is invalid')
      return {
        kind: 'legacy',
        expectedRecords: journal.expectedRecords.map(record => sha256(canonicalJson(record))),
        expectedImportSourceId: sha256(journal.expectedImportSourceId),
      }
    }
    invariant(journal.kind === 'journal'
      && Array.isArray(journal.records)
      && Array.isArray(journal.importSourceIds),
    'candidate baby-info journal evidence is invalid')
    return {
      kind: 'journal',
      records: journal.records.map(record => sha256(canonicalJson(record))),
      importSourceIds: journal.importSourceIds.map(sourceId => sha256(sourceId)),
    }
  }

  return {
    evidenceSchemaVersion: 2,
    version: 1,
    identity: { semanticSha256: sha256(canonicalJson(projection.identity)) },
    firebaseHash: projection.firebaseHash,
    settingsOpaqueHash: projection.settingsOpaqueHash,
    auxiliaryFiles: JSON.parse(JSON.stringify(projection.auxiliaryFiles)),
    eventSources: projection.eventSources.map(source => ({
      id: sha256(source.id),
      rev: source.rev,
      deleted: source.deleted,
      contentId: sha256(source.contentId),
      canonical: sha256(source.canonical),
    })),
    eventDerivatives: projection.eventDerivatives.map(derivative => ({
      mutationId: sha256(derivative.mutationId),
      sourceContentId: sha256(derivative.sourceContentId),
      canonicalHash: derivative.canonicalHash,
    })),
    eventWinners: projection.eventWinners.map(winner => ({
      id: sha256(winner.id),
      rev: winner.rev,
      deleted: winner.deleted,
      contentId: sha256(winner.contentId),
    })),
    babyInfo: {
      mutations: projection.babyInfo.mutations.map(mutation => ({
        key: mutation.key,
        canonical: sha256(mutation.canonical),
      })),
      pendingKeys: [...projection.babyInfo.pendingKeys],
      acknowledgedKeys: [...projection.babyInfo.acknowledgedKeys],
    },
    babyInfoJournal: redactJournal(projection.babyInfoJournal),
    ...(projection.authSync ? { authSync: JSON.parse(JSON.stringify(projection.authSync)) } : {}),
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

async function readFirebaseSettingsEvidence(profileRoot) {
  const settingsPath = path.join(profileRoot, 'settings.json')
  const bytes = await readFile(settingsPath)
  let settings
  try {
    settings = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('pre-launch Firebase settings are not valid JSON')
  }
  invariant(isPlainObject(settings?.firebase) && typeof settings.firebase.apiKey === 'string',
    'pre-launch Firebase settings config is missing')
  const configSha256 = sha256(canonicalJson(settings.firebase))
  const apiKeySha256 = sha256(settings.firebase.apiKey)
  return {
    settingsBytesSha256: sha256(bytes),
    configSha256,
    apiKeySha256,
    configMatchesExactTag: configSha256 === V038_DEFAULT_FIREBASE_EVIDENCE.configSha256
      && apiKeySha256 === V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256,
  }
}

async function readEvidenceJson(filePath, label) {
  const absolute = path.resolve(filePath)
  const stats = await lstat(absolute)
  invariant(stats.isFile() && !stats.isSymbolicLink(), `${label} must be a regular file`)
  invariant(stats.size > 0 && stats.size <= 16 * 1024 * 1024, `${label} is empty or exceeds its size bound`)
  invariant(normalizeForComparison(await realpath(absolute)) === normalizeForComparison(absolute),
    `${label} resolves through a link/reparse point`)
  let parsed
  try {
    parsed = JSON.parse(await readFile(absolute, 'utf8'))
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
  invariant(isPlainObject(parsed), `${label} root must be an object`)
  return parsed
}

function assertHash(value, label) {
  invariant(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), `${label} must be SHA-256`)
}

function assertNetworkEvidence(evidence, mode, label = 'network evidence') {
  invariant(isPlainObject(evidence), `${label} is missing`)
  for (const [key, count] of Object.entries(evidence)) {
    if (key === 'firstExternalBlock' || key === 'runtimeRequestKeySha256') continue
    invariant(Number.isSafeInteger(count) && count >= 0, `${label} ${key} count is invalid`)
  }
  invariant(evidence.externalBlocks === 0, `${label} contains external network blocks`)
  invariant(evidence.rewrittenFirestore > 0, `${label} has no Firestore rewrite proof`)
  if (mode === 'baseline-initialize') {
    invariant(evidence.rewrittenAuth > 0, `${label} has no Auth rewrite proof`)
    invariant(evidence.rewrittenPasswordPolicy > 0,
      `${label} has no Auth password-policy rewrite proof`)
    invariant(evidence.expectedOfflineBlocks > 0, `${label} has no offline block proof`)
  }
}

/** Rejects a successful child exit unless the exact phase actually produced complete evidence. */
export async function validateCompletedUpgradePhaseArtifacts({
  runId,
  mode,
  expectedVersion,
  expectedArch,
  sourceSha,
  diagnosticPath,
  projectionPath,
  profileRoot,
}) {
  invariant(RUN_ID_PATTERN.test(runId), 'artifact run id is invalid')
  invariant(UPGRADE_MODES.includes(mode), 'artifact phase is invalid')
  invariant(SHA_PATTERN.test(sourceSha), 'artifact source SHA is invalid')
  const canonicalProfile = path.resolve(profileRoot)
  const profileStats = await lstat(canonicalProfile)
  invariant(profileStats.isDirectory() && !profileStats.isSymbolicLink(),
    'phase profile is missing or linked')
  invariant(normalizeForComparison(await realpath(canonicalProfile)) === normalizeForComparison(canonicalProfile),
    'phase profile resolves through a link/reparse point')
  const settingsPath = path.join(canonicalProfile, 'settings.json')
  const dataPath = path.join(canonicalProfile, 'data')
  const [settingsStats, dataStats] = await Promise.all([lstat(settingsPath), lstat(dataPath)])
  invariant(settingsStats.isFile() && !settingsStats.isSymbolicLink(), 'phase settings artifact is missing')
  invariant(dataStats.isDirectory() && !dataStats.isSymbolicLink(), 'phase event data directory is missing')
  const eventFiles = (await readdir(dataPath)).filter(name => /^events-\d{1,4}-\d{2}\.jsonl$/.test(name))
  invariant(eventFiles.length > 0, 'phase event data artifact is empty')

  const [diagnostic, projection] = await Promise.all([
    readEvidenceJson(diagnosticPath, 'phase diagnostic'),
    readEvidenceJson(projectionPath, 'phase projection'),
  ])
  invariant(diagnostic.schemaVersion === 2, 'phase diagnostic schema is invalid')
  invariant(diagnostic.runId === runId, 'phase diagnostic run id does not match the wrapper run-id')
  invariant(diagnostic.phase === mode && diagnostic.passed === true,
    'phase diagnostic is not a successful matching phase')
  invariant(diagnostic.sourceSha === sourceSha, 'phase diagnostic source SHA changed')
  invariant(diagnostic.appVersion === expectedVersion, 'phase diagnostic app version changed')
  invariant(diagnostic.hostArchitecture === expectedArch, 'phase diagnostic architecture changed')
  invariant(diagnostic.processReportedRunId === runId,
    'phase diagnostic process-reported run-id changed')
  invariant(diagnostic.attestationBeforeUi === true,
    'phase diagnostic lacks pre-UI main-process attestation')
  invariant(normalizeForComparison(diagnostic.canonicalUserDataPath) === normalizeForComparison(canonicalProfile),
    'phase diagnostic profile path changed')
  if (mode === 'baseline-initialize') {
    invariant(canonicalJson(diagnostic.baselineUserDataOverrideEvidence)
      === canonicalJson(V038_USERDATA_OVERRIDE_EVIDENCE),
    'baseline diagnostic lacks the exact v0.3.8 userData override source evidence')
  }
  assertHash(diagnostic.executableSha256, 'phase executable digest')
  invariant(Number.isSafeInteger(diagnostic.executableSize) && diagnostic.executableSize > 0,
    'phase executable size is missing')
  assertHash(diagnostic.fixtureProjectionHash, 'phase fixture projection digest')
  invariant(isPlainObject(diagnostic.firebaseSettingsEvidence),
    'phase Firebase settings evidence is missing')
  assertHash(diagnostic.firebaseSettingsEvidence.settingsBytesSha256,
    'phase Firebase settings bytes digest')
  invariant(diagnostic.firebaseSettingsEvidence.configSha256 === V038_DEFAULT_FIREBASE_EVIDENCE.configSha256
    && diagnostic.firebaseSettingsEvidence.apiKeySha256 === V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256
    && diagnostic.firebaseSettingsEvidence.configMatchesExactTag === true,
  'phase Firebase settings are not the exact v0.3.8 default config')
  assertNetworkEvidence(diagnostic.networkEvidence, mode)
  invariant(diagnostic.networkEvidence.runtimeRequestKeySha256
    === diagnostic.firebaseSettingsEvidence.apiKeySha256,
  'phase runtime Firebase request key does not match persisted settings evidence')
  if (mode === 'candidate-first-run') {
    assertNetworkEvidence(diagnostic.secondDeviceNetworkEvidence, mode, 'second-device network evidence')
    invariant(diagnostic.secondDeviceNetworkEvidence.rewrittenAuth > 0,
      'second-device network evidence has no Auth rewrite proof')
  }

  invariant(projection.version === 1 && projection.evidenceSchemaVersion === 2,
    'phase projection evidence schema is invalid')
  invariant(isPlainObject(projection.identity), 'phase projection identity evidence is missing')
  assertHash(projection.identity.semanticSha256, 'phase identity digest')
  invariant(projection.firebaseHash === diagnostic.firebaseSettingsEvidence.configSha256,
    'phase projected Firebase config does not match pre-launch settings evidence')
  invariant(isPlainObject(projection.authSync) && projection.authSync.version === 2,
    'phase auth continuity evidence is missing')
  for (const [field, value] of Object.entries(projection.authSync)) {
    if (field.endsWith('Sha256')) assertHash(value, `phase auth ${field}`)
  }
  assertHash(projection.authSync.uidSha256, 'phase account uid digest')
  assertHash(projection.authSync.emailSha256, 'phase account email digest')
  assertHash(projection.authSync.familyIdSha256, 'phase family digest')
  invariant(!Object.hasOwn(projection.authSync, 'uid')
    && !Object.hasOwn(projection.authSync, 'email')
    && !Object.hasOwn(projection.authSync, 'familyId'),
  'phase auth projection persisted raw identity fields')
  return { runId, phase: mode, executableSha256: diagnostic.executableSha256 }
}

export async function validateBaselineManifestArtifact({ manifestPath }) {
  const manifest = await readEvidenceJson(manifestPath, 'baseline raw manifest')
  invariant(manifest.version === 1 && Array.isArray(manifest.entries) && manifest.entries.length > 0,
    'baseline raw manifest entries are empty or invalid')
  const paths = new Set(manifest.entries.map(entry => entry?.path))
  invariant(paths.has('settings.json') && [...paths].some(value => (
    typeof value === 'string' && /^data\/events-\d{1,4}-\d{2}\.jsonl$/.test(value)
  )), 'baseline raw manifest does not bind settings and event data')
  return { entryCount: manifest.entries.length }
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

function packagedResourceRoot(executablePath) {
  if (process.platform === 'win32') {
    return path.join(path.dirname(executablePath), 'resources', 'app.asar')
  }
  if (process.platform === 'darwin') {
    return path.join(path.dirname(path.dirname(executablePath)), 'Resources', 'app.asar')
  }
  return path.join(path.dirname(executablePath), 'resources', 'app.asar')
}

function installUpgradeAuthFormObserver() {
  if (window.__babyDiaryUpgradeAuthObserver) return
  const observe = () => {
    if (document.querySelector('[data-sync-auth-form]')) {
      window.__babyDiaryUpgradeAuthFormObserved = true
    }
  }
  window.__babyDiaryUpgradeAuthFormObserved = false
  observe()
  const observer = new MutationObserver(observe)
  observer.observe(document, { childList: true, subtree: true, attributes: true })
  window.__babyDiaryUpgradeAuthObserver = observer
}

export function mergeUpgradeNetworkEvidence(items) {
  invariant(Array.isArray(items), 'network evidence list is invalid')
  const total = {}
  for (const evidence of items) {
    invariant(isPlainObject(evidence), 'renderer network evidence is invalid')
    for (const [key, value] of Object.entries(evidence)) {
      if (key === 'firstExternalBlock') {
        if (total.firstExternalBlock === undefined) {
          invariant(isPlainObject(value), 'blocked request shape is invalid')
          total.firstExternalBlock = {
            ...value,
            queryParameterNames: [...(value.queryParameterNames ?? [])],
          }
        }
        continue
      }
      if (key === 'runtimeRequestKeySha256') {
        invariant(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
          'runtime Firebase request-key digest is invalid')
        invariant(total.runtimeRequestKeySha256 === undefined
          || total.runtimeRequestKeySha256 === value,
        'renderer Firebase request keys diverged')
        total.runtimeRequestKeySha256 = value
        continue
      }
      invariant(Number.isSafeInteger(value) && value >= 0,
        `renderer network counter is invalid: ${key}`)
      total[key] = (total[key] ?? 0) + value
    }
  }
  return total
}

async function installApplicationNetworkGuards(
  electronApp,
  allowedFileRoot,
  { observeAuthForms = false, transportPolicy = buildUpgradeTransportPolicy('demo') } = {},
) {
  const guards = new Map()
  const pending = new Set()
  const attachErrors = []
  let offline = false
  let unexpectedWorkerTargets = 0

  const attach = page => {
    if (!page || guards.has(page)) return Promise.resolve()
    const task = (async () => {
      try {
        const guard = await installCdpUpgradeNetworkGuard(page, {
          allowedFileRoot,
          ...transportPolicy,
        })
        if (observeAuthForms) {
          // Register for every future document and inspect the current one.
          // This runs during window attachment, before waiting for preload/UI.
          await page.addInitScript(installUpgradeAuthFormObserver)
          await page.evaluate(installUpgradeAuthFormObserver)
        }
        guard.setOffline(offline)
        guards.set(page, guard)
        page.on?.('worker', () => { unexpectedWorkerTargets += 1 })
      } catch (error) {
        attachErrors.push(error)
      }
    })()
    pending.add(task)
    void task.finally(() => pending.delete(task))
    return task
  }
  const onWindow = page => { void attach(page) }
  electronApp.on('window', onWindow)
  const context = electronApp.context()
  context.on?.('serviceworker', () => { unexpectedWorkerTargets += 1 })
  for (const page of context.pages()) await attach(page)

  return {
    async attach(page) { await attach(page) },
    setOffline(value) {
      invariant(typeof value === 'boolean', 'network offline state must be boolean')
      offline = value
      for (const guard of guards.values()) guard.setOffline(value)
    },
    async assertReady() {
      await Promise.all([...pending])
      invariant(attachErrors.length === 0, 'one or more renderer network guards failed to attach')
      const requestResults = await Promise.allSettled(
        [...guards.values()].map(guard => guard.assertReady()),
      )
      invariant(requestResults.every(item => item.status === 'fulfilled'),
        'one or more renderer network guards failed while handling a request')
      invariant(unexpectedWorkerTargets === 0,
        'an unguarded worker/service-worker target appeared during the packaged upgrade gate')
    },
    getEvidence() {
      return mergeUpgradeNetworkEvidence([...guards.values()].map(guard => guard.getEvidence()))
    },
    async close() {
      electronApp.off?.('window', onWindow)
      await Promise.all([...pending])
      const results = await Promise.allSettled([...guards.values()].map(guard => guard.close()))
      const failures = results.filter(item => item.status === 'rejected')
      if (failures.length > 0) throw new Error('one or more renderer network guards failed to detach')
    },
  }
}

async function dismissPackagedFirstLaunch(page, timeoutMs) {
  const languagePicker = page.locator('.lang-picker-overlay').first()
  const languageCard = page.locator('.lang-picker-card.lang-picker-card-visible').first()
  try {
    await languageCard.waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 2_000) })
  } catch {
    // Returning users have the first-launch marker in Chromium storage.
  }
  if (await languagePicker.isVisible().catch(() => false)) {
    const korean = languagePicker.locator('.lang-picker-btn[lang="ko"]').first()
    await korean.waitFor({ state: 'visible', timeout: timeoutMs })
    await korean.click()
    await languagePicker.waitFor({ state: 'hidden', timeout: timeoutMs })
  }
  const tutorialSkip = page.locator('.tour-skip-button').first()
  try {
    await tutorialSkip.waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 2_000) })
  } catch {
    // Returning users have already completed or skipped the tutorial.
  }
  if (await tutorialSkip.isVisible().catch(() => false)) await tutorialSkip.click()
  await waitForVisible(page, '[data-tour="navigation"]', timeoutMs, 'packaged navigation')
}

async function openPackagedSyncSettings(page, timeoutMs) {
  await (await waitForVisible(page, '[data-tour="nav-settings"]', timeoutMs, 'Settings navigation')).click()
  await waitForVisible(page, '[data-tour="settings-main"]', timeoutMs, 'Settings page')
  const details = page.locator('[data-tour="settings-sync"] details').first()
  if (await details.count() && !(await details.evaluate(element => element.open))) {
    await details.locator('summary').click()
  }
  await page.locator('[data-tour="settings-sync"]').scrollIntoViewIfNeeded()
}

async function readPackagedState(page) {
  return page.evaluate(async () => ({
    settings: await window.babyDiary.getSettings(),
    events: await window.babyDiary.listEvents(),
    dataInfo: await window.babyDiary.getDataInfo(),
    pending: (() => {
      try {
        const parsed = JSON.parse(localStorage.getItem('babydiary.pendingUploads') ?? '[]')
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    })(),
  }))
}

async function waitForNewQuickEvent(page, selector, timeoutMs) {
  const before = await readPackagedState(page)
  const known = before.events.map(item => `${item.id}:${item.rev}`)
  await (await waitForVisible(page, selector, timeoutMs, `quick event ${selector}`)).click()
  await page.waitForFunction(async knownKeys => {
    const events = await window.babyDiary.listEvents()
    const knownSet = new Set(knownKeys)
    return events.some(item => !knownSet.has(`${item.id}:${item.rev}`))
  }, known, { timeout: timeoutMs })
  const after = await readPackagedState(page)
  const knownSet = new Set(known)
  const created = after.events.filter(item => !knownSet.has(`${item.id}:${item.rev}`))
  invariant(created.length === 1, 'quick action did not create exactly one new event')
  return created[0]
}

async function waitForEmulatorEvidence(input, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let evidence
  while (Date.now() < deadline) {
    try {
      evidence = await readUpgradeEmulatorEvidence(input)
      if (predicate(evidence)) return evidence
    } catch {
      // Auth/family/event creation is eventually visible in the emulator.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 150))
  }
  throw new Error('Firebase emulator continuity evidence did not converge before timeout')
}

async function runBaselineFirebaseFlow({ page, networkGuards, tempRoot, timeoutMs, onCheckpoint = () => {} }) {
  onCheckpoint('baseline-dismiss-first-launch')
  await dismissPackagedFirstLaunch(page, timeoutMs)
  onCheckpoint('baseline-open-sync-settings')
  await openPackagedSyncSettings(page, timeoutMs)

  onCheckpoint('baseline-wait-auth-form')
  const emailInput = page.locator('[data-tour="settings-sync"] input[type="email"]').first()
  try {
    await emailInput.waitFor({ state: 'visible', timeout: timeoutMs })
  } catch {
    const retry = page.locator('[data-tour="settings-sync"] .btn-secondary').last()
    if (await retry.isVisible().catch(() => false)) await retry.click()
    await emailInput.waitFor({ state: 'visible', timeout: timeoutMs })
  }
  const form = emailInput.locator('xpath=ancestor::form')
  const switchMode = form.locator('xpath=following-sibling::button[1]')
  onCheckpoint('baseline-switch-signup-mode')
  await switchMode.click()
  const runHash = createHash('sha256').update(tempRoot).digest('hex').slice(0, 20)
  const email = `upgrade-${runHash}@example.test`
  const password = `Upgrade-${runHash}-A!9`
  await emailInput.fill(email)
  await form.locator('input[type="password"]').fill(password)
  onCheckpoint('baseline-submit-signup')
  await form.locator('button[type="submit"]').click()

  try {
    onCheckpoint('family-choice')
    const createChoice = page.locator('[data-tour="settings-sync"] button.card').first()
    await createChoice.waitFor({ state: 'visible', timeout: timeoutMs })
    await createChoice.click()
    onCheckpoint('family-create-submit')
    const createSubmit = page.locator('[data-tour="settings-sync"] .btn-primary').first()
    await createSubmit.waitFor({ state: 'visible', timeout: timeoutMs })
    await createSubmit.click()
    onCheckpoint('invite-visible')
    await page.waitForFunction(() => [...document.querySelectorAll('code')]
      .some(element => /^[A-Z0-9]{6}$/.test(element.textContent?.trim() ?? '')), undefined, { timeout: timeoutMs })
  } catch (error) {
    if (error && typeof error === 'object') {
      error.upgradeUiState = await page.evaluate(() => {
        const root = document.querySelector('[data-tour="settings-sync"]')
        const choice = root?.querySelector('button.card')
        const submit = root?.querySelector('button.btn-primary')
        const inviteVisible = [...document.querySelectorAll('code')]
          .some(element => /^[A-Z0-9]{6}$/.test(element.textContent?.trim() ?? ''))
        return {
          familyChoiceVisible: Boolean(choice && choice.getClientRects().length > 0),
          createSubmitVisible: Boolean(submit && submit.getClientRects().length > 0),
          createSubmitDisabled: Boolean(submit?.disabled),
          errorClassPresent: Boolean(root?.querySelector('svg.lucide-circle-alert, svg.lucide-alert-circle')),
          inviteVisible,
        }
      }).catch(() => ({ captureFailed: true }))
    }
    throw error
  }

  onCheckpoint('settings-persisted')
  await page.waitForFunction(async () => {
    const settings = await window.babyDiary.getSettings()
    return Boolean(settings.profile?.uid && settings.familyId)
  }, undefined, { timeout: timeoutMs })
  const linked = await readPackagedState(page)
  const uid = linked.settings.profile.uid
  const familyId = linked.settings.familyId
  invariant(uid && familyId, 'v0.3.8 UI did not persist its real account/family identity')

  const fixture = buildV038Fixture({ profileUid: uid, familyId })
  onCheckpoint('baseline-materialize-preservation-fixture')
  await page.evaluate(async value => {
    const api = window.babyDiary
    await api.saveSettings(value.settings)
    for (const item of value.events) {
      const result = await api.appendEvent(item)
      if (result !== 'ok') throw new Error('preservation fixture append failed')
    }
  }, fixture)

  onCheckpoint('baseline-create-online-event')
  await (await waitForVisible(page, '[data-tour="nav-home"]', timeoutMs, 'Home navigation')).click()
  await waitForVisible(page, '[data-tour="quick-row"]', timeoutMs, 'quick record row')
  const onlineEvent = await waitForNewQuickEvent(page, '.quick-btn-circle-pee', timeoutMs)
  const onlineCloud = await waitForEmulatorEvidence(
    { uid, familyId, pendingEvent: onlineEvent },
    value => value.cloudPendingCopies === 1,
    timeoutMs,
  )

  onCheckpoint('baseline-create-offline-event')
  networkGuards.setOffline(true)
  const pendingEvent = await waitForNewQuickEvent(page, '.quick-btn-circle-poop', timeoutMs)
  await page.waitForFunction(({ id, rev }) => {
    try {
      const pending = JSON.parse(localStorage.getItem('babydiary.pendingUploads') ?? '[]')
      return Array.isArray(pending)
        && pending.filter(item => item?.event?.id === id && item?.event?.rev === rev).length === 1
    } catch {
      return false
    }
  }, { id: pendingEvent.id, rev: pendingEvent.rev }, { timeout: timeoutMs })
  const offlineCloud = await waitForEmulatorEvidence(
    { uid, familyId, pendingEvent },
    value => value.cloudPendingCopies === 0,
    timeoutMs,
  )
  const state = await readPackagedState(page)
  invariant(state.pending.filter(item => item?.event?.id === pendingEvent.id
    && item?.event?.rev === pendingEvent.rev).length === 1,
  'v0.3.8 offline event was not durably queued exactly once')
  return {
    uid,
    email: offlineCloud.email,
    familyId,
    inviteCode: offlineCloud.inviteCode,
    memberUids: offlineCloud.memberUids,
    onlineEvent,
    pendingEvent,
    pendingCount: 1,
    cloudPendingCopies: 0,
    authFormVisible: false,
    signupAttempted: true,
    observedCloudEventIds: onlineCloud.cloudEventIds,
  }
}

async function launchSecondCandidateDevice({
  electron,
  executablePath,
  sourceEnv,
  tempRoot,
  denyProxyPort,
  allowedFileRoot,
  inviteCode,
  expectedEventIds,
  expectedVersion,
  expectedArch,
  timeoutMs,
}) {
  const secondRoot = path.join(tempRoot, 'second-device')
  const secondProfile = path.join(secondRoot, 'user-data', 'baby-diary')
  const secondRunId = sha256(`${tempRoot}:second-device`).slice(0, 32)
  await writeV038FirebaseBootstrap(secondProfile)
  let app
  let guards
  try {
    app = await acquireWithTimeout(electron.launch({
      executablePath,
      cwd: ROOT,
      env: buildPackagedLaunchEnvironment(sourceEnv, {
        profileRoot: secondProfile,
        runId: secondRunId,
      }),
      args: buildFailClosedChromiumArgs({ denyProxyPort }),
    }), timeoutMs, 'second-device Electron launch', lateApplication => (
      closeElectronApplication(lateApplication, timeoutMs)
    ))
    const reported = await withTimeout(app.evaluate(({ app }) => ({
      runId: process.env.BABYDIARY_UPGRADE_ATTEST_RUN_ID,
      userDataPath: app.getPath('userData'),
      appVersion: app.getVersion(),
      hostArchitecture: process.arch,
      beforeUi: true,
    })), timeoutMs, 'second-device main-process attestation')
    validateMainProcessAttestation(reported, {
      profileRoot: secondProfile,
      runId: secondRunId,
      expectedVersion,
      expectedArch,
    })
    guards = await installApplicationNetworkGuards(app, allowedFileRoot, {
      transportPolicy: buildUpgradeTransportPolicy('published-v038'),
    })
    const page = await withTimeout(app.firstWindow(), timeoutMs, 'second-device BrowserWindow')
    await guards.attach(page)
    await guards.assertReady()
    await withTimeout(page.waitForFunction(() => Boolean(window.babyDiary)), timeoutMs, 'second-device preload bridge')
    await dismissPackagedFirstLaunch(page, timeoutMs)
    await openPackagedSyncSettings(page, timeoutMs)
    await page.locator('[data-sync-auth-form="login"]').waitFor({ state: 'visible', timeout: timeoutMs })
    await page.locator('[data-sync-switch-mode]').click()
    await page.locator('[data-sync-auth-form="signup"]').waitFor({ state: 'visible', timeout: timeoutMs })
    const suffix = createHash('sha256').update(`${tempRoot}:second`).digest('hex').slice(0, 20)
    await page.locator('[data-sync-email]').fill(`upgrade-second-${suffix}@example.test`)
    await page.locator('[data-sync-password]').fill(`Upgrade-Second-${suffix}-A!9`)
    await page.locator('[data-sync-submit]').click()
    await page.locator('[data-sync-family-choice="join"]').waitFor({ state: 'visible', timeout: timeoutMs })
    await page.locator('[data-sync-family-choice="join"]').click()
    await page.locator('[data-sync-invite-code-input]').fill(inviteCode)
    await page.locator('[data-sync-family-submit="join"]').click()
    await page.locator('[data-sync-state="online"]').waitFor({ state: 'visible', timeout: timeoutMs })
    await page.waitForFunction(async ids => {
      const events = await window.babyDiary.listEvents()
      const visible = new Set(events.map(item => item.id))
      return ids.every(id => visible.has(id))
    }, expectedEventIds, { timeout: timeoutMs })
    const state = await readPackagedState(page)
    invariant(state.settings.profile.uid && state.settings.familyId,
      'second-device signup/join did not persist identity')
    const visible = new Set(state.events.map(item => item.id))
    return {
      uid: state.settings.profile.uid,
      familyId: state.settings.familyId,
      convergedEventIds: expectedEventIds.filter(id => visible.has(id)),
      networkEvidence: guards.getEvidence(),
    }
  } finally {
    const errors = []
    if (guards) {
      try { await guards.close() } catch (error) { errors.push(error) }
    }
    if (app) {
      try { await closeElectronApplication(app, timeoutMs) } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'second-device cleanup failed')
  }
}

async function runCandidateFirebaseFlow({
  mode,
  page,
  electron,
  executablePath,
  env,
  tempRoot,
  denyProxyPort,
  allowedFileRoot,
  expectedContinuity,
  expectedVersion,
  expectedArch,
  timeoutMs,
}) {
  invariant(expectedContinuity?.version === 2, 'candidate expected auth continuity is missing')
  await dismissPackagedFirstLaunch(page, timeoutMs)
  await openPackagedSyncSettings(page, timeoutMs)
  try {
    await page.locator('[data-sync-state="online"]').waitFor({ state: 'visible', timeout: timeoutMs })
  } catch {
    const errorRetry = page.locator('[data-sync-state="error"] .btn-secondary').first()
    if (await errorRetry.isVisible().catch(() => false)) {
      await errorRetry.click()
      await page.locator('[data-sync-state="online"]').waitFor({ state: 'visible', timeout: timeoutMs })
    } else {
      throw new Error('candidate did not restore its authenticated online session')
    }
  }
  const authFormObserved = await page.evaluate(() => Boolean(window.__babyDiaryUpgradeAuthFormObserved))
  invariant(!authFormObserved && await page.locator('[data-sync-auth-form]').count() === 0,
    'candidate exposed signed-out authentication UI during session restoration')
  await page.waitForFunction(() => {
    const state = document.querySelector('[data-sync-state="online"]')
    return state?.getAttribute('data-sync-pending-count') === '0'
  }, undefined, { timeout: timeoutMs })

  const state = await readPackagedState(page)
  invariant(sha256(state.settings.profile.uid) === expectedContinuity.uidSha256,
    'candidate settings account uid changed before continuity proof')
  invariant(sha256(state.settings.familyId) === expectedContinuity.familyIdSha256,
    'candidate settings family id changed or was cleared before continuity proof')
  const onlineEvent = state.events.find(item => sha256(item.id) === expectedContinuity.onlineEvent.idSha256
    && item.rev === expectedContinuity.onlineEvent.rev)
  const pendingEvent = state.events.find(item => sha256(item.id) === expectedContinuity.pendingEvent.idSha256
    && item.rev === expectedContinuity.pendingEvent.rev)
  invariant(onlineEvent && pendingEvent, 'candidate local EventLog lost an upgrade continuity event')
  invariant(state.pending.filter(item => item?.event?.id === pendingEvent.id
    && item?.event?.rev === pendingEvent.rev).length === 0,
  'candidate retained the drained event in its local pending queue')
  let emulator = await waitForEmulatorEvidence(
    { uid: state.settings.profile.uid, familyId: state.settings.familyId, pendingEvent },
    value => value.cloudPendingCopies === 1
      && value.cloudEventIds.includes(onlineEvent.id)
      && value.cloudEventIds.includes(pendingEvent.id),
    timeoutMs,
  )

  let secondDevice
  if (mode === 'candidate-first-run') {
    secondDevice = await launchSecondCandidateDevice({
      electron,
      executablePath,
      sourceEnv: env,
      tempRoot,
      denyProxyPort,
      allowedFileRoot,
      inviteCode: emulator.inviteCode,
      expectedEventIds: [onlineEvent.id, pendingEvent.id],
      expectedVersion,
      expectedArch,
      timeoutMs,
    })
    emulator = await waitForEmulatorEvidence(
      { uid: state.settings.profile.uid, familyId: state.settings.familyId, pendingEvent },
      value => value.cloudPendingCopies === 1 && value.memberUids.includes(secondDevice.uid),
      timeoutMs,
    )
  } else {
    const secondUid = emulator.memberUids.find(uid => uid !== state.settings.profile.uid)
    invariant(secondUid, 'second-device membership disappeared after candidate restart')
    secondDevice = {
      uid: secondUid,
      familyId: state.settings.familyId,
      convergedEventIds: [onlineEvent.id, pendingEvent.id],
    }
  }

  return {
    uid: state.settings.profile.uid,
    email: emulator.email,
    familyId: state.settings.familyId,
    inviteCode: emulator.inviteCode,
    memberUids: emulator.memberUids,
    onlineEvent,
    pendingEvent,
    pendingCount: 0,
    cloudPendingCopies: emulator.cloudPendingCopies,
    authFormVisible: authFormObserved,
    signupAttempted: false,
    secondDevice: {
      uid: secondDevice.uid,
      familyId: secondDevice.familyId,
      convergedEventIds: secondDevice.convergedEventIds,
    },
    secondDeviceNetworkEvidence: secondDevice.networkEvidence,
  }
}

async function defaultRunPackagedSession({
  mode,
  executablePath,
  profileRoot,
  tempRoot,
  runId,
  env,
  expectedVersion,
  expectedArch,
  onMainProcessAttestation,
  expectedBabyInfoKeys = [],
  expectedContinuity,
  timeouts = DEFAULT_PHASE_TIMEOUTS,
}) {
  invariant(typeof onMainProcessAttestation === 'function',
    'pre-UI main-process attestation recorder is required')
  const emulator = validateUpgradeEmulatorEnvironment(env)
  const { _electron: electron } = await import('playwright')
  const denyProxy = await startUpgradeDenyProxy()
  const allowedFileRoot = packagedResourceRoot(executablePath)
  const resourceStats = await lstat(allowedFileRoot)
  invariant(resourceStats.isFile() && !resourceStats.isSymbolicLink(),
    'packaged app.asar must be a real regular file')
  invariant(normalizeForComparison(await realpath(allowedFileRoot)) === normalizeForComparison(allowedFileRoot),
    'packaged app.asar resolves through a link/reparse point')
  let electronApp
  let networkGuards
  const cleanupErrors = []
  let checkpoint = 'electron-launch'
  try {
    electronApp = await acquireWithTimeout(electron.launch({
      executablePath,
      cwd: ROOT,
      env: buildPackagedLaunchEnvironment(env, { profileRoot, runId }),
      args: buildFailClosedChromiumArgs({ denyProxyPort: denyProxy.port }),
    }), timeouts.launchMs, 'Electron launch', lateApplication => (
      closeElectronApplication(lateApplication, timeouts.closeMs)
    ))
    checkpoint = 'main-process-attestation'
    const reportedAttestation = await withTimeout(electronApp.evaluate(({ app }) => ({
      runId: process.env.BABYDIARY_UPGRADE_ATTEST_RUN_ID,
      userDataPath: app.getPath('userData'),
      appVersion: app.getVersion(),
      hostArchitecture: process.arch,
      beforeUi: true,
    })), timeouts.rendererMs, 'main-process attestation')
    const mainProcessAttestation = validateMainProcessAttestation(reportedAttestation, {
      profileRoot,
      runId,
      expectedVersion,
      expectedArch,
    })
    await onMainProcessAttestation(mainProcessAttestation)
    checkpoint = 'network-guard-installation'
    networkGuards = await installApplicationNetworkGuards(electronApp, allowedFileRoot, {
      observeAuthForms: mode !== 'baseline-initialize',
      transportPolicy: buildUpgradeTransportPolicy('published-v038'),
    })
    checkpoint = 'first-window'
    const page = await withTimeout(electronApp.firstWindow(), timeouts.firstWindowMs, 'first BrowserWindow')
    await networkGuards.attach(page)
    await networkGuards.assertReady()
    checkpoint = 'preload-bridge'
    await withTimeout(page.waitForFunction(() => Boolean(window.babyDiary)), timeouts.rendererMs, 'preload bridge')
    const continuity = mode === 'baseline-initialize'
      ? await runBaselineFirebaseFlow({
          page,
          networkGuards,
          tempRoot,
          timeoutMs: timeouts.rendererMs,
          onCheckpoint: value => { checkpoint = value },
        })
      : await runCandidateFirebaseFlow({
          mode,
          page,
          electron,
          executablePath,
          env,
          tempRoot,
          denyProxyPort: denyProxy.port,
          allowedFileRoot,
          expectedContinuity,
          expectedVersion,
          expectedArch,
          timeoutMs: timeouts.rendererMs,
        })
    const rendererResult = await withTimeout(page.evaluate(async payload => {
      const api = window.babyDiary
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
    }, { mode, expectedBabyInfoKeys }), timeouts.rendererMs, `${mode} renderer contract`)
    invariant(typeof rendererResult.dataDir === 'string', 'packaged application did not report its data directory')
    const canonicalUserDataPath = path.dirname(rendererResult.dataDir)
    invariant(normalizeForComparison(canonicalUserDataPath) === normalizeForComparison(profileRoot),
      'packaged application selected an unexpected user-data directory')
    if (mode !== 'baseline-initialize') {
      await assertCandidateUiVisibility(page, rendererResult.publicView, timeouts.rendererMs)
    }
    await networkGuards.assertReady()
    const networkEvidence = networkGuards.getEvidence()
    invariant((networkEvidence.externalBlocks ?? 0) === 0,
      'packaged renderer attempted a non-Firebase external request')
    invariant((networkEvidence.rewrittenFirestore ?? 0) > 0,
      'packaged renderer did not exercise Firestore emulator request rewriting')
    invariant(networkEvidence.runtimeRequestKeySha256 === V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256,
      'packaged renderer did not use the SHA-pinned v0.3.8 Firebase request key')
    if (mode === 'baseline-initialize') {
      invariant((networkEvidence.rewrittenAuth ?? 0) > 0,
        'v0.3.8 signup did not exercise Auth emulator request rewriting')
      invariant((networkEvidence.rewrittenPasswordPolicy ?? 0) > 0,
        'v0.3.8 signup did not exercise Auth password-policy emulator request rewriting')
      invariant((networkEvidence.expectedOfflineBlocks ?? 0) > 0,
        'v0.3.8 offline phase did not block a real Firebase request')
    }
    if (continuity.secondDeviceNetworkEvidence) {
      invariant((continuity.secondDeviceNetworkEvidence.externalBlocks ?? 0) === 0,
        'second-device renderer attempted a non-Firebase external request')
      invariant((continuity.secondDeviceNetworkEvidence.rewrittenAuth ?? 0) > 0
        && (continuity.secondDeviceNetworkEvidence.rewrittenFirestore ?? 0) > 0,
      'second-device did not exercise Auth and Firestore emulator rewriting')
    }
    return {
      appVersion: mainProcessAttestation.appVersion,
      hostArchitecture: mainProcessAttestation.hostArchitecture,
      canonicalUserDataPath: path.resolve(canonicalUserDataPath),
      publicView: rendererResult.publicView,
      continuity,
      networkEvidence,
      secondDeviceNetworkEvidence: continuity.secondDeviceNetworkEvidence,
    }
  } catch (error) {
    if (error && typeof error === 'object') {
      if (!error.upgradeCheckpoint) error.upgradeCheckpoint = checkpoint
      if (!error.upgradeNetworkEvidence && networkGuards) {
        error.upgradeNetworkEvidence = networkGuards.getEvidence()
      }
    }
    throw error
  } finally {
    if (networkGuards) {
      try { await networkGuards.close() } catch (error) { cleanupErrors.push(error) }
    }
    if (electronApp) {
      try { await closeElectronApplication(electronApp, timeouts.closeMs) } catch (error) { cleanupErrors.push(error) }
    }
    try { await denyProxy.close() } catch (error) { cleanupErrors.push(error) }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'packaged Firebase session cleanup failed')
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
  const sourcesByContentId = new Map(projection.eventSources.map(item => [item.contentId, item]))
  const derivativesByMutationId = new Map(
    (projection.eventDerivatives ?? []).map(item => [item.mutationId, item]),
  )
  const visibleIds = new Set()
  const runtimeWinners = runtimeView.events.map(item => {
    const canonical = canonicalJson(item)
    let source = sourcesByCanonical.get(canonical)
    if (!source && item?.migration?.kind === 'legacy-author-v1') {
      const derivative = derivativesByMutationId.get(item.mutationId)
      invariant(derivative
        && derivative.sourceContentId === item.migration.sourceContentId
        && derivative.canonicalHash === createHash('sha256').update(canonical).digest('hex'),
      'runtime listEvents exposed a substituted auth-bound derivative')
      source = sourcesByContentId.get(derivative.sourceContentId)
      invariant(source
        && source.id === item.id
        && source.rev === item.rev
        && source.deleted === item.deleted,
      'runtime listEvents derivative does not resolve to its retained source')
    }
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
  const interactiveProfileRoot = resolveInteractiveProfileForPlatform(options.platform, options.env)
  const owned = await validateNonceOwnedPaths({
    tempRoot: options.tempRoot,
    profileRoot: options.profileRoot,
    interactiveProfileRoot,
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
  const comparisonEvidence = comparisonProjection
    ? redactUpgradeProjection(comparisonProjection)
    : undefined
  const expectedBabyInfoKeys = comparisonProjection?.babyInfo?.mutations?.map(item => item.key)
  invariant(options.mode === 'baseline-initialize'
    || (Array.isArray(expectedBabyInfoKeys) && expectedBabyInfoKeys.every(key => typeof key === 'string')),
  'candidate comparison projection has invalid baby-info mutation keys')
  let diagnostic = {
    runId: options.runId,
    sourceSha: options.sourceSha,
    executableSha256: null,
    executableSize: executableStats.size,
    appVersion: null,
    hostArchitecture: null,
    canonicalUserDataPath: null,
    processReportedRunId: null,
    attestationBeforeUi: false,
    fixtureProjectionHash: null,
    phase: options.mode,
    passed: false,
  }
  try {
    diagnostic.executableSha256 = await hash(executablePath)
    if (options.mode === 'baseline-initialize') {
      const validateOverride = dependencies.validateV038UserDataOverrideContract
        ?? validateV038UserDataOverrideContract
      diagnostic.baselineUserDataOverrideEvidence = await validateOverride({ repositoryRoot: ROOT })
      invariant(canonicalJson(diagnostic.baselineUserDataOverrideEvidence)
        === canonicalJson(V038_USERDATA_OVERRIDE_EVIDENCE),
      'baseline userData override source evidence changed')
    }
    if (!dependencies.runPackagedSession) {
      if (options.mode === 'baseline-initialize') {
        await writeV038FirebaseBootstrap(owned.profileRoot)
      }
      diagnostic.firebaseSettingsEvidence = await readFirebaseSettingsEvidence(owned.profileRoot)
      invariant(diagnostic.firebaseSettingsEvidence.configMatchesExactTag,
        'pre-launch Firebase settings do not match the exact v0.3.8 default config')
    }
    let recordedAttestation
    const onMainProcessAttestation = async reported => {
      invariant(!recordedAttestation, 'main-process attestation was reported more than once')
      recordedAttestation = validateMainProcessAttestation(reported, {
        profileRoot: owned.profileRoot,
        runId: options.runId,
        expectedVersion: options.expectedVersion,
        expectedArch: options.expectedArch,
      })
      diagnostic = {
        ...diagnostic,
        appVersion: recordedAttestation.appVersion,
        hostArchitecture: recordedAttestation.hostArchitecture,
        canonicalUserDataPath: recordedAttestation.userDataPath,
        processReportedRunId: recordedAttestation.runId,
        attestationBeforeUi: true,
      }
      await writeJsonAtomic(path.resolve(options.diagnosticPath), sanitizeUpgradeDiagnostic(diagnostic))
    }
    const runtime = await runSession({
      mode: options.mode,
      executablePath,
      profileRoot: owned.profileRoot,
      tempRoot: owned.tempRoot,
      runId: options.runId,
      env: options.env,
      expectedVersion: options.expectedVersion,
      expectedArch: options.expectedArch,
      onMainProcessAttestation,
      expectedBabyInfoKeys: expectedBabyInfoKeys ?? [],
      expectedContinuity: comparisonProjection?.authSync,
      timeouts: options.timeouts ?? DEFAULT_PHASE_TIMEOUTS,
    })
    invariant(recordedAttestation, 'packaged session did not record a pre-UI main-process attestation')
    invariant(runtime.appVersion === options.expectedVersion,
      `packaged version mismatch: expected ${options.expectedVersion}`)
    invariant(runtime.hostArchitecture === options.expectedArch,
      `packaged architecture mismatch: expected ${options.expectedArch}`)
    invariant(normalizeForComparison(runtime.canonicalUserDataPath) === normalizeForComparison(owned.profileRoot),
      'runtime user-data path does not match the wrapper-owned canonical path')
    invariant(runtime.appVersion === recordedAttestation.appVersion
      && runtime.hostArchitecture === recordedAttestation.hostArchitecture
      && normalizeForComparison(runtime.canonicalUserDataPath)
        === normalizeForComparison(recordedAttestation.userDataPath),
    'renderer/runtime result does not match the pre-UI main-process attestation')

    if (options.mode === 'baseline-initialize') {
      await materializeV038AuxiliaryFixture(owned.profileRoot)
    }

    const baseProjection = options.mode === 'baseline-initialize'
      ? runtime.continuity
        ? await project(owned.profileRoot)
        : await validateFixture(owned.profileRoot)
      : await project(owned.profileRoot)
    assertRuntimeDiscoverability(baseProjection, runtime.publicView, options.mode)
    const projection = {
      ...redactUpgradeProjection(baseProjection),
      ...(runtime.continuity ? { authSync: snapshotUpgradeContinuity(runtime.continuity) } : {}),
    }
    if (comparisonEvidence?.authSync) {
      invariant(projection.authSync, 'candidate did not produce real authentication continuity evidence')
      assertUpgradeContinuity(comparisonEvidence.authSync, projection.authSync, options.mode)
    } else if (!dependencies.runPackagedSession) {
      invariant(projection.authSync, 'packaged phase did not produce real authentication continuity evidence')
    }
    if (options.mode === 'candidate-first-run') {
      assertSemanticPreservation(comparisonEvidence, projection)
    } else if (options.mode === 'candidate-second-run') {
      assertSemanticIdempotence(comparisonEvidence, projection)
    }
    await writeJsonAtomic(path.resolve(options.projectionOutputPath), projection)
    diagnostic = {
      ...diagnostic,
      appVersion: runtime.appVersion,
      hostArchitecture: runtime.hostArchitecture,
      canonicalUserDataPath: path.resolve(runtime.canonicalUserDataPath),
      fixtureProjectionHash: semanticProjectionHash(projection),
      networkEvidence: runtime.networkEvidence,
      secondDeviceNetworkEvidence: runtime.secondDeviceNetworkEvidence,
      passed: true,
    }
    const sanitized = sanitizeUpgradeDiagnostic(diagnostic)
    await writeJsonAtomic(path.resolve(options.diagnosticPath), sanitized)
    return sanitized
  } catch (error) {
    const sanitized = sanitizeUpgradeDiagnostic({
      ...diagnostic,
      failureCode: error instanceof Error ? error.name : 'UnknownFailure',
      failurePhase: error?.upgradeCheckpoint ?? error?.phase,
      failureUiState: error?.upgradeUiState,
      networkEvidence: error?.upgradeNetworkEvidence,
      passed: false,
    })
    await writeJsonAtomic(path.resolve(options.diagnosticPath), sanitized)
    throw error
  }
}

function parseArtifactCli(args) {
  const command = args[0]
  if (command === 'capture-profile-fingerprint' || command === 'verify-profile-noninterference') {
    const fields = command === 'capture-profile-fingerprint'
      ? {
          '--interactive-profile': 'interactiveProfileRoot',
          '--temp-root': 'tempRoot',
          '--run-id': 'runId',
          '--output': 'outputPath',
        }
      : {
          '--interactive-profile': 'interactiveProfileRoot',
          '--temp-root': 'tempRoot',
          '--run-id': 'runId',
          '--before': 'beforePath',
          '--output': 'outputPath',
        }
    const result = { command }
    for (let index = 1; index < args.length; index += 2) {
      const flag = args[index]
      const value = args[index + 1]
      const field = fields[flag]
      invariant(field, `unknown profile fingerprint argument: ${String(flag)}`)
      invariant(!Object.hasOwn(result, field), `duplicate profile fingerprint argument: ${flag}`)
      invariant(typeof value === 'string' && value.length > 0 && !value.startsWith('--'),
        `profile fingerprint value is missing: ${flag}`)
      result[field] = value
    }
    for (const field of Object.values(fields)) {
      invariant(typeof result[field] === 'string', `profile fingerprint field is missing: ${field}`)
    }
    return result
  }
  if (command === 'verify-baseline-manifest') {
    invariant(args.length === 3 && args[1] === '--manifest' && typeof args[2] === 'string' && args[2].length > 0,
      'verify-baseline-manifest requires exactly --manifest PATH')
    return { command, manifestPath: args[2] }
  }
  invariant(command === 'verify-artifacts', 'artifact command is invalid')
  const fields = {
    '--run-id': 'runId',
    '--mode': 'mode',
    '--expected-version': 'expectedVersion',
    '--expected-arch': 'expectedArch',
    '--source-sha': 'sourceSha',
    '--diagnostic': 'diagnosticPath',
    '--projection': 'projectionPath',
    '--profile-root': 'profileRoot',
  }
  const result = { command }
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    const field = fields[flag]
    invariant(field, `unknown artifact verification argument: ${String(flag)}`)
    invariant(!Object.hasOwn(result, field), `duplicate artifact verification argument: ${flag}`)
    invariant(typeof value === 'string' && value.length > 0 && !value.startsWith('--'),
      `artifact verification value is missing: ${flag}`)
    result[field] = value
  }
  for (const field of Object.values(fields)) {
    invariant(typeof result[field] === 'string', `artifact verification field is missing: ${field}`)
  }
  return result
}

async function isDirectEntryPoint(argvPath) {
  if (!argvPath) return false
  try {
    return normalizeForComparison(await realpath(path.resolve(argvPath)))
      === normalizeForComparison(await realpath(SCRIPT_PATH))
  } catch {
    return false
  }
}

const isDirectRun = await isDirectEntryPoint(process.argv[1])
if (isDirectRun) {
  let diagnosticPath
  try {
    const args = process.argv.slice(2)
    if ([
      'verify-artifacts',
      'verify-baseline-manifest',
      'capture-profile-fingerprint',
      'verify-profile-noninterference',
    ].includes(args[0])) {
      const artifact = parseArtifactCli(args)
      const result = artifact.command === 'verify-artifacts'
        ? await validateCompletedUpgradePhaseArtifacts(artifact)
        : artifact.command === 'verify-baseline-manifest'
          ? await validateBaselineManifestArtifact(artifact)
          : artifact.command === 'capture-profile-fingerprint'
            ? await captureProfileFingerprintArtifact(artifact)
            : await verifyProfileNonInterferenceArtifact(artifact)
      console.log(JSON.stringify({ command: artifact.command, ...result }))
      process.exitCode = 0
    } else {
      const options = parseUpgradeCli(args)
      diagnosticPath = options.diagnosticPath
      const result = await runUpgradePhase(options)
      console.log(JSON.stringify({ phase: result.phase, passed: result.passed, diagnosticPath }))
    }
  } catch (error) {
    const failureName = error instanceof Error ? error.name : 'UnknownFailure'
    console.error(`[upgrade-e2e] FAIL ${failureName}${diagnosticPath ? `; diagnostic=${diagnosticPath}` : ''}`)
    process.exitCode = 1
  }
}
