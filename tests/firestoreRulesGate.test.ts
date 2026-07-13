import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'

interface Step {
  name?: string
  if?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

interface Job {
  needs?: string | string[]
  if?: string
  steps?: Step[]
}

interface Workflow {
  jobs: Record<string, Job>
}

function needs(job: Job | undefined): string[] {
  if (!job?.needs) return []
  return Array.isArray(job.needs) ? job.needs : [job.needs]
}

describe('non-skippable Firestore security gate', () => {
  it('uses the exact lockfile-pinned local firebase-tools CLI and always removes its debug log', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>
      devDependencies: Record<string, string>
    }
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      packages: Record<string, { version?: string; devDependencies?: Record<string, string> }>
    }
    const runner = readFileSync('scripts/run-firestore-rules.mjs', 'utf8')

    expect(pkg.devDependencies['firebase-tools']).toBe('15.23.0')
    expect(lock.packages[''].devDependencies?.['firebase-tools']).toBe('15.23.0')
    expect(lock.packages['node_modules/firebase-tools']?.version).toBe('15.23.0')
    expect(pkg.scripts.test).toContain('--exclude tests/firestoreRulesEmulator.test.ts')
    expect(pkg.scripts['test:firestore-rules']).toBe('node scripts/run-firestore-rules.mjs')
    expect(pkg.scripts.check).toContain('npm run test:firestore-rules')
    expect(runner).toContain("require.resolve('firebase-tools/lib/bin/firebase')")
    expect(runner).toContain('vitest run tests/firestoreRulesEmulator.test.ts')
    expect(runner).toMatch(/finally\s*\{[\s\S]*rmSync\(debugLog, \{ force: true \}\)/)
    expect(runner).toContain('if (existsSync(debugLog))')
    expect(runner).not.toMatch(/npx|--yes/)
  })

  it('runs one Java 21 Ubuntu security gate and makes every build/release consumer depend on it', () => {
    const workflowSource = readFileSync('.github/workflows/build.yml', 'utf8')
    const workflow = load(workflowSource) as Workflow
    const gate = workflow.jobs['security-check']
    const steps = gate?.steps ?? []

    expect(steps.some(step => step.uses === 'actions/setup-java@v4'
      && step.with?.distribution === 'temurin'
      && step.with?.['java-version'] === 21)).toBe(true)
    expect(steps.some(step => step.run?.trim() === 'npm ci')).toBe(true)
    expect(steps.some(step => step.run?.trim() === 'npm run check')).toBe(true)
    expect(steps.some(step => step.if === 'always()'
      && step.run?.includes('rm -f firestore-debug.log')
      && step.run?.includes('test ! -e firestore-debug.log'))).toBe(true)

    const checkSteps = Object.values(workflow.jobs)
      .flatMap(job => job.steps ?? [])
      .filter(step => step.run?.trim() === 'npm run check')
    expect(checkSteps).toHaveLength(1)

    for (const jobName of [
      'build-mac',
      'e2e-mac',
      'e2e-win',
      'release-preflight',
      'package-mac',
      'package-win',
      'release-mac',
      'release-win',
      'publish-release',
    ]) {
      expect(needs(workflow.jobs[jobName]), jobName).toContain('security-check')
    }
  })

  it('preserves tag-only publish and signed dry-run package conditions without always() bypasses', () => {
    const workflow = load(readFileSync('.github/workflows/build.yml', 'utf8')) as Workflow
    const tagOnly = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')"
    const signedPackage = "(github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')) || (github.event_name == 'workflow_dispatch' && inputs.signed_package_dry_run == true)"

    expect(workflow.jobs['release-preflight'].if).toBe(tagOnly)
    expect(workflow.jobs['release-mac'].if).toBe(tagOnly)
    expect(workflow.jobs['release-win'].if).toBe(tagOnly)
    expect(workflow.jobs['publish-release'].if).toBe(tagOnly)
    expect(workflow.jobs['package-mac'].if).toBe(signedPackage)
    expect(workflow.jobs['package-win'].if).toBe(signedPackage)
    for (const job of Object.values(workflow.jobs)) expect(job.if ?? '').not.toContain('always()')
  })
})
