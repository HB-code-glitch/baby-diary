import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  V038_RULES_EVIDENCE,
  prepareUpgradeRulesWorkspace,
  transitionUpgradeFirestoreRules,
} from '../scripts/upgrade-firestore-rules.mjs'

const roots: string[] = []
const RUN_ID = '89abcdef0123456789abcdef01234567'
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

function rulesRoot() {
  const parent = mkdtempSync(join(tmpdir(), 'baby-diary-rules-test-'))
  roots.push(parent)
  return join(parent, `baby-diary-upgrade-rules-${RUN_ID}`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Each test spawns real git subprocesses to materialize SHA-pinned blobs; under
// full-suite parallel load the default 5s per-test timeout flakes, so every test
// in this suite carries an explicit 30s budget.
const GIT_MATERIALIZE_TIMEOUT_MS = 30_000

describe('published upgrade Firestore rules transition', () => {
  it('materializes only the SHA-pinned v0.3.8 blob and candidate commit blob in a run-owned config', async () => {
    const root = rulesRoot()
    const candidateSourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
    }).trim()
    const manifest = await prepareUpgradeRulesWorkspace({
      root,
      runId: RUN_ID,
      candidateSourceSha,
      repositoryRoot: resolve(import.meta.dirname, '..'),
    })

    expect(manifest).toMatchObject({
      version: 1,
      projectId: 'demo-baby-diary',
      runId: RUN_ID,
      phase: 'baseline',
      baseline: V038_RULES_EVIDENCE,
      candidate: { sourceCommit: candidateSourceSha },
    })
    const active = readFileSync(join(root, 'firestore.rules'))
    const candidate = readFileSync(join(root, 'candidate.rules'))
    expect(sha256(active)).toBe(V038_RULES_EVIDENCE.sha256)
    expect(sha256(candidate)).toBe(manifest.candidate.sha256)
    expect(active.equals(candidate)).toBe(false)
    expect(JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8'))).toMatchObject({
      firestore: { database: '(default)', rules: 'firestore.rules' },
      emulators: {
        auth: { host: '127.0.0.1', port: 9099 },
        firestore: { host: '127.0.0.1', port: 8080 },
        ui: { enabled: false },
        singleProjectMode: true,
      },
    })
  }, GIT_MATERIALIZE_TIMEOUT_MS)

  it('atomically switches only after baseline allow/deny probes and records candidate allow/deny proof', async () => {
    const root = rulesRoot()
    const candidateSourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
    }).trim()
    const prepared = await prepareUpgradeRulesWorkspace({
      root,
      runId: RUN_ID,
      candidateSourceSha,
      repositoryRoot: resolve(import.meta.dirname, '..'),
    })
    const baselineBytes = readFileSync(join(root, 'firestore.rules'))
    const candidateBytes = readFileSync(join(root, 'candidate.rules'))
    const probe = vi.fn(async ({ activateCandidate }: { activateCandidate: () => Promise<void> }) => {
      expect(readFileSync(join(root, 'firestore.rules')).equals(baselineBytes)).toBe(true)
      await activateCandidate()
      expect(readFileSync(join(root, 'firestore.rules')).equals(candidateBytes)).toBe(true)
      return {
        baseline: { legacyWrite: 200, modernBabyMutation: 403 },
        candidate: { legacyWrite: 403, modernBabyMutation: 200 },
      }
    })

    const transitioned = await transitionUpgradeFirestoreRules({
      root,
      runId: RUN_ID,
      candidateSourceSha,
    }, { runRulesTransitionSentinel: probe })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(transitioned).toMatchObject({
      ...prepared,
      phase: 'candidate',
      rulesTransition: {
        baseline: { legacyWrite: 200, modernBabyMutation: 403 },
        candidate: { legacyWrite: 403, modernBabyMutation: 200 },
      },
    })
  }, GIT_MATERIALIZE_TIMEOUT_MS)

  it('refuses a tampered candidate rules file before activating it', async () => {
    const root = rulesRoot()
    const candidateSourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
    }).trim()
    await prepareUpgradeRulesWorkspace({
      root,
      runId: RUN_ID,
      candidateSourceSha,
      repositoryRoot: resolve(import.meta.dirname, '..'),
    })
    writeFileSync(join(root, 'candidate.rules'), 'rules_version = \'2\';\nservice cloud.firestore { match /databases/{d}/documents { match /{x=**} { allow read, write: if true; } } }\n')

    await expect(transitionUpgradeFirestoreRules({ root, runId: RUN_ID, candidateSourceSha }, {
      runRulesTransitionSentinel: vi.fn(),
    })).rejects.toThrow(/candidate rules.*hash|tamper/i)
  }, GIT_MATERIALIZE_TIMEOUT_MS)
})
