import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

interface WorkflowStep {
  uses?: string
  run?: unknown
  if?: string
  'continue-on-error'?: unknown
  env?: Record<string, string>
}

interface WorkflowJob {
  needs?: string | string[]
  'runs-on': string
  if?: string
  steps: WorkflowStep[]
}

interface ReleaseWorkflow {
  name: string
  permissions: Record<string, string>
  on: {
    push: { branches: string[]; tags: string[] }
    pull_request: { branches: string[] }
    workflow_dispatch: null | Record<string, unknown>
  }
  jobs: Record<string, WorkflowJob>
}

interface JsYaml {
  load(source: string): unknown
}

interface PackagedE2ESpec {
  jobName: string
  runner: string
  packageCommand: string
  executable: string
}

const workflowSource = readFileSync('.github/workflows/build.yml', 'utf8')
// js-yaml v4 uses its YAML 1.2-oriented default schema and rejects duplicate
// mapping keys. It is declared directly so this CI contract does not rely on a
// transitive electron-builder dependency.
const yaml = createRequire(import.meta.url)('js-yaml') as JsYaml

function parseWorkflow(source = workflowSource): ReleaseWorkflow {
  return yaml.load(source) as ReleaseWorkflow
}

const workflow = parseWorkflow()

const PACKAGED_E2E_SPECS: PackagedE2ESpec[] = [
  {
    jobName: 'e2e-mac',
    runner: 'macos-latest',
    packageCommand: 'npx electron-builder --mac --dir --universal --publish never',
    executable: '${{ github.workspace }}/release/mac-universal/Baby Diary.app/Contents/MacOS/Baby Diary',
  },
  {
    jobName: 'e2e-win',
    runner: 'windows-latest',
    packageCommand: 'npx electron-builder --win --dir --x64 --publish never',
    executable: '${{ github.workspace }}/release/win-unpacked/Baby Diary.exe',
  },
]

function normalizedRun(step: WorkflowStep): string | null {
  if (step.run == null) return null
  return typeof step.run === 'string' ? step.run.trim() : String(step.run)
}

function packagedE2EContractErrors(candidate: ReleaseWorkflow, spec: PackagedE2ESpec): string[] {
  const errors: string[] = []
  const job = candidate.jobs[spec.jobName]
  if (!job) return [`missing ${spec.jobName}`]
  if (job['runs-on'] !== spec.runner) errors.push(`wrong runner: ${job['runs-on']}`)

  const runCommands = job.steps.flatMap(step => {
    const command = normalizedRun(step)
    return command == null ? [] : [command]
  })
  const builderCommands = runCommands.filter(command => command.includes('electron-builder'))
  const e2eCommands = runCommands.filter(command => command.includes('test:e2e'))
  if (builderCommands.length !== 1 || builderCommands[0] !== spec.packageCommand) {
    errors.push(`packaging must be exactly: ${spec.packageCommand}`)
  }
  if (e2eCommands.length !== 1 || e2eCommands[0] !== 'npm run test:e2e') {
    errors.push('packaged E2E command must be exactly: npm run test:e2e')
  }

  const compileIndex = job.steps.findIndex(step => normalizedRun(step) === 'npm run build')
  const packageIndex = job.steps.findIndex(step => normalizedRun(step) === spec.packageCommand)
  const e2eIndex = job.steps.findIndex(step => normalizedRun(step) === 'npm run test:e2e')
  if (compileIndex < 0 || packageIndex <= compileIndex || e2eIndex <= packageIndex) {
    errors.push('compile, package, and packaged E2E steps must run in order')
  }

  const expectedEnv = JSON.stringify({ BABYDIARY_E2E_EXECUTABLE: spec.executable })
  if (e2eIndex < 0 || JSON.stringify(job.steps[e2eIndex].env) !== expectedEnv) {
    errors.push(`BABYDIARY_E2E_EXECUTABLE must target: ${spec.executable}`)
  }
  if (e2eIndex >= 0 && Object.prototype.hasOwnProperty.call(job.steps[e2eIndex], 'if')) {
    errors.push('packaged E2E execution step must not have an if condition')
  }
  if (e2eIndex >= 0 && Boolean(job.steps[e2eIndex]['continue-on-error'])) {
    errors.push('packaged E2E execution step must not continue on error')
  }

  const commandText = runCommands.join('\n')
  if (/(?:^|\s)false\s*&&/m.test(commandText)) errors.push('false && no-op detected')
  if (/npm\s+run\s+dev|(?:^|[;&|]\s*)electron\s+\./m.test(commandText)) {
    errors.push('development Electron command detected')
  }
  return errors
}

