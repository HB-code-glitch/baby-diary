import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PRODUCTION_PROJECT_ID = 'baby-diary-jaei-2026'
export const PRODUCTION_RULESET_ID = 'd884dc4c-e702-4451-aa42-76d961012d75'
export const PRODUCTION_RULES_SHA256 = 'cbd10fb1c0d8ce1a46f64d912d8bcf1d9f606521273ffb8d63760cabe241d770'
export const LOCAL_RULES_CANONICAL_SHA256 = '366bc77d7a40dbd492793604ad7f8bd9d8908475a2c692abf0d8dd009dfe6995'
export const REQUIRED_RULE_ANCHORS = Object.freeze([
  'match /users/{uid}',
  'match /invites/{code}',
  'match /families/{familyId}',
  'match /babyInfoMutations/{mutationDocId}',
  'match /joinProofs/{uid}',
  'match /capabilities/{code}',
])

const require = createRequire(import.meta.url)

class ParityFailure extends Error {
  constructor(code, metadata) {
    super(code)
    this.code = code
    this.metadata = metadata
  }
}

export async function readActiveFirestoreRules(projectId) {
  const auth = require('firebase-tools/lib/auth')
  const { requireAuth } = require('firebase-tools/lib/requireAuth')
  const rules = require('firebase-tools/lib/gcp/rules')
  const options = { project: projectId, projectId, nonInteractive: true }
  const account = auth.getProjectDefaultAccount(process.cwd())

  if (account) auth.setActiveAccount(options, account)
  await requireAuth(options)

  const releases = await rules.listAllReleases(projectId)
  const rulesetName = await rules.getLatestRulesetName(projectId, 'cloud.firestore', releases)
  if (!rulesetName) throw new ParityFailure('no-active-ruleset', { project: projectId })

  const files = await rules.getRulesetContent(rulesetName)
  return { projectId, rulesetName, files }
}

export async function readLocalFirestoreRules() {
  return readFile(resolve(process.cwd(), 'firestore.rules'), 'utf8')
}

function digestRules(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function canonicalizeLineEndings(content) {
  return content.replace(/\r\n?/g, '\n')
}

function validateRulesSource(content, expectedSha256, hashCode, anchorCode, options = {}) {
  if (typeof content !== 'string') throw new ParityFailure('unexpected-rules-source')
  const sourceForDigest = options.canonicalLineEndings ? canonicalizeLineEndings(content) : content
  const sha256 = digestRules(sourceForDigest)
  if (sha256 !== expectedSha256) throw new ParityFailure(hashCode, { sha256 })
  if (REQUIRED_RULE_ANCHORS.some(anchor => !content.includes(anchor))) {
    throw new ParityFailure(anchorCode, { sha256 })
  }
  return sha256
}

export async function runLocalRulesGate(options = {}) {
  const expectedSha256 = options.expectedSha256 ?? LOCAL_RULES_CANONICAL_SHA256
  const loadLocalRules = options.loadLocalRules ?? readLocalFirestoreRules
  const stdout = options.stdout ?? console.log
  const stderr = options.stderr ?? console.error

  try {
    const sha256 = validateRulesSource(
      await loadLocalRules(),
      expectedSha256,
      'hash-mismatch',
      'missing-required-anchor',
      { canonicalLineEndings: true },
    )
    stdout(JSON.stringify({ sha256 }))
    return 0
  } catch (error) {
    const code = error instanceof ParityFailure ? error.code : 'read-failed'
    stderr(`local-rules-gate: ${code}`)
    return 1
  }
}

export async function runProductionRulesParity(options = {}) {
  const projectId = options.projectId ?? PRODUCTION_PROJECT_ID
  const expectedRulesetId = options.expectedRulesetId ?? PRODUCTION_RULESET_ID
  const expectedSha256 = options.expectedSha256 ?? PRODUCTION_RULES_SHA256
  const expectedLocalSha256 = options.expectedLocalSha256
    ?? (options.expectedSha256 === undefined ? LOCAL_RULES_CANONICAL_SHA256 : expectedSha256)
  const loadLocalRules = options.loadLocalRules ?? readLocalFirestoreRules
  const loadActiveRules = options.loadActiveRules ?? readActiveFirestoreRules
  const stdout = options.stdout ?? console.log
  const stderr = options.stderr ?? console.error

  try {
    validateRulesSource(
      await loadLocalRules(),
      expectedLocalSha256,
      'local-hash-mismatch',
      'local-missing-required-anchor',
      { canonicalLineEndings: true },
    )
    const active = await loadActiveRules(projectId)
    const rulesetId = active.rulesetName?.split('/').at(-1) ?? ''
    if (!Array.isArray(active.files) || active.files.length !== 1 || typeof active.files[0]?.content !== 'string') {
      throw new ParityFailure('unexpected-rules-source', { project: projectId, ruleset: rulesetId })
    }

    const sha256 = digestRules(active.files[0].content)
    const metadata = { project: projectId, ruleset: rulesetId, sha256 }
    if (rulesetId !== expectedRulesetId) throw new ParityFailure('ruleset-mismatch', metadata)
    if (sha256 !== expectedSha256) throw new ParityFailure('hash-mismatch', metadata)
    validateRulesSource(
      active.files[0].content,
      expectedSha256,
      'hash-mismatch',
      'remote-missing-required-anchor',
    )

    stdout(JSON.stringify(metadata))
    return 0
  } catch (error) {
    const code = error instanceof ParityFailure ? error.code : 'read-failed'
    stderr(`production-rules-parity: ${code}`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  process.exitCode = process.argv.includes('--local-only')
    ? await runLocalRulesGate()
    : await runProductionRulesParity()
}
