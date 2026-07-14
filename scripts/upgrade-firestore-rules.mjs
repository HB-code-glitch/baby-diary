/**
 * Exact Firestore-rules lifecycle for the published v0.3.8 -> v0.3.9 gate.
 *
 * The emulator starts from the immutable v0.3.8 git blob. After the baseline
 * application closes, a bidirectional rules sentinel proves the old policy,
 * atomically replaces only the watched run-owned file, and proves the
 * candidate policy loaded in the same emulator data process.
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const ROOT = path.dirname(path.dirname(SCRIPT_PATH))
const RUN_ID_PATTERN = /^[0-9a-f]{32}$/
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/
const HASH_PATTERN = /^[0-9a-f]{64}$/
const PROJECT_ID = 'demo-baby-diary'
const AUTH_ORIGIN = 'http://127.0.0.1:9099'
const FIRESTORE_ORIGIN = 'http://127.0.0.1:8080'

export const V038_RULES_EVIDENCE = Object.freeze({
  sourceCommit: '4ad44829c0de56da33d9123c16f92e6090f0df4a',
  blobId: 'ff13c4aaa75b3544083081d6ef19f0d2dca70ec9',
  sha256: '665161e4c56c3736f3ecbe6bf0cbd3b991de5dd10cd996d26b58572c0829e5b3',
  size: 5_863,
})

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function normalizedPath(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function git(repositoryRoot, args, { binary = false } = {}) {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: binary ? null : 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  })
  invariant(result.status === 0, 'required immutable Firestore rules git object is unavailable')
  return binary ? result.stdout : result.stdout.trim()
}

function readRulesObject(repositoryRoot, sourceCommit, expected = {}) {
  invariant(SOURCE_SHA_PATTERN.test(sourceCommit), 'rules source commit is invalid')
  const resolvedCommit = git(repositoryRoot, ['rev-parse', `${sourceCommit}^{commit}`])
  invariant(resolvedCommit === sourceCommit, 'rules source does not resolve to the exact commit')
  const blobId = git(repositoryRoot, ['rev-parse', `${sourceCommit}:firestore.rules`])
  const bytes = git(repositoryRoot, ['cat-file', 'blob', blobId], { binary: true })
  const evidence = {
    sourceCommit,
    blobId,
    sha256: sha256(bytes),
    size: bytes.byteLength,
  }
  if (expected.blobId) invariant(evidence.blobId === expected.blobId, 'v0.3.8 rules blob identity changed')
  if (expected.sha256) invariant(evidence.sha256 === expected.sha256, 'v0.3.8 rules SHA-256 changed')
  if (expected.size) invariant(evidence.size === expected.size, 'v0.3.8 rules byte length changed')
  return { bytes, evidence }
}

async function fsyncDirectory(directory) {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeAtomic(filePath, bytes) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, filePath)
  await fsyncDirectory(path.dirname(filePath))
}

async function writeJsonAtomic(filePath, value) {
  await writeAtomic(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))
}

async function initializeOwnedRoot(root, runId) {
  invariant(RUN_ID_PATTERN.test(runId), 'rules run id must be a lowercase 32-hex nonce')
  const absolute = path.resolve(root)
  invariant(path.basename(absolute) === `baby-diary-upgrade-rules-${runId}`,
    'rules root is not bound exactly to the run nonce')
  const parent = path.dirname(absolute)
  invariant(normalizedPath(await realpath(parent)) === normalizedPath(parent),
    'rules root parent resolves through a link/reparse point')
  try {
    const stats = await lstat(absolute)
    invariant(stats.isDirectory() && !stats.isSymbolicLink(), 'rules root must be a regular directory')
    invariant((await readdir(absolute)).length === 0, 'rules root must be empty before preparation')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await mkdir(absolute, { mode: 0o700 })
  }
  invariant(normalizedPath(await realpath(absolute)) === normalizedPath(absolute),
    'rules root resolves through a link/reparse point')
  return absolute
}

async function assertOwnedRoot(root, runId) {
  invariant(RUN_ID_PATTERN.test(runId), 'rules run id must be a lowercase 32-hex nonce')
  const absolute = path.resolve(root)
  invariant(path.basename(absolute) === `baby-diary-upgrade-rules-${runId}`,
    'rules root is not bound exactly to the run nonce')
  const stats = await lstat(absolute)
  invariant(stats.isDirectory() && !stats.isSymbolicLink(), 'rules root must be a regular directory')
  invariant(normalizedPath(await realpath(absolute)) === normalizedPath(absolute),
    'rules root resolves through a link/reparse point')
  return absolute
}

async function readRegularFile(root, name) {
  const filePath = path.join(root, name)
  const stats = await lstat(filePath)
  invariant(stats.isFile() && !stats.isSymbolicLink(), `${name} must be a regular file`)
  invariant(normalizedPath(await realpath(filePath)) === normalizedPath(filePath),
    `${name} resolves through a link/reparse point`)
  const bytes = await readFile(filePath)
  invariant(bytes.byteLength === stats.size, `${name} changed while reading`)
  return bytes
}

function firebaseConfig() {
  return {
    firestore: { database: '(default)', rules: 'firestore.rules' },
    auth: { providers: { emailPassword: true } },
    emulators: {
      auth: { host: '127.0.0.1', port: 9099 },
      firestore: { host: '127.0.0.1', port: 8080 },
      ui: { enabled: false },
      singleProjectMode: true,
    },
  }
}

export async function prepareUpgradeRulesWorkspace({
  root,
  runId,
  candidateSourceSha,
  repositoryRoot = ROOT,
}) {
  invariant(SOURCE_SHA_PATTERN.test(candidateSourceSha), 'candidate rules source SHA is invalid')
  const ownedRoot = await initializeOwnedRoot(root, runId)
  const repository = path.resolve(repositoryRoot)
  const baseline = readRulesObject(repository, V038_RULES_EVIDENCE.sourceCommit, V038_RULES_EVIDENCE)
  const candidate = readRulesObject(repository, candidateSourceSha)
  invariant(candidate.evidence.sha256 !== baseline.evidence.sha256,
    'candidate Firestore rules unexpectedly equal the v0.3.8 policy')

  const configBytes = Buffer.from(`${JSON.stringify(firebaseConfig(), null, 2)}\n`, 'utf8')
  await writeAtomic(path.join(ownedRoot, 'firestore.rules'), baseline.bytes)
  await writeAtomic(path.join(ownedRoot, 'candidate.rules'), candidate.bytes)
  await writeAtomic(path.join(ownedRoot, 'firebase.json'), configBytes)
  const manifest = {
    version: 1,
    projectId: PROJECT_ID,
    runId,
    phase: 'baseline',
    baseline: baseline.evidence,
    candidate: candidate.evidence,
    firebaseConfigSha256: sha256(configBytes),
  }
  await writeJsonAtomic(path.join(ownedRoot, 'rules-transition.json'), manifest)
  return manifest
}

function firestoreValue(value) {
  if (typeof value === 'string') return { stringValue: value }
  if (typeof value === 'boolean') return { booleanValue: value }
  if (Number.isSafeInteger(value)) return { integerValue: String(value) }
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'sentinel Firestore value is invalid')
  return { mapValue: { fields: Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, firestoreValue(child)]),
  ) } }
}

function firestoreDocument(value) {
  return { fields: Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, firestoreValue(child)]),
  ) }
}

async function fetchStatus(url, { method = 'GET', token, body } = {}) {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    })
    return response.status
  } catch {
    throw new Error('Firestore rules sentinel transport failed')
  }
}

async function createSentinelAccount() {
  const nonce = randomUUID()
  const response = await fetch(
    `${AUTH_ORIGIN}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `upgrade-rules-${nonce}@example.test`,
        password: `Upgrade-Rules-${nonce}-A!9`,
        returnSecureToken: true,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  )
  invariant(response.status === 200, `Auth rules sentinel signup failed with status ${response.status}`)
  const value = await response.json()
  invariant(typeof value?.localId === 'string' && typeof value?.idToken === 'string',
    'Auth rules sentinel response is invalid')
  return { uid: value.localId, idToken: value.idToken }
}

function documentUrl(documentPath, query = '') {
  return `${FIRESTORE_ORIGIN}/v1/projects/${PROJECT_ID}/databases/(default)/documents/${documentPath}${query}`
}

async function expectStatus(label, promise, expected) {
  const status = await promise
  invariant(status === expected, `${label} returned status ${status}; expected ${expected}`)
  return status
}

/** Actual emulator probe; the token/password never leave this function. */
export async function runRulesTransitionSentinel({ activateCandidate, timeoutMs = 20_000 }) {
  invariant(typeof activateCandidate === 'function', 'candidate rules activator is required')
  const { uid, idToken } = await createSentinelAccount()
  const nonce = randomUUID()
  const familyId = `rules-probe-${nonce}`
  const mutationId = randomUUID()
  const originId = randomUUID()
  const familyUrl = documentUrl(`families/${encodeURIComponent(familyId)}`, '?currentDocument.exists=false')
  const legacyCreateUrl = documentUrl(`users/${encodeURIComponent(uid)}`, '?currentDocument.exists=false')
  const legacyUpdateUrl = documentUrl(`users/${encodeURIComponent(uid)}`)
  const mutationUrl = documentUrl(
    `families/${encodeURIComponent(familyId)}/babyInfoMutations/${encodeURIComponent(`b1|${mutationId}|${originId}`)}`,
    '?currentDocument.exists=false',
  )
  const family = firestoreDocument({
    members: { [uid]: { name: 'Rules probe', role: 'dad' } },
  })
  const legacyUser = firestoreDocument({ legacyProbe: true })
  const now = new Date().toISOString()
  const modernMutation = firestoreDocument({
    mutation: {
      mutationId,
      familyId,
      babyName: 'Rules probe',
      babyBirthdate: '',
      logicalClock: 1,
      updatedAt: now,
      updatedAtMs: Date.parse(now),
      authorId: uid,
      origin: 'user',
    },
  })

  await expectStatus('rules sentinel family seed', fetchStatus(familyUrl, {
    method: 'PATCH', token: 'owner', body: family,
  }), 200)
  const baselineLegacy = await expectStatus('v0.3.8 legacy self-user write', fetchStatus(legacyCreateUrl, {
    method: 'PATCH', token: idToken, body: legacyUser,
  }), 200)
  const baselineModern = await expectStatus('v0.3.8 modern baby mutation denial', fetchStatus(mutationUrl, {
    method: 'PATCH', token: idToken, body: modernMutation,
  }), 403)

  await activateCandidate()
  const deadline = Date.now() + timeoutMs
  let candidateLegacy
  while (Date.now() < deadline) {
    candidateLegacy = await fetchStatus(legacyUpdateUrl, {
      method: 'PATCH', token: idToken, body: legacyUser,
    })
    if (candidateLegacy === 403) break
    invariant(candidateLegacy === 200, `candidate legacy sentinel returned unexpected status ${candidateLegacy}`)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  invariant(candidateLegacy === 403, 'candidate Firestore rules did not reload before timeout')
  const candidateModern = await expectStatus('candidate modern baby mutation allow', fetchStatus(mutationUrl, {
    method: 'PATCH', token: idToken, body: modernMutation,
  }), 200)

  return {
    baseline: { legacyWrite: baselineLegacy, modernBabyMutation: baselineModern },
    candidate: { legacyWrite: candidateLegacy, modernBabyMutation: candidateModern },
  }
}

export async function transitionUpgradeFirestoreRules({
  root,
  runId,
  candidateSourceSha,
}, dependencies = {}) {
  invariant(SOURCE_SHA_PATTERN.test(candidateSourceSha), 'candidate rules source SHA is invalid')
  const ownedRoot = await assertOwnedRoot(root, runId)
  const manifestPath = path.join(ownedRoot, 'rules-transition.json')
  const manifestBytes = await readRegularFile(ownedRoot, 'rules-transition.json')
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  invariant(manifest?.version === 1 && manifest.projectId === PROJECT_ID
    && manifest.runId === runId && manifest.phase === 'baseline',
  'rules transition manifest is invalid or already used')
  invariant(manifest.baseline?.sourceCommit === V038_RULES_EVIDENCE.sourceCommit
    && manifest.baseline?.blobId === V038_RULES_EVIDENCE.blobId
    && manifest.baseline?.sha256 === V038_RULES_EVIDENCE.sha256
    && manifest.baseline?.size === V038_RULES_EVIDENCE.size,
  'v0.3.8 rules evidence changed')
  invariant(manifest.candidate?.sourceCommit === candidateSourceSha
    && HASH_PATTERN.test(manifest.candidate?.sha256),
  'candidate rules evidence does not match the release source')

  const [activeRules, candidateRules, configBytes] = await Promise.all([
    readRegularFile(ownedRoot, 'firestore.rules'),
    readRegularFile(ownedRoot, 'candidate.rules'),
    readRegularFile(ownedRoot, 'firebase.json'),
  ])
  invariant(sha256(activeRules) === manifest.baseline.sha256,
    'active v0.3.8 rules hash changed before transition')
  invariant(sha256(candidateRules) === manifest.candidate.sha256,
    'candidate rules file hash changed or was tampered')
  invariant(candidateRules.byteLength === manifest.candidate.size,
    'candidate rules file length changed or was tampered')
  invariant(sha256(configBytes) === manifest.firebaseConfigSha256,
    'run-owned Firebase emulator config changed')

  const runSentinel = dependencies.runRulesTransitionSentinel ?? runRulesTransitionSentinel
  let activated = false
  const evidence = await runSentinel({
    activateCandidate: async () => {
      invariant(!activated, 'candidate rules were activated more than once')
      activated = true
      await writeJsonAtomic(manifestPath, { ...manifest, phase: 'transitioning' })
      await writeAtomic(path.join(ownedRoot, 'firestore.rules'), candidateRules)
      const activatedRules = await readRegularFile(ownedRoot, 'firestore.rules')
      invariant(sha256(activatedRules) === manifest.candidate.sha256,
        'candidate rules activation was not byte-exact')
    },
  })
  invariant(activated, 'rules sentinel did not activate candidate rules')
  invariant(evidence?.baseline?.legacyWrite === 200
    && evidence?.baseline?.modernBabyMutation === 403
    && evidence?.candidate?.legacyWrite === 403
    && evidence?.candidate?.modernBabyMutation === 200,
  'rules sentinel evidence is incomplete')
  const completed = { ...manifest, phase: 'candidate', rulesTransition: evidence }
  await writeJsonAtomic(manifestPath, completed)
  return completed
}

function parseCli(args, env = process.env) {
  const command = args[0]
  if (command === 'transition-env') {
    invariant(args.length === 1, 'transition-env does not accept command-line values')
    return {
      command: 'transition',
      root: env.BABYDIARY_UPGRADE_RULES_ROOT,
      runId: env.BABYDIARY_UPGRADE_RULES_RUN_ID,
      candidateSourceSha: env.BABYDIARY_UPGRADE_RULES_CANDIDATE_SOURCE_SHA,
      repositoryRoot: ROOT,
    }
  }
  invariant(command === 'prepare' || command === 'transition',
    'rules command must be prepare, transition, or transition-env')
  const values = {}
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    invariant(['--root', '--run-id', '--candidate-source-sha', '--repository-root'].includes(flag),
      `unknown rules argument: ${String(flag)}`)
    invariant(typeof value === 'string' && value.length > 0 && !value.startsWith('--'),
      `rules argument value is missing: ${flag}`)
    invariant(values[flag] === undefined, `duplicate rules argument: ${flag}`)
    values[flag] = value
  }
  invariant(values['--root'] && values['--run-id'] && values['--candidate-source-sha'],
    'required rules arguments are missing')
  if (command === 'transition') invariant(values['--repository-root'] === undefined,
    'transition does not accept a repository root')
  return {
    command,
    root: values['--root'],
    runId: values['--run-id'],
    candidateSourceSha: values['--candidate-source-sha'],
    repositoryRoot: values['--repository-root'] ?? ROOT,
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH
if (isDirectRun) {
  try {
    const options = parseCli(process.argv.slice(2))
    const result = options.command === 'prepare'
      ? await prepareUpgradeRulesWorkspace(options)
      : await transitionUpgradeFirestoreRules(options)
    console.log(JSON.stringify({
      phase: result.phase,
      projectId: result.projectId,
      baselineRulesSha256: result.baseline.sha256,
      candidateRulesSha256: result.candidate.sha256,
    }))
  } catch (error) {
    console.error(`[upgrade-firestore-rules] FAIL ${error instanceof Error ? error.name : 'UnknownFailure'}`)
    process.exitCode = 1
  }
}
