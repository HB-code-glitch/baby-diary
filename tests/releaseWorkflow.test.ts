import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

interface WorkflowStep {
  name?: string
  uses?: string
  run?: unknown
  if?: string
  'continue-on-error'?: unknown
  env?: Record<string, string>
  with?: Record<string, string | number>
  'timeout-minutes'?: number
}

interface WorkflowJob {
  needs?: string | string[]
  'runs-on': string
  if?: string
  'continue-on-error'?: unknown
  steps: WorkflowStep[]
}

interface ReleaseWorkflow {
  name: string
  permissions: Record<string, string>
  concurrency?: {
    group?: string
    'cancel-in-progress'?: boolean
  }
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
  syncExecutable: string
}

const workflowSource = readFileSync('.github/workflows/build.yml', 'utf8')
const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  version?: string
  build?: { publish?: Array<{ provider?: string; releaseType?: string }> }
  scripts?: Record<string, string>
}
// js-yaml v4 uses its YAML 1.2-oriented default schema and rejects duplicate
// mapping keys. It is declared directly so this CI contract does not rely on a
// transitive electron-builder dependency.
const yaml = createRequire(import.meta.url)('js-yaml') as JsYaml

function parseWorkflow(source = workflowSource): ReleaseWorkflow {
  return yaml.load(source) as ReleaseWorkflow
}

const workflow = parseWorkflow()
const REQUIRED_NODE_VERSION = '24.18.0'
const RELEASE_TAG_CONDITION = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')"
const RELEASE_PREFLIGHT_STEP_NAME = 'Verify release tag matches package version'
const RELEASE_UPLOAD_TARGET_STEP_NAME = 'Verify release upload target is absent or a private draft'
const UPGRADE_JOBS = ['upgrade-win', 'upgrade-mac-arm64', 'upgrade-mac-intel']
const REQUIRED_RELEASE_NEEDS = [
  'security-check',
  'release-context',
  'release-preflight',
  'e2e-win',
  'e2e-mac',
  'package-mac',
  'package-win',
  'smoke-mac-arm64',
  'smoke-mac-intel',
  'smoke-win',
  ...UPGRADE_JOBS,
]
const RELEASE_MANIFEST_NEED: Record<string, string> = {
  'release-win': 'manifest-win',
  'release-mac': 'manifest-mac',
}
const REQUIRED_PUBLISH_NEEDS = ['security-check', 'build-mac', 'release-win', 'release-mac']
const RELEASE_CRITICAL_JOBS = [
  'security-check',
  'build-mac',
  'e2e-mac',
  'e2e-win',
  'release-context',
  'release-preflight',
  'baseline-v038',
  'package-mac',
  'package-win',
  ...UPGRADE_JOBS,
  'smoke-mac-arm64',
  'smoke-mac-intel',
  'smoke-win',
  'manifest-mac',
  'manifest-win',
  'release-win',
  'release-mac',
  'publish-release',
] as const