describe('release workflow CI gates', () => {
  it('is valid YAML 1.2 and rejects duplicate mapping keys at nested levels', () => {
    expect(workflow.name).toBe('Build')
    expect(workflow.on).toBeDefined()
    expect(workflow.jobs).toBeDefined()

    const duplicateRunsOn = workflowSource.replace(
      /(  e2e-win:\r?\n    runs-on: windows-latest)/,
      '$1\n    runs-on: ubuntu-latest',
    )
    expect(duplicateRunsOn).not.toBe(workflowSource)
    expect(() => parseWorkflow(duplicateRunsOn)).toThrow(/duplicated mapping key/i)
  })

  it('preserves push branch/tag and manual triggers while adding pull requests', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect(new Set(workflow.on.push.branches)).toEqual(new Set(['master', 'main']))
    expect(workflow.on.push.tags).toEqual(['v*'])
    expect(new Set(workflow.on.pull_request.branches)).toEqual(new Set(['master', 'main']))
    expect(workflow.on).toHaveProperty('workflow_dispatch')
  })

  it('grants the workflow only read access to repository contents', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(Object.values(workflow.permissions)).not.toContain('write')
  })

  it('preserves all build, packaged E2E, and release jobs', () => {
    expect(new Set(Object.keys(workflow.jobs))).toEqual(new Set([
      'build-mac',
      'e2e-mac',
      'e2e-win',
      'release-win',
      'release-mac',
    ]))
  })

  it.each(PACKAGED_E2E_SPECS)('$jobName builds and launches the packaged platform app', spec => {
    expect(packagedE2EContractErrors(workflow, spec)).toEqual([])
  })

  it.each([
    {
      label: 'false && packaging no-op',
      from: 'npx electron-builder --mac --dir --universal --publish never',
      to: 'false && npx electron-builder --mac --dir --universal --publish never',
    },
    { label: 'development Electron', from: 'npm run test:e2e', to: 'electron .' },
    { label: 'successful no-op', from: 'npm run test:e2e', to: 'true' },
  ])('rejects $label mutations in packaged E2E', ({ from, to }) => {
    const mutatedSource = workflowSource.replace(from, to)
    expect(mutatedSource).not.toBe(workflowSource)
    const mutatedWorkflow = parseWorkflow(mutatedSource)
    expect(packagedE2EContractErrors(mutatedWorkflow, PACKAGED_E2E_SPECS[0])).not.toEqual([])
  })

  it.each([
    { label: 'if false', property: '        if: false' },
    { label: 'continue-on-error true', property: '        continue-on-error: true' },
  ])('rejects $label on the packaged E2E execution step', ({ property }) => {
    const mutatedSource = workflowSource.replace(
      /(      - run: npm run test:e2e\r?\n)/,
      `$1${property}\n`,
    )
    expect(mutatedSource).not.toBe(workflowSource)
    const mutatedWorkflow = parseWorkflow(mutatedSource)
    expect(packagedE2EContractErrors(mutatedWorkflow, PACKAGED_E2E_SPECS[0])).not.toEqual([])
  })

  it.each([
    { jobName: 'release-win', e2eJob: 'e2e-win' },
    { jobName: 'release-mac', e2eJob: 'e2e-mac' },
  ])('$jobName runs only for v tags after its packaged E2E gate', ({ jobName, e2eJob }) => {
    const releaseJob = workflow.jobs[jobName]
    expect(releaseJob.needs).toBe(e2eJob)
    expect(releaseJob.if).toBe("startsWith(github.ref, 'refs/tags/v')")
  })
})
