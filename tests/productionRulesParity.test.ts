import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const modulePromise = existsSync('scripts/verify-production-rules.mjs')
  ? import('../scripts/verify-production-rules.mjs')
  : Promise.resolve({})

type ActiveRules = {
  projectId: string
  rulesetName: string
  files: Array<{ name: string; content: string }>
}

type RunOptions = {
  projectId: string
  expectedRulesetId: string
  expectedSha256: string
  expectedLocalSha256?: string
  loadLocalRules: () => Promise<string>
  loadActiveRules: (projectId: string) => Promise<ActiveRules>
  stdout: (line: string) => void
  stderr: (line: string) => void
}

type ParityModule = {
  runProductionRulesParity?: (options: RunOptions) => Promise<number>
  runLocalRulesGate?: (options: Omit<RunOptions, 'projectId' | 'expectedRulesetId' | 'loadActiveRules'>) => Promise<number>
}

const validRulesContent = [
  "rules_version = '2';",
  'service cloud.firestore {',
  'match /databases/{database}/documents {',
  'match /users/{uid} {}',
  'match /invites/{code} {}',
  'match /joinProofs/{uid} { match /capabilities/{code} {} }',
  'match /families/{familyId} { match /babyInfoMutations/{mutationDocId} {} }',
  '}',
  '}',
  '',
].join('\n')

async function command() {
  const loaded = await modulePromise as ParityModule
  expect(loaded.runProductionRulesParity).toBeTypeOf('function')
  return loaded.runProductionRulesParity!
}

describe('production Firestore rules parity command', () => {
  it('prints only project/ruleset/hash metadata after read-only active rules loading', async () => {
    const content = validRulesContent
    const hash = createHash('sha256').update(content).digest('hex')
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await (await command())({
      projectId: 'project-1',
      expectedRulesetId: 'ruleset-1',
      expectedSha256: hash,
      loadLocalRules: async () => content,
      loadActiveRules: async projectId => ({
        projectId,
        rulesetName: `projects/${projectId}/rulesets/ruleset-1`,
        files: [{ name: 'firestore.rules', content }],
      }),
      stdout: line => stdout.push(line),
      stderr: line => stderr.push(line),
    })

    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0])).toEqual({ project: 'project-1', ruleset: 'ruleset-1', sha256: hash })
    expect(stdout[0]).not.toContain(content)
    expect(stdout[0].toLowerCase()).not.toContain('token')
  })

  it('returns nonzero and never prints rules content when the exact content hash mismatches', async () => {
    const content = validRulesContent
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await (await command())({
      projectId: 'project-1',
      expectedRulesetId: 'ruleset-1',
      expectedSha256: '0'.repeat(64),
      expectedLocalSha256: createHash('sha256').update(content).digest('hex'),
      loadLocalRules: async () => content,
      loadActiveRules: async projectId => ({
        projectId,
        rulesetName: `projects/${projectId}/rulesets/ruleset-1`,
        files: [{ name: 'firestore.rules', content }],
      }),
      stdout: line => stdout.push(line),
      stderr: line => stderr.push(line),
    })

    expect(exitCode).not.toBe(0)
    expect(stdout).toEqual([])
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toContain('hash-mismatch')
    expect(stderr[0]).not.toContain(content)
    expect(stderr[0].toLowerCase()).not.toContain('token')
  })

  it('fails closed when the checked-in rules bytes drift from the pinned production hash', async () => {
    const content = validRulesContent
    const remoteHash = createHash('sha256').update(content).digest('hex')
    const stderr: string[] = []

    const exitCode = await (await command())({
      projectId: 'project-1',
      expectedRulesetId: 'ruleset-1',
      expectedSha256: remoteHash,
      loadLocalRules: async () => `${content}// local drift\n`,
      loadActiveRules: async projectId => ({
        projectId,
        rulesetName: `projects/${projectId}/rulesets/ruleset-1`,
        files: [{ name: 'firestore.rules', content }],
      }),
      stdout: () => undefined,
      stderr: line => stderr.push(line),
    })

    expect(exitCode).toBe(1)
    expect(stderr).toEqual(['production-rules-parity: local-hash-mismatch'])
  })

  it('rejects a hash-matching source that omits a required family-sync rule anchor', async () => {
    const content = validRulesContent.replace('match /babyInfoMutations/{mutationDocId} {}', '')
    const hash = createHash('sha256').update(content).digest('hex')
    const stderr: string[] = []

    const loaded = await modulePromise as ParityModule
    expect(loaded.runLocalRulesGate).toBeTypeOf('function')
    const exitCode = await loaded.runLocalRulesGate!({
      expectedSha256: hash,
      loadLocalRules: async () => content,
      stdout: () => undefined,
      stderr: line => stderr.push(line),
    })

    expect(exitCode).toBe(1)
    expect(stderr).toEqual(['local-rules-gate: missing-required-anchor'])
  })

  it('rejects active production content that omits a required family-sync rule anchor', async () => {
    const remoteContent = validRulesContent.replace('match /joinProofs/{uid}', 'match /otherProofs/{uid}')
    const remoteHash = createHash('sha256').update(remoteContent).digest('hex')
    const localHash = createHash('sha256').update(validRulesContent).digest('hex')
    const stderr: string[] = []

    const exitCode = await (await command())({
      projectId: 'project-1',
      expectedRulesetId: 'ruleset-1',
      expectedSha256: remoteHash,
      expectedLocalSha256: localHash,
      loadLocalRules: async () => validRulesContent,
      loadActiveRules: async projectId => ({
        projectId,
        rulesetName: `projects/${projectId}/rulesets/ruleset-1`,
        files: [{ name: 'firestore.rules', content: remoteContent }],
      }),
      stdout: () => undefined,
      stderr: line => stderr.push(line),
    })

    expect(exitCode).toBe(1)
    expect(stderr).toEqual(['production-rules-parity: remote-missing-required-anchor'])
  })
})