const PACKAGED_E2E_SPECS: PackagedE2ESpec[] = [
  {
    jobName: 'e2e-mac',
    runner: 'macos-latest',
    packageCommand: 'npx electron-builder --mac --dir --universal --publish never',
    executable: '${{ github.workspace }}/release/mac-universal/Baby Diary.app/Contents/MacOS/Baby Diary',
    syncExecutable: '${{ github.workspace }}/release/mac-universal/Baby Diary.app/Contents/MacOS/Baby Diary',
  },
  {
    jobName: 'e2e-win',
    runner: 'windows-latest',
    packageCommand: 'npx electron-builder --win nsis --x64 --publish never',
    executable: '${{ github.workspace }}/release/win-unpacked/Baby Diary.exe',
    syncExecutable: '${{ github.workspace }}/release/win-unpacked/Baby Diary.exe',
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
  const e2eCommands = runCommands.filter(command => command === 'npm run test:e2e')
  const syncE2eCommands = runCommands.filter(command => command === 'npm run test:e2e:sync')
  if (builderCommands.length !== 1 || builderCommands[0] !== spec.packageCommand) {
    errors.push(`packaging must be exactly: ${spec.packageCommand}`)
  }
  if (e2eCommands.length !== 1 || e2eCommands[0] !== 'npm run test:e2e') {
    errors.push('packaged E2E command must be exactly: npm run test:e2e')
  }
  if (syncE2eCommands.length !== 1) {
    errors.push('packaged sync E2E command must be exactly: npm run test:e2e:sync')
  }

  const compileIndex = job.steps.findIndex(step => normalizedRun(step) === 'npm run build')
  const packageIndex = job.steps.findIndex(step => normalizedRun(step) === spec.packageCommand)
  const e2eIndex = job.steps.findIndex(step => normalizedRun(step) === 'npm run test:e2e')
  const syncE2eIndex = job.steps.findIndex(step => normalizedRun(step) === 'npm run test:e2e:sync')
  if (
    compileIndex < 0
    || packageIndex <= compileIndex
    || e2eIndex <= packageIndex
    || syncE2eIndex <= e2eIndex
  ) {
    errors.push('compile, package, packaged E2E, and packaged sync E2E steps must run in order')
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

  const expectedSyncEnv = JSON.stringify({ BABYDIARY_SYNC_E2E_EXECUTABLE: spec.syncExecutable })
  if (syncE2eIndex < 0 || JSON.stringify(job.steps[syncE2eIndex].env) !== expectedSyncEnv) {
    errors.push(`BABYDIARY_SYNC_E2E_EXECUTABLE must target: ${spec.syncExecutable}`)
  }
  if (syncE2eIndex >= 0 && Object.prototype.hasOwnProperty.call(job.steps[syncE2eIndex], 'if')) {
    errors.push('packaged sync E2E execution step must not have an if condition')
  }
  if (syncE2eIndex >= 0 && Boolean(job.steps[syncE2eIndex]['continue-on-error'])) {
    errors.push('packaged sync E2E execution step must not continue on error')
  }
  if (syncE2eIndex >= 0 && job.steps[syncE2eIndex]['timeout-minutes'] !== 12) {
    errors.push('packaged sync E2E execution step must have a 12 minute timeout')
  }

  const javaSteps = job.steps.filter(step => step.uses === 'actions/setup-java@v4')
  if (javaSteps.length !== 1) {
    errors.push('packaged sync E2E job must have exactly one Java setup step')
  } else if (JSON.stringify(javaSteps[0].with) !== JSON.stringify({
    distribution: 'temurin',
    'java-version': 21,
  })) {
    errors.push('packaged sync E2E job must use Temurin Java 21')
  }
  const javaIndex = job.steps.findIndex(step => step.uses === 'actions/setup-java@v4')
  if (javaIndex < 0 || javaIndex >= syncE2eIndex) {
    errors.push('Java 21 must be configured before packaged sync E2E')
  }

  if (Object.prototype.hasOwnProperty.call(job, 'if')) {
    errors.push('packaged E2E job must not have an if condition')
  }
  if (Object.prototype.hasOwnProperty.call(job, 'continue-on-error')) {
    errors.push('packaged E2E job must not declare continue-on-error')
  }
  for (const index of [compileIndex, packageIndex, e2eIndex, syncE2eIndex, javaIndex]) {
    if (index < 0) continue
    const step = job.steps[index]
    if (Object.prototype.hasOwnProperty.call(step, 'if')) {
      errors.push(`required packaged E2E step ${index} must not have an if condition`)
    }
    if (Object.prototype.hasOwnProperty.call(step, 'continue-on-error')) {
      errors.push(`required packaged E2E step ${index} must not declare continue-on-error`)
    }
  }

  const commandText = runCommands.join('\n')
  if (/(?:^|\s)false\s*&&/m.test(commandText)) errors.push('false && no-op detected')
  if (/npm\s+run\s+dev|(?:^|[;&|]\s*)electron\s+\./m.test(commandText)) {
    errors.push('development Electron command detected')
  }
  return errors
}

function nodeRuntimeContractErrors(candidate: ReleaseWorkflow): string[] {
  return Object.entries(candidate.jobs).flatMap(([jobName, job]) => {
    const setupSteps = job.steps.filter(step => step.uses === 'actions/setup-node@v4')
    if (setupSteps.length !== 1) return [`${jobName} must have exactly one setup-node step`]
    return setupSteps[0].with?.['node-version'] === REQUIRED_NODE_VERSION
      ? []
      : [`${jobName} must use Node ${REQUIRED_NODE_VERSION}`]
  })
}

function normalizedNeeds(job: WorkflowJob): string[] {
  if (job.needs == null) return []
  return Array.isArray(job.needs) ? job.needs : [job.needs]
}

function releaseFailOpenContractErrors(candidate: ReleaseWorkflow): string[] {
  const errors: string[] = []
  for (const jobName of RELEASE_CRITICAL_JOBS) {
    const job = candidate.jobs[jobName]
    if (!job) {
      errors.push(`missing ${jobName}`)
      continue
    }
    if (Boolean(job['continue-on-error'])) errors.push(`${jobName} must not continue on error`)
    job.steps.forEach((step, index) => {
      if (Boolean(step['continue-on-error'])) errors.push(`${jobName} step ${index} must not continue on error`)
    })
  }
  return errors
}

function releasePreflightContractErrors(candidate: ReleaseWorkflow): string[] {
  const errors: string[] = []
  const job = candidate.jobs['release-preflight']
  if (!job) return ['missing release-preflight']
  if (job['runs-on'] !== 'ubuntu-latest') errors.push('release-preflight must run on ubuntu-latest')
  if (job.if !== RELEASE_TAG_CONDITION) errors.push('release-preflight must run only for pushed v tags')

  const checkoutIndex = job.steps.findIndex(step => step.uses === 'actions/checkout@v4')
  const validationSteps = job.steps.filter(step => step.name === RELEASE_PREFLIGHT_STEP_NAME)
  if (checkoutIndex < 0) errors.push('release-preflight must check out package.json')
  if (validationSteps.length !== 1) {
    errors.push('release-preflight must have exactly one tag/version validation step')
    return errors
  }

  const validationStep = validationSteps[0]
  const validationIndex = job.steps.indexOf(validationStep)
  if (validationIndex <= checkoutIndex) errors.push('tag/version validation must run after checkout')
  if (validationStep.if != null) errors.push('tag/version validation must not be conditional')
  if (Boolean(validationStep['continue-on-error'])) errors.push('tag/version validation must fail the job')

  const command = normalizedRun(validationStep) ?? ''
  for (const requiredFragment of [
    "require('./package.json')",
    "'v' + version",
    'process.env.GITHUB_REF_NAME',
    'actual !== expected',
    'process.exit(1)',
  ]) {
    if (!command.includes(requiredFragment)) errors.push(`tag/version validation is missing: ${requiredFragment}`)
  }

  const targetValidationSteps = job.steps.filter(step => step.name === RELEASE_UPLOAD_TARGET_STEP_NAME)
  if (targetValidationSteps.length !== 1) {
    errors.push('release-preflight must have exactly one upload-target validation step')
    return errors
  }

  const targetValidationStep = targetValidationSteps[0]
  const targetValidationIndex = job.steps.indexOf(targetValidationStep)
  if (targetValidationIndex <= validationIndex) {
    errors.push('upload-target validation must run after tag/version validation')
  }
  if (targetValidationStep.if != null) errors.push('upload-target validation must not be conditional')
  if (Boolean(targetValidationStep['continue-on-error'])) {
    errors.push('upload-target validation must fail the job')
  }
  if (targetValidationStep.env?.GH_TOKEN !== '${{ secrets.RELEASE_TOKEN }}') {
    errors.push('upload-target validation must authenticate with RELEASE_TOKEN')
  }

  const targetCommand = normalizedRun(targetValidationStep) ?? ''
  for (const requiredFragment of [
    'set -euo pipefail',
    'gh api --paginate --slurp',
    'repos/HB-code-glitch/baby-diary-releases/releases?per_page=100',
    'node scripts/validate-release-assets.mjs --pre-upload',
    '--tag "${GITHUB_REF_NAME}"',
  ]) {
    if (!targetCommand.includes(requiredFragment)) {
      errors.push(`upload-target validation is missing: ${requiredFragment}`)
    }
  }
  if (/releases\/tags\//.test(targetCommand)) {
    errors.push('upload-target validation must use authenticated list releases, not the tag endpoint')
  }
  return errors
}

function releaseGateContractErrors(candidate: ReleaseWorkflow): string[] {
  const errors = releasePreflightContractErrors(candidate)
  const publishCommands: Array<{ jobName: string; command: string }> = []

  for (const [jobName, job] of Object.entries(candidate.jobs)) {
    for (const step of job.steps) {
      const command = normalizedRun(step)
      if (command && (
        /--publish\s+always/.test(command)
        || /gh\s+release\s+upload/.test(command)
        || /node\s+scripts\/upload-release-assets\.mjs/.test(command)
      )) {
        publishCommands.push({ jobName, command })
      }
    }
  }

  for (const jobName of ['release-win', 'release-mac']) {
    const job = candidate.jobs[jobName]
    if (!job) {
      errors.push(`missing ${jobName}`)
      continue
    }
    if (job.if !== RELEASE_TAG_CONDITION) errors.push(`${jobName} must run only for pushed v tags`)
    if (/always\s*\(/.test(job.if ?? '')) errors.push(`${jobName} must not bypass failed or skipped needs`)
    const needs = normalizedNeeds(job)
    const requiredNeeds = [...REQUIRED_RELEASE_NEEDS, RELEASE_MANIFEST_NEED[jobName]]
    if (needs.length !== requiredNeeds.length
      || !requiredNeeds.every(required => needs.includes(required))) {
      errors.push(`${jobName} must need preflight, both unpacked E2E jobs, both package jobs, all installed smoke jobs, and its verified manifest`)
    }
  }

  for (const { jobName } of publishCommands) {
    if (!['release-win', 'release-mac'].includes(jobName)) {
      errors.push(`publish command must not run outside a gated release job: ${jobName}`)
    }
  }
  if (publishCommands.length !== 2) errors.push('expected exactly two gated platform upload commands')
  return errors
}

function releaseTagValidationCode(candidate: ReleaseWorkflow): string | null {
  const step = candidate.jobs['release-preflight']?.steps
    .find(candidateStep => candidateStep.name === RELEASE_PREFLIGHT_STEP_NAME)
  const command = step ? normalizedRun(step) : null
  const match = command?.match(/^node -e "([\s\S]+)"$/)
  return match?.[1] ?? null
}

function releaseProvenanceContractErrors(candidate: ReleaseWorkflow): string[] {
  const errors: string[] = []
  const preflight = candidate.jobs['release-preflight']
  const targetStep = preflight?.steps.find(step => step.name === RELEASE_UPLOAD_TARGET_STEP_NAME)
  const targetCommand = targetStep ? normalizedRun(targetStep) ?? '' : ''
  for (const fragment of [
    'repos/${GITHUB_REPOSITORY}/commits/${GITHUB_REF_NAME}',
    'GITHUB_SHA',
    'node scripts/validate-release-assets.mjs --pre-upload',
    '--source-repository "${GITHUB_REPOSITORY}"',
    '--release-repository "HB-code-glitch/baby-diary-releases"',
    '--sha "${GITHUB_SHA}"',
    '--run-id "${GITHUB_RUN_ID}"',
    '--run-attempt "${GITHUB_RUN_ATTEMPT}"',
    'gh release create',
    '--draft',
    '--notes-file',
  ]) {
    if (!targetCommand.includes(fragment)) errors.push(`prepare draft is missing: ${fragment}`)
  }
  if ((targetCommand.match(/gh\s+release\s+create/g) ?? []).length !== 1) {
    errors.push('prepare draft must have exactly one create transition')
  }

  for (const [jobName, packageJobName, platform, artifactName] of [
    ['release-win', 'package-win', 'windows', 'release-manifest-windows-${{ github.run_id }}-${{ github.run_attempt }}'],
    ['release-mac', 'package-mac', 'mac', 'release-manifest-mac-${{ github.run_id }}-${{ github.run_attempt }}'],
  ] as const) {
    const job = candidate.jobs[jobName]
    if (!job) {
      errors.push(`missing ${jobName}`)
      continue
    }
    const commands = job.steps.flatMap(step => normalizedRun(step) ?? [])
    const commandText = commands.join('\n')
    const packageCommandText = candidate.jobs[packageJobName]?.steps
      .flatMap(step => normalizedRun(step) ?? [])
      .join('\n') ?? ''
    if (!packageCommandText.includes('--publish never')) {
      errors.push(`${packageJobName} is missing: --publish never`)
    }
    for (const fragment of [
      `node scripts/create-release-manifest.mjs --platform ${platform}`,
      '--source-repository "${{ github.repository }}"',
      '--sha "${{ github.sha }}"',
      '--run-id "${{ github.run_id }}"',
      '--run-attempt "${{ github.run_attempt }}"',
      `node scripts/upload-release-assets.mjs --platform ${platform}`,
      '--staging-dir release-upload',
      '--manifest release-manifest/',
    ]) {
      if (!commandText.includes(fragment)) errors.push(`${jobName} is missing: ${fragment}`)
    }
    if (/--publish\s+always/.test(commandText)) errors.push(`${jobName} must not let electron-builder upload`)
    const manifestCreators = job.steps.filter(step => /node\s+scripts\/create-release-manifest\.mjs/.test(normalizedRun(step) ?? ''))
    if (manifestCreators.length !== 1) {
      errors.push(`${jobName} must create one current-run platform manifest`)
    } else {
      const manifestCommand = normalizedRun(manifestCreators[0]) ?? ''
      for (const fragment of [
        `--platform ${platform}`,
        '--source-repository "${{ github.repository }}"',
        '--sha "${{ github.sha }}"',
        '--run-id "${{ github.run_id }}"',
        '--run-attempt "${{ github.run_attempt }}"',
      ]) {
        if (!manifestCommand.includes(fragment)) errors.push(`${jobName} manifest creation is missing: ${fragment}`)
      }
    }
    const manifestUploads = job.steps.filter(step => (
      step.uses === 'actions/upload-artifact@v4'
      && step.with?.name === artifactName
      && step.with?.['if-no-files-found'] === 'error'
    ))
    if (manifestUploads.length !== 1) errors.push(`${jobName} must upload one run-scoped manifest artifact`)
    const releaseUploads = job.steps.filter(step => /node\s+scripts\/upload-release-assets\.mjs/.test(normalizedRun(step) ?? ''))
    if (releaseUploads.length !== 1) errors.push(`${jobName} must upload one exact platform staging set`)
    if (releaseUploads[0]?.env?.GH_TOKEN !== '${{ secrets.RELEASE_TOKEN }}') {
      errors.push(`${jobName} upload must authenticate with RELEASE_TOKEN`)
    }
    const uploadCommand = normalizedRun(releaseUploads[0] ?? {}) ?? ''
    for (const fragment of [
      `--platform ${platform}`,
      '--source-repository "${{ github.repository }}"',
      '--sha "${{ github.sha }}"',
      '--run-id "${{ github.run_id }}"',
      '--run-attempt "${{ github.run_attempt }}"',
    ]) {
      if (!uploadCommand.includes(fragment)) errors.push(`${jobName} immutable upload is missing: ${fragment}`)
    }
  }

  const publish = candidate.jobs['publish-release']
  if (!publish) return [...errors, 'missing publish-release']
  const publishCommands = publish.steps.flatMap(step => normalizedRun(step) ?? [])
  const publishText = publishCommands.join('\n')
  const downloads = publish.steps.filter(step => step.uses === 'actions/download-artifact@v4')
  for (const artifactName of [
    'release-manifest-windows-${{ github.run_id }}-${{ github.run_attempt }}',
    'release-manifest-mac-${{ github.run_id }}-${{ github.run_attempt }}',
  ]) {
    if (!downloads.some(step => step.with?.name === artifactName)) {
      errors.push(`publish-release must download ${artifactName}`)
    }
  }
  for (const fragment of [
    'node scripts/publish-verified-release.mjs',
    '--manifests-dir',
    '--source-repository "${GITHUB_REPOSITORY}"',
    '--release-repository "HB-code-glitch/baby-diary-releases"',
    '--sha "${GITHUB_SHA}"',
    '--run-id "${GITHUB_RUN_ID}"',
    '--run-attempt "${GITHUB_RUN_ATTEMPT}"',
  ]) {
    if (!publishText.includes(fragment)) errors.push(`final provenance gate is missing: ${fragment}`)
  }
  const finalOrchestrators = publish.steps.filter(step => (
    /node\s+scripts\/publish-verified-release\.mjs/.test(normalizedRun(step) ?? '')
  ))
  if (finalOrchestrators.length !== 1) errors.push('publish-release must have one combined final provenance gate')
  if (finalOrchestrators[0]?.env?.GH_TOKEN !== '${{ secrets.RELEASE_TOKEN }}') {
    errors.push('publish-release final provenance gate must authenticate with RELEASE_TOKEN')
  }
  if (publish.if !== RELEASE_TAG_CONDITION || /always\s*\(/.test(publish.if ?? '')) {
    errors.push('publish-release must not bypass failed dependencies')
  }
  for (const dependency of REQUIRED_PUBLISH_NEEDS) {
    if (!normalizedNeeds(publish).includes(dependency)) {
      errors.push(`publish-release must need ${dependency}`)
    }
  }
  return errors
}

function immutableReleaseOrchestrationErrors(candidate: ReleaseWorkflow): string[] {
  const errors: string[] = []
  for (const [jobName, platform, manifestName] of [
    ['release-win', 'windows', 'release-manifest-windows'],
    ['release-mac', 'mac', 'release-manifest-mac'],
  ] as const) {
    const job = candidate.jobs[jobName]
    if (!job) {
      errors.push(`missing ${jobName}`)
      continue
    }
    const orchestrators = job.steps.filter(step => (
      normalizedRun(step)?.includes(`node scripts/upload-release-assets.mjs --platform ${platform}`)
    ))
    if (orchestrators.length !== 1) {
      errors.push(`${jobName} must have exactly one immutable-ID upload orchestrator`)
      continue
    }
    const step = orchestrators[0]
    const command = normalizedRun(step) ?? ''
    for (const fragment of [
      '--manifest',
      '--staging-dir',
      '--source-repository "${{ github.repository }}"',
      '--release-repository "HB-code-glitch/baby-diary-releases"',
      '--tag "${{ needs.release-context.outputs.tag }}"',
      '--sha "${{ github.sha }}"',
      '--run-id "${{ github.run_id }}"',
      '--run-attempt "${{ github.run_attempt }}"',
    ]) {
      if (!command.includes(fragment)) errors.push(`${jobName} upload orchestrator is missing: ${fragment}`)
    }
    if (step.env?.GH_TOKEN !== '${{ secrets.RELEASE_TOKEN }}') {
      errors.push(`${jobName} upload orchestrator must authenticate with RELEASE_TOKEN`)
    }
    if (step.if != null || Object.prototype.hasOwnProperty.call(step, 'continue-on-error')) {
      errors.push(`${jobName} upload orchestrator must be unconditional and fail closed`)
    }
    const orchestratorIndex = job.steps.indexOf(step)
    const manifestIndex = job.steps.findIndex(candidateStep => (
      candidateStep.uses === 'actions/upload-artifact@v4'
      && String(candidateStep.with?.name).startsWith(manifestName)
    ))
    if (manifestIndex <= orchestratorIndex) errors.push(`${jobName} must persist only the post-upload-bound manifest`)
  }

  const allCommands = Object.values(candidate.jobs)
    .flatMap(job => job.steps.flatMap(step => normalizedRun(step) ?? []))
  if (allCommands.some(command => /gh\s+release\s+upload/.test(command))) {
    errors.push('tag-resolved gh release upload must not remain')
  }
  if (allCommands.some(command => /gh\s+release\s+edit/.test(command))) {
    errors.push('separate tag-resolved release edit must not remain')
  }

  const publish = candidate.jobs['publish-release']
  if (!publish) return [...errors, 'missing publish-release']
  const publishSteps = publish.steps.filter(step => (
    normalizedRun(step)?.includes('node scripts/publish-verified-release.mjs')
  ))
  if (publishSteps.length !== 1) {
    errors.push('publish-release must have exactly one validation-and-publish orchestrator')
  } else {
    const step = publishSteps[0]
    const command = normalizedRun(step) ?? ''
    for (const fragment of [
      '--manifests-dir',
      '--source-repository "${GITHUB_REPOSITORY}"',
      '--release-repository "HB-code-glitch/baby-diary-releases"',
      '--tag "${GITHUB_REF_NAME}"',
      '--sha "${GITHUB_SHA}"',
      '--run-id "${GITHUB_RUN_ID}"',
      '--run-attempt "${GITHUB_RUN_ATTEMPT}"',
    ]) {
      if (!command.includes(fragment)) errors.push(`final orchestrator is missing: ${fragment}`)
    }
    if (step.env?.GH_TOKEN !== '${{ secrets.RELEASE_TOKEN }}') {
      errors.push('final orchestrator must authenticate with RELEASE_TOKEN')
    }
    if (step.if != null || Object.prototype.hasOwnProperty.call(step, 'continue-on-error')) {
      errors.push('final orchestrator must be unconditional and fail closed')
    }
  }
  const mutatingSteps = publish.steps.filter(step => {
    const command = normalizedRun(step) ?? ''
    return /publish-verified-release|gh\s+release\s+edit|--draft=false/.test(command)
  })
  if (mutatingSteps.length !== 1) errors.push('final validation and public transition must be one workflow step')
  return errors
}

describe('release workflow CI gates', () => {
  it('binds delivery and release contracts to v0.3.10', () => {
    expect(packageJson.version).toBe('0.3.10')
  })

  it('is valid YAML 1.2 and rejects duplicate mapping keys at nested levels', () => {
    expect(workflow.name).toBe('Build')
    expect(workflow.on).toBeDefined()
    expect(workflow.jobs).toBeDefined()

    const duplicateRunsOn = workflowSource.replace(
      /(  security-check:\r?\n    runs-on: ubuntu-latest)/,
      '$1\n    runs-on: windows-latest',
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

  it('preserves all build, packaged E2E, upgrade-gate, and release jobs', () => {
    expect(new Set(Object.keys(workflow.jobs))).toEqual(new Set([
      'security-check',
      'build-mac',
      'e2e-mac',
      'e2e-win',
      'release-context',
      'release-preflight',
      'baseline-v038',
      'package-mac',
      'package-win',
      ...UPGRADE_JOBS,
      'smoke-mac-arm64',
      'smoke-mac-intel',
      'smoke-win',
      'manifest-mac',
      'manifest-win',
      'release-win',
      'release-mac',
      'publish-release',
    ]))
  })

  it('keeps the security gate and three platform jobs on pull requests', () => {
    const unconditionalJobs = Object.entries(workflow.jobs)
      .filter(([, job]) => job.if == null)
      .map(([jobName]) => jobName)
    const tagOnlyJobs = Object.entries(workflow.jobs)
      .filter(([, job]) => job.if === RELEASE_TAG_CONDITION)
      .map(([jobName]) => jobName)

    expect(new Set(unconditionalJobs)).toEqual(new Set(['security-check', 'build-mac', 'e2e-mac', 'e2e-win']))
    expect(new Set(tagOnlyJobs)).toEqual(new Set(['release-preflight', 'release-win', 'release-mac', 'publish-release']))
  })

  it('cannot silently skip the unsigned Windows packaged recovery smoke', () => {
    const job = workflow.jobs['e2e-win']
    expect(job).toBeDefined()
    expect(job.if).toBeUndefined()
    const checkout = job.steps.find(step => step.uses === 'actions/checkout@v4')
    expect(checkout?.with?.['fetch-depth']).toBe(0)

    const smokeSteps = job.steps.filter(step => (
      normalizedRun(step)?.includes('scripts/windows-installed-release-smoke.ps1')
    ))
    expect(smokeSteps).toHaveLength(1)
    const smokeStep = smokeSteps[0]
    const command = normalizedRun(smokeStep) ?? ''
    expect(command).toContain('-SignaturePolicy AllowUnsigned')
    expect(command).not.toContain('WIN_EXPECTED_PUBLISHER')
    expect(command).not.toContain('WIN_EXPECTED_CERT_SHA256')
    expect(smokeStep.if).toBeUndefined()
    expect(smokeStep['continue-on-error']).toBeUndefined()
    expect(smokeStep['timeout-minutes']).toBe(20)

    const packageIndex = job.steps.findIndex(step => (
      normalizedRun(step) === 'npx electron-builder --win nsis --x64 --publish never'
    ))
    const smokeIndex = job.steps.indexOf(smokeStep)
    expect(packageIndex).toBeGreaterThanOrEqual(0)
    expect(smokeIndex).toBeGreaterThan(packageIndex)

    const signedSmoke = workflow.jobs['smoke-win']?.steps.find(step => (
      normalizedRun(step)?.includes('scripts/windows-installed-release-smoke.ps1')
    ))
    expect(normalizedRun(signedSmoke ?? {})).toContain('-SignaturePolicy RequireTrusted')
  })

  it('serializes same-ref workflow reruns without cancelling an in-flight draft upload', () => {
    expect(workflow.concurrency).toEqual({
      group: '${{ github.workflow }}-${{ github.ref }}',
      'cancel-in-progress': false,
    })
  })

  it('keeps platform uploads private and exposes one final publish transition', () => {
    expect(packageJson.build?.publish).toEqual([{
      provider: 'github',
      owner: 'HB-code-glitch',
      repo: 'baby-diary-releases',
      releaseType: 'draft',
    }])

    const publishJob = workflow.jobs['publish-release']
    expect(publishJob).toBeDefined()
    expect(publishJob?.['runs-on']).toBe('ubuntu-latest')
    expect(publishJob?.if).toBe(RELEASE_TAG_CONDITION)
    expect(new Set(normalizedNeeds(publishJob))).toEqual(new Set(REQUIRED_PUBLISH_NEEDS))
    expect(publishJob?.if).not.toMatch(/always\s*\(/)

    const commands = Object.entries(workflow.jobs).flatMap(([jobName, job]) => job.steps.flatMap(step => {
      const command = normalizedRun(step)
      return command == null ? [] : [{ jobName, command }]
    }))
    const validationCommands = commands.filter(({ command }) => command.includes('validate-release-assets.mjs'))
    const preUploadValidations = validationCommands.filter(({ command }) => command.includes('--pre-upload'))
    const platformOrchestrators = commands.filter(({ command }) => command.includes('upload-release-assets.mjs'))
    const finalOrchestrators = commands.filter(({ command }) => command.includes('publish-verified-release.mjs'))
    const tagResolvedTransitions = commands.filter(({ command }) => /gh\s+release\s+(?:upload|edit)/.test(command))

    expect(validationCommands).toHaveLength(1)
    expect(preUploadValidations).toHaveLength(1)
    expect(preUploadValidations[0].jobName).toBe('release-preflight')
    expect(platformOrchestrators).toHaveLength(2)
    expect(new Set(platformOrchestrators.map(({ jobName }) => jobName))).toEqual(new Set(['release-win', 'release-mac']))
    expect(finalOrchestrators).toHaveLength(1)
    expect(finalOrchestrators[0].jobName).toBe('publish-release')
    expect(tagResolvedTransitions).toHaveLength(0)
  })

  it('rejects job-level and step-level continue-on-error on every release-critical path', () => {
    expect(releaseFailOpenContractErrors(workflow)).toEqual([])

    for (const jobName of RELEASE_CRITICAL_JOBS) {
      const jobMutation = structuredClone(workflow)
      expect(jobMutation.jobs[jobName]).toBeDefined()
      jobMutation.jobs[jobName]['continue-on-error'] = true
      expect(releaseFailOpenContractErrors(jobMutation)).toContain(`${jobName} must not continue on error`)

      const stepMutation = structuredClone(workflow)
      const runStepIndex = stepMutation.jobs[jobName].steps.findIndex(step => normalizedRun(step) != null)
      expect(runStepIndex).toBeGreaterThanOrEqual(0)
      stepMutation.jobs[jobName].steps[runStepIndex]['continue-on-error'] = true
      expect(releaseFailOpenContractErrors(stepMutation)).toContain(`${jobName} step ${runStepIndex} must not continue on error`)
    }
  })

  it('pins every CI and release job to the Electron 43 bundled Node runtime', () => {
    expect(nodeRuntimeContractErrors(workflow)).toEqual([])
  })

  it('rejects reintroducing Node 20 into any workflow job', () => {
    for (const jobName of Object.keys(workflow.jobs)) {
      const mutatedWorkflow = structuredClone(workflow)
      const setupNode = mutatedWorkflow.jobs[jobName].steps.find(step => step.uses === 'actions/setup-node@v4')
      expect(setupNode).toBeDefined()
      setupNode!.with = { ...setupNode!.with, 'node-version': '20' }
      expect(nodeRuntimeContractErrors(mutatedWorkflow)).toContain(`${jobName} must use Node ${REQUIRED_NODE_VERSION}`)
    }
  })

  it.each(PACKAGED_E2E_SPECS)('$jobName builds and launches the packaged platform app', spec => {
    expect(packagedE2EContractErrors(workflow, spec)).toEqual([])
  })

  it('exposes the packaged sync E2E runner as an exact package script', () => {
    expect(packageJson.scripts?.['test:e2e:sync']).toBe('node scripts/sync-e2e.mjs')
  })

  it.each([
    {
      label: 'false && packaging no-op',
      from: 'npx electron-builder --mac --dir --universal --publish never',
      to: 'false && npx electron-builder --mac --dir --universal --publish never',
    },
    { label: 'development Electron', from: 'npm run test:e2e', to: 'electron .' },
    { label: 'successful no-op', from: 'npm run test:e2e', to: 'true' },
    { label: 'sync successful no-op', from: 'npm run test:e2e:sync', to: 'true' },
    { label: 'sync development Electron', from: 'npm run test:e2e:sync', to: 'npm run dev' },
  ])('rejects $label mutations in packaged E2E', ({ from, to }) => {
    const mutatedSource = workflowSource.replace(from, to)
    expect(mutatedSource).not.toBe(workflowSource)
    const mutatedWorkflow = parseWorkflow(mutatedSource)
    expect(packagedE2EContractErrors(mutatedWorkflow, PACKAGED_E2E_SPECS[0])).not.toEqual([])
  })

  it.each([
    { label: 'if false', property: '        if: false' },
    { label: 'continue-on-error true', property: '        continue-on-error: true' },
    { label: 'continue-on-error false', property: '        continue-on-error: false' },
  ])('rejects $label on the packaged E2E execution step', ({ property }) => {
    const mutatedSource = workflowSource.replace(
      /(      - run: npm run test:e2e\r?\n)/,
      `$1${property}\n`,
    )
    expect(mutatedSource).not.toBe(workflowSource)
    const mutatedWorkflow = parseWorkflow(mutatedSource)
    expect(packagedE2EContractErrors(mutatedWorkflow, PACKAGED_E2E_SPECS[0])).not.toEqual([])
  })

  it('runs an exact package-version release-tag preflight after checkout', () => {
    expect(releasePreflightContractErrors(workflow)).toEqual([])
    const validationCode = releaseTagValidationCode(workflow)
    expect(validationCode).not.toBeNull()
    if (!validationCode) return

    const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    const matching = spawnSync(process.execPath, ['-e', validationCode], {
      env: { ...process.env, GITHUB_REF_NAME: `v${packageVersion.version}` },
      encoding: 'utf8',
    })
    const mismatched = spawnSync(process.execPath, ['-e', validationCode], {
      env: { ...process.env, GITHUB_REF_NAME: `v${packageVersion.version}-mismatch` },
      encoding: 'utf8',
    })

    expect(matching.status, matching.stderr).toBe(0)
    expect(mismatched.status).not.toBe(0)
  })

  it.each([
    { label: 'if false', property: '        if: false' },
    { label: 'continue-on-error true', property: '        continue-on-error: true' },
    { label: 'continue-on-error false', property: '        continue-on-error: false' },
  ])('rejects $label on the packaged sync E2E execution step', ({ property }) => {
    const mutatedSource = workflowSource.replace(
      /(      - run: npm run test:e2e:sync\r?\n)/,
      `$1${property}\n`,
    )
    expect(mutatedSource).not.toBe(workflowSource)
    const mutatedWorkflow = parseWorkflow(mutatedSource)
    expect(packagedE2EContractErrors(mutatedWorkflow, PACKAGED_E2E_SPECS[0])).not.toEqual([])
  })

  it.each([
    {
      label: 'missing Java setup',
      mutate: (candidate: ReleaseWorkflow) => {
        candidate.jobs['e2e-mac'].steps = candidate.jobs['e2e-mac'].steps
          .filter(step => step.uses !== 'actions/setup-java@v4')
      },
    },
    {
      label: 'wrong Java distribution',
      mutate: (candidate: ReleaseWorkflow) => {
        const java = candidate.jobs['e2e-mac'].steps.find(step => step.uses === 'actions/setup-java@v4')
        expect(java).toBeDefined()
        java!.with = { distribution: 'zulu', 'java-version': 21 }
      },
    },
    {
      label: 'wrong Java version',
      mutate: (candidate: ReleaseWorkflow) => {
        const java = candidate.jobs['e2e-mac'].steps.find(step => step.uses === 'actions/setup-java@v4')
        expect(java).toBeDefined()
        java!.with = { distribution: 'temurin', 'java-version': 17 }
      },
    },
    {
      label: 'sync before normal packaged E2E',
      mutate: (candidate: ReleaseWorkflow) => {
        const steps = candidate.jobs['e2e-mac'].steps
        const normal = steps.findIndex(step => normalizedRun(step) === 'npm run test:e2e')
        const sync = steps.findIndex(step => normalizedRun(step) === 'npm run test:e2e:sync')
        ;[steps[normal], steps[sync]] = [steps[sync], steps[normal]]
      },
    },
    {
      label: 'wrong sync executable',
      mutate: (candidate: ReleaseWorkflow) => {
        const sync = candidate.jobs['e2e-mac'].steps
          .find(step => normalizedRun(step) === 'npm run test:e2e:sync')
        expect(sync).toBeDefined()
        sync!.env = { BABYDIARY_SYNC_E2E_EXECUTABLE: './node_modules/electron/dist/electron' }
      },
    },
  ])('rejects $label in the sync release-gate contract', ({ mutate }) => {
    const candidate = structuredClone(workflow)
    mutate(candidate)
    expect(packagedE2EContractErrors(candidate, PACKAGED_E2E_SPECS[0])).not.toEqual([])
  })

  it.each(PACKAGED_E2E_SPECS)('$jobName rejects conditional or fail-open build, package, Java, and both E2E steps', spec => {
    const requiredSteps = [
      (step: WorkflowStep) => step.uses === 'actions/setup-java@v4',
      (step: WorkflowStep) => normalizedRun(step) === 'npm run build',
      (step: WorkflowStep) => normalizedRun(step) === spec.packageCommand,
      (step: WorkflowStep) => normalizedRun(step) === 'npm run test:e2e',
      (step: WorkflowStep) => normalizedRun(step) === 'npm run test:e2e:sync',
    ]
    for (const findStep of requiredSteps) {
      for (const property of ['if', 'continue-on-error'] as const) {
        const candidate = structuredClone(workflow)
        const step = candidate.jobs[spec.jobName].steps.find(findStep)
        expect(step).toBeDefined()
        if (property === 'if') step!.if = 'false'
        else step!['continue-on-error'] = false
        expect(packagedE2EContractErrors(candidate, spec)).not.toEqual([])
      }
    }
  })

  it('checks the authenticated external release state before either platform upload', () => {
    expect(releasePreflightContractErrors(workflow)).toEqual([])

    const preflight = workflow.jobs['release-preflight']
    const localValidationIndex = preflight.steps.findIndex(step => step.name === RELEASE_PREFLIGHT_STEP_NAME)
    const targetValidationIndex = preflight.steps.findIndex(step => step.name === RELEASE_UPLOAD_TARGET_STEP_NAME)
    expect(targetValidationIndex).toBeGreaterThan(localValidationIndex)

    for (const jobName of ['release-win', 'release-mac']) {
      expect(normalizedNeeds(workflow.jobs[jobName])).toContain('release-preflight')
    }
  })

  it('rejects fail-open conditions around the external release preflight', () => {
    const jobContinue = structuredClone(workflow)
    jobContinue.jobs['release-preflight']['continue-on-error'] = true
    expect(releaseFailOpenContractErrors(jobContinue)).toContain(
      'release-preflight must not continue on error',
    )

    const stepContinue = structuredClone(workflow)
    const targetStep = stepContinue.jobs['release-preflight'].steps
      .find(step => step.name === RELEASE_UPLOAD_TARGET_STEP_NAME)
    expect(targetStep).toBeDefined()
    targetStep!['continue-on-error'] = true
    expect(releasePreflightContractErrors(stepContinue)).toContain(
      'upload-target validation must fail the job',
    )

    const stepAlways = structuredClone(workflow)
    const alwaysTargetStep = stepAlways.jobs['release-preflight'].steps
      .find(step => step.name === RELEASE_UPLOAD_TARGET_STEP_NAME)
    expect(alwaysTargetStep).toBeDefined()
    alwaysTargetStep!.if = 'always()'
    expect(releasePreflightContractErrors(stepAlways)).toContain(
      'upload-target validation must not be conditional',
    )

    const jobAlways = structuredClone(workflow)
    jobAlways.jobs['release-preflight'].if = `${RELEASE_TAG_CONDITION} && always()`
    expect(releasePreflightContractErrors(jobAlways)).not.toEqual([])

    const noPipefail = structuredClone(workflow)
    const noPipefailTargetStep = noPipefail.jobs['release-preflight'].steps
      .find(step => step.name === RELEASE_UPLOAD_TARGET_STEP_NAME)
    expect(noPipefailTargetStep).toBeDefined()
    noPipefailTargetStep!.run = normalizedRun(noPipefailTargetStep!)?.replace('set -euo pipefail\n', '')
    expect(releasePreflightContractErrors(noPipefail)).toContain(
      'upload-target validation is missing: set -euo pipefail',
    )
  })

  it.each(['release-win', 'release-mac'])('$jobName waits for preflight and both packaged E2E jobs', jobName => {
    const releaseJob = workflow.jobs[jobName]
    expect(new Set(normalizedNeeds(releaseJob))).toEqual(new Set([
      ...REQUIRED_RELEASE_NEEDS,
      RELEASE_MANIFEST_NEED[jobName],
    ]))
    expect(releaseJob.if).toBe(RELEASE_TAG_CONDITION)
    expect(releaseJob.if).not.toMatch(/always\s*\(/)
  })

  it('makes preflight failure block every publish command', () => {
    expect(releaseGateContractErrors(workflow)).toEqual([])

    const bypassedPreflight = structuredClone(workflow)
    const validationStep = bypassedPreflight.jobs['release-preflight'].steps
      .find(step => step.name === RELEASE_PREFLIGHT_STEP_NAME)
    expect(validationStep).toBeDefined()
    validationStep!['continue-on-error'] = true
    expect(releaseGateContractErrors(bypassedPreflight)).not.toEqual([])

    const missingNeed = structuredClone(workflow)
    missingNeed.jobs['release-win'].needs = ['e2e-win', 'e2e-mac']
    expect(releaseGateContractErrors(missingNeed)).not.toEqual([])

    const alwaysBypass = structuredClone(workflow)
    alwaysBypass.jobs['release-mac'].if = `${RELEASE_TAG_CONDITION} && always()`
    expect(releaseGateContractErrors(alwaysBypass)).not.toEqual([])
  })

  it('binds draft preparation, platform manifests, remote bytes, and final publication to one run', () => {
    expect(releaseProvenanceContractErrors(workflow)).toEqual([])
  })

  it('rejects release provenance dependency and bypass mutations', () => {
    const missingPreflight = structuredClone(workflow)
    missingPreflight.jobs['release-win'].needs = ['e2e-win', 'e2e-mac']
    expect(releaseGateContractErrors(missingPreflight)).not.toEqual([])

    const missingManifest = structuredClone(workflow)
    missingManifest.jobs['publish-release'].steps = missingManifest.jobs['publish-release'].steps
      .filter(step => step.with?.name !== 'release-manifest-mac-${{ github.run_id }}-${{ github.run_attempt }}')
    expect(releaseProvenanceContractErrors(missingManifest)).toContain(
      'publish-release must download release-manifest-mac-${{ github.run_id }}-${{ github.run_attempt }}',
    )

    const staleSha = structuredClone(workflow)
    const macManifest = staleSha.jobs['release-mac'].steps
      .find(step => (normalizedRun(step) ?? '').includes('create-release-manifest.mjs'))
    expect(macManifest).toBeDefined()
    macManifest!.run = (normalizedRun(macManifest!) ?? '').replace(
      '--sha "${{ github.sha }}"',
      `--sha "${'f'.repeat(40)}"`,
    )
    expect(releaseProvenanceContractErrors(staleSha)).not.toEqual([])

    const alwaysPublish = structuredClone(workflow)
    alwaysPublish.jobs['publish-release'].if = `${RELEASE_TAG_CONDITION} && always()`
    expect(releaseProvenanceContractErrors(alwaysPublish)).toContain(
      'publish-release must not bypass failed dependencies',
    )
  })

  it('uses immutable release-ID orchestrators for both uploads and the single final transition', () => {
    expect(immutableReleaseOrchestrationErrors(workflow)).toEqual([])
  })

  it('rejects tag-resolved upload, split final publish, and token bypass mutations', () => {
    const tagUpload = structuredClone(workflow)
    tagUpload.jobs['release-win'].steps.push({
      run: 'gh release upload "${GITHUB_REF_NAME}" release-upload/* --clobber',
    })
    expect(immutableReleaseOrchestrationErrors(tagUpload)).toContain('tag-resolved gh release upload must not remain')

    const splitPublish = structuredClone(workflow)
    splitPublish.jobs['publish-release'].steps.push({
      run: 'gh release edit "${GITHUB_REF_NAME}" --draft=false --latest',
    })
    expect(immutableReleaseOrchestrationErrors(splitPublish)).toEqual(expect.arrayContaining([
      'separate tag-resolved release edit must not remain',
      'final validation and public transition must be one workflow step',
    ]))

    const wrongToken = structuredClone(workflow)
    const upload = wrongToken.jobs['release-mac'].steps
      .find(step => normalizedRun(step)?.includes('upload-release-assets.mjs'))
    expect(upload).toBeDefined()
    if (upload) upload.env = { GH_TOKEN: '${{ github.token }}' }
    expect(immutableReleaseOrchestrationErrors(wrongToken)).toContain(
      'release-mac upload orchestrator must authenticate with RELEASE_TOKEN',
    )
  })
})
