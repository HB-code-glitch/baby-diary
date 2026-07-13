import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

type Step = {
  name?: string
  uses?: string
  run?: string
  if?: string
  env?: Record<string, string>
  with?: Record<string, string | number | boolean>
  'continue-on-error'?: unknown
}

type Job = {
  needs?: string | string[]
  if?: string
  environment?: string
  'runs-on': string
  outputs?: Record<string, string>
  steps: Step[]
  'continue-on-error'?: unknown
}

type Workflow = {
  on: {
    workflow_dispatch?: {
      inputs?: Record<string, { type?: string; required?: boolean; default?: boolean }>
    }
  }
  jobs: Record<string, Job>
}

const yaml = createRequire(import.meta.url)('js-yaml') as { load(source: string): unknown }
const source = readFileSync('.github/workflows/build.yml', 'utf8')
const workflow = yaml.load(source) as Workflow

const PRODUCTION_TAG_PUSH = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')"
const SIGNED_RUN = "(github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')) || (github.event_name == 'workflow_dispatch' && inputs.signed_package_dry_run == true)"
const RUN_SCOPE = '${{ github.run_id }}-${{ github.run_attempt }}'
const MAC_PACKAGE_ARTIFACT = `signed-mac-packages-${RUN_SCOPE}`
const WIN_PACKAGE_ARTIFACT = `signed-windows-packages-${RUN_SCOPE}`
const MAC_VERIFIED_MANIFEST = `verified-release-manifest-mac-${RUN_SCOPE}`
const WIN_VERIFIED_MANIFEST = `verified-release-manifest-windows-${RUN_SCOPE}`
const SIGNING_ENVIRONMENT = 'platform-release-signing'
const PUBLISH_ENVIRONMENT = 'platform-release-publish'

const signedJobs = [
  'release-context',
  'package-mac',
  'package-win',
  'smoke-mac-arm64',
  'smoke-mac-intel',
  'smoke-win',
  'manifest-mac',
  'manifest-win',
]

const tagMutationJobs = ['release-preflight', 'release-mac', 'release-win', 'publish-release']
const allReleaseJobs = [...signedJobs, ...tagMutationJobs]
const allSmokeJobs = ['smoke-mac-arm64', 'smoke-mac-intel', 'smoke-win']
const secretJobEnvironments: Record<string, string> = {
  'package-mac': SIGNING_ENVIRONMENT,
  'package-win': SIGNING_ENVIRONMENT,
  'smoke-win': SIGNING_ENVIRONMENT,
  'release-preflight': PUBLISH_ENVIRONMENT,
  'release-mac': PUBLISH_ENVIRONMENT,
  'release-win': PUBLISH_ENVIRONMENT,
  'publish-release': PUBLISH_ENVIRONMENT,
}

function clone(): Workflow {
  return structuredClone(workflow)
}

function needs(job: Job | undefined): string[] {
  if (!job?.needs) return []
  return Array.isArray(job.needs) ? job.needs : [job.needs]
}

function commands(job: Job | undefined): string[] {
  return job?.steps.flatMap(step => typeof step.run === 'string' ? [step.run.trim()] : []) ?? []
}

function stepByUse(job: Job | undefined, use: string): Step[] {
  return job?.steps.filter(step => step.uses === use) ?? []
}

function namedStep(job: Job | undefined, name: string): Step | undefined {
  return job?.steps.find(step => step.name === name)
}

function java21(job: Job | undefined): boolean {
  const steps = stepByUse(job, 'actions/setup-java@v4')
  return steps.length === 1
    && steps[0].with?.distribution === 'temurin'
    && steps[0].with?.['java-version'] === 21
}

function artifactName(job: Job | undefined, use: string): string[] {
  return stepByUse(job, use).map(step => String(step.with?.name ?? ''))
}

function workflowErrors(candidate: Workflow): string[] {
  const errors: string[] = []
  const input = candidate.on.workflow_dispatch?.inputs?.signed_package_dry_run
  if (!input || input.type !== 'boolean' || input.default !== false || input.required !== false) {
    errors.push('signed package dry-run input must be an optional typed false boolean')
  }

  for (const jobName of signedJobs) {
    const job = candidate.jobs[jobName]
    if (!job) {
      errors.push(`missing ${jobName}`)
      continue
    }
    if (job.if !== SIGNED_RUN) errors.push(`${jobName} must use the signed tag-or-dry-run condition`)
  }
  for (const jobName of tagMutationJobs) {
    const job = candidate.jobs[jobName]
    if (!job) {
      errors.push(`missing ${jobName}`)
      continue
    }
    if (job.if !== PRODUCTION_TAG_PUSH) errors.push(`${jobName} must remain production tag-push-only`)
  }
  for (const [jobName, environment] of Object.entries(secretJobEnvironments)) {
    if (candidate.jobs[jobName]?.environment !== environment) {
      errors.push(`${jobName} must use protected environment ${environment}`)
    }
  }
  for (const [jobName, job] of Object.entries(candidate.jobs)) {
    if (JSON.stringify(job).includes('secrets.') && !(jobName in secretJobEnvironments)) {
      errors.push(`${jobName} consumes a secret without an approved protected environment`)
    }
  }

  const macPackage = candidate.jobs['package-mac']
  const winPackage = candidate.jobs['package-win']
  if (macPackage?.['runs-on'] !== 'macos-15') errors.push('package-mac must run on Apple Silicon macos-15')
  if (winPackage?.['runs-on'] !== 'windows-latest') errors.push('package-win must run on windows-latest')
  for (const [jobName, dependency] of [['package-mac', 'release-context'], ['package-win', 'release-context']]) {
    if (!needs(candidate.jobs[jobName]).includes(dependency)) errors.push(`${jobName} must need ${dependency}`)
  }

  const macEnvNames = [
    'MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD', 'MAC_CSC_NAME', 'MAC_EXPECTED_TEAM_ID',
    'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER',
  ]
  const winEnvNames = ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'WIN_EXPECTED_PUBLISHER']
  const macCredential = namedStep(macPackage, 'Fail closed on missing Mac release credentials')
  const winCredential = namedStep(winPackage, 'Fail closed on missing Windows release credentials')
  for (const name of macEnvNames) {
    if (macCredential?.env?.[name] !== `\${{ secrets.${name} }}`) errors.push(`package-mac credential gate must map ${name}`)
  }
  for (const name of winEnvNames) {
    if (winCredential?.env?.[name] !== `\${{ secrets.${name} }}`) errors.push(`package-win credential gate must map ${name}`)
  }
  if (!macCredential?.run?.includes('--platform mac --credentials-only')) errors.push('package-mac needs the credential-only gate')
  if (!winCredential?.run?.includes('--platform windows --credentials-only')) errors.push('package-win needs the credential-only gate')

  const macRuns = commands(macPackage)
  const winRuns = commands(winPackage)
  const macCredentialIndex = macPackage?.steps.indexOf(macCredential as Step) ?? -1
  const macBuilderIndex = macPackage?.steps.findIndex(step => step.run?.includes('electron-builder.release.cjs')) ?? -1
  const macNotaryIndex = macPackage?.steps.findIndex(step => step.run?.includes('notarytool submit')) ?? -1
  const macMetadataIndex = macPackage?.steps.findIndex(step => step.run?.includes('refresh-mac-update-metadata.mjs')) ?? -1
  const macVerifyIndex = macPackage?.steps.findIndex(step => step.run?.includes('--platform mac --release-dir')) ?? -1
  const macUploadIndex = macPackage?.steps.findIndex(step => step.uses === 'actions/upload-artifact@v4') ?? -1
  if (!(macCredentialIndex >= 0 && macBuilderIndex > macCredentialIndex && macNotaryIndex > macBuilderIndex && macMetadataIndex > macNotaryIndex && macVerifyIndex > macMetadataIndex && macUploadIndex > macVerifyIndex)) {
    errors.push('Mac credential, build, DMG notarize/staple, metadata refresh, verify, internal upload order is invalid')
  }
  if (!macRuns.some(run => run.includes('stapler staple'))) errors.push('package-mac must staple every notarized DMG')
  const winCredentialIndex = winPackage?.steps.indexOf(winCredential as Step) ?? -1
  const winBuilderIndex = winPackage?.steps.findIndex(step => step.run?.includes('electron-builder.release.cjs')) ?? -1
  const winVerifyIndex = winPackage?.steps.findIndex(step => step.run?.includes('--platform windows --release-dir')) ?? -1
  const winUploadIndex = winPackage?.steps.findIndex(step => step.uses === 'actions/upload-artifact@v4') ?? -1
  if (!(winCredentialIndex >= 0 && winBuilderIndex > winCredentialIndex && winVerifyIndex > winBuilderIndex && winUploadIndex > winVerifyIndex)) {
    errors.push('Windows credential, build, verify, internal upload order is invalid')
  }
  if (macRuns.some(run => run.includes('create-release-manifest')) || winRuns.some(run => run.includes('create-release-manifest'))) {
    errors.push('manifest must not be created in a package job before smoke')
  }

  if (!artifactName(macPackage, 'actions/upload-artifact@v4').includes(MAC_PACKAGE_ARTIFACT)) {
    errors.push('package-mac must upload the run/attempt signed package artifact')
  }
  if (!artifactName(winPackage, 'actions/upload-artifact@v4').includes(WIN_PACKAGE_ARTIFACT)) {
    errors.push('package-win must upload the run/attempt signed package artifact')
  }
  for (const jobName of ['package-mac', 'package-win']) {
    const upload = stepByUse(candidate.jobs[jobName], 'actions/upload-artifact@v4')[0]
    if (upload?.with?.['retention-days'] !== 1 || upload?.with?.['if-no-files-found'] !== 'error') {
      errors.push(`${jobName} internal artifact must be short-lived and fail when missing`)
    }
  }

  const smokeSpecs = [
    ['smoke-mac-arm64', 'macos-15', 'package-mac', MAC_PACKAGE_ARTIFACT, 'arm64'],
    ['smoke-mac-intel', 'macos-15-intel', 'package-mac', MAC_PACKAGE_ARTIFACT, 'x86_64'],
    ['smoke-win', 'windows-latest', 'package-win', WIN_PACKAGE_ARTIFACT, 'windows'],
  ]
  for (const [jobName, runner, packageNeed, packageArtifact, marker] of smokeSpecs) {
    const job = candidate.jobs[jobName]
    if (job?.['runs-on'] !== runner) errors.push(`${jobName} must run on ${runner}`)
    for (const dependency of ['release-context', packageNeed]) {
      if (!needs(job).includes(dependency)) errors.push(`${jobName} must need ${dependency}`)
    }
    if (!artifactName(job, 'actions/download-artifact@v4').includes(packageArtifact)) {
      errors.push(`${jobName} must download ${packageArtifact}`)
    }
    if (!java21(job)) errors.push(`${jobName} must configure Temurin Java 21`)
    const runText = commands(job).join('\n')
    if (marker === 'windows') {
      if (!runText.includes('windows-installed-release-smoke.ps1')) errors.push('smoke-win must run installed Windows smoke')
    } else if (!runText.includes('mac-installed-release-smoke.sh') || !runText.includes(marker)) {
      errors.push(`${jobName} must run installed Mac smoke for ${marker}`)
    }
    if (/electron-builder|npm run build|create-release-manifest|upload-release-assets/.test(runText)) {
      errors.push(`${jobName} must not rebuild, hash, or upload release bytes`)
    }
  }

  const allSmokeNeeds = ['package-mac', 'package-win', ...allSmokeJobs]
  for (const [jobName, packageArtifact, manifestArtifact] of [
    ['manifest-mac', MAC_PACKAGE_ARTIFACT, MAC_VERIFIED_MANIFEST],
    ['manifest-win', WIN_PACKAGE_ARTIFACT, WIN_VERIFIED_MANIFEST],
  ]) {
    const job = candidate.jobs[jobName]
    for (const dependency of ['release-context', ...allSmokeNeeds]) {
      if (!needs(job).includes(dependency)) errors.push(`${jobName} must need ${dependency}`)
    }
    if (!artifactName(job, 'actions/download-artifact@v4').includes(packageArtifact)) {
      errors.push(`${jobName} must download ${packageArtifact}`)
    }
    if (!commands(job).some(run => run.includes('create-release-manifest.mjs'))) {
      errors.push(`${jobName} must create the manifest after smoke`)
    }
    if (!artifactName(job, 'actions/upload-artifact@v4').includes(manifestArtifact)) {
      errors.push(`${jobName} must upload ${manifestArtifact}`)
    }
  }

  const uploadCommonNeeds = [
    'release-context', 'release-preflight', 'e2e-mac', 'e2e-win',
    'package-mac', 'package-win', ...allSmokeJobs,
  ]
  for (const [jobName, manifestNeed, packageArtifact, manifestArtifact, platform] of [
    ['release-mac', 'manifest-mac', MAC_PACKAGE_ARTIFACT, MAC_VERIFIED_MANIFEST, 'mac'],
    ['release-win', 'manifest-win', WIN_PACKAGE_ARTIFACT, WIN_VERIFIED_MANIFEST, 'windows'],
  ]) {
    const job = candidate.jobs[jobName]
    for (const dependency of [...uploadCommonNeeds, manifestNeed]) {
      if (!needs(job).includes(dependency)) errors.push(`${jobName} must need ${dependency}`)
    }
    const downloads = artifactName(job, 'actions/download-artifact@v4')
    if (!downloads.includes(packageArtifact)) errors.push(`${jobName} must download the original ${packageArtifact}`)
    if (!downloads.includes(manifestArtifact)) errors.push(`${jobName} must download ${manifestArtifact}`)
    const runText = commands(job).join('\n')
    if (!runText.includes('create-release-manifest.mjs') || !runText.includes('Compare-Object') && !runText.includes('Buffer.compare')) {
      errors.push(`${jobName} must regenerate and compare the manifest from the same package bytes`)
    }
    if (!runText.includes(`upload-release-assets.mjs --platform ${platform}`)) {
      errors.push(`${jobName} must use the immutable release-ID upload orchestrator`)
    }
    if (runText.includes('electron-builder') || runText.includes('npm run build')) {
      errors.push(`${jobName} must never rebuild after smoke`)
    }
  }

  const dryCapableText = signedJobs
    .flatMap(jobName => commands(candidate.jobs[jobName]))
    .join('\n')
  if (/gh\s+(api|release)|upload-release-assets|publish-verified-release|RELEASE_TOKEN/.test(dryCapableText)) {
    errors.push('signed dry-run capable jobs must not mutate an external release')
  }

  for (const jobName of allReleaseJobs) {
    const job = candidate.jobs[jobName]
    if (job?.['continue-on-error']) errors.push(`${jobName} must not continue on error`)
    if (job?.if?.includes('always()')) errors.push(`${jobName} must not bypass failed dependencies`)
    for (const step of job?.steps ?? []) {
      if (step['continue-on-error']) errors.push(`${jobName} step must not continue on error`)
      if (step.if?.includes('always()')) errors.push(`${jobName} step must not bypass failed dependencies`)
    }
  }
  return errors
}

describe('signed platform release workflow', () => {
  it('uses a typed signed dry-run and the complete fail-closed release DAG', () => {
    expect(workflowErrors(workflow)).toEqual([])
  })

  it('has the exact normal, signed-package, smoke, manifest, upload, and publish jobs', () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual([
      'build-mac', 'e2e-mac', 'e2e-win',
      'manifest-mac', 'manifest-win', 'package-mac', 'package-win',
      'publish-release', 'release-context', 'release-mac', 'release-preflight', 'release-win',
      'smoke-mac-arm64', 'smoke-mac-intel', 'smoke-win',
    ].sort())
  })

  it.each([
    { eventName: 'push', ref: 'refs/tags/v0.3.9', dryRun: false, signed: true, mutation: true },
    { eventName: 'push', ref: 'refs/heads/master', dryRun: false, signed: false, mutation: false },
    { eventName: 'workflow_dispatch', ref: 'refs/heads/master', dryRun: false, signed: false, mutation: false },
    { eventName: 'workflow_dispatch', ref: 'refs/heads/master', dryRun: true, signed: true, mutation: false },
    { eventName: 'workflow_dispatch', ref: 'refs/tags/v0.3.9', dryRun: false, signed: false, mutation: false },
    { eventName: 'workflow_dispatch', ref: 'refs/tags/v0.3.9', dryRun: true, signed: true, mutation: false },
  ])('enforces the release truth table for $eventName $ref dryRun=$dryRun', ({ eventName, ref, dryRun, signed, mutation }) => {
    const evaluate = (condition: string | undefined) => {
      const expression = new Function(
        'github',
        'inputs',
        'startsWith',
        `return Boolean(${condition ?? 'true'})`,
      ) as (
        github: { event_name: string; ref: string },
        inputs: { signed_package_dry_run: boolean },
        startsWith: (value: string, prefix: string) => boolean,
      ) => boolean
      return expression(
        { event_name: eventName, ref },
        { signed_package_dry_run: dryRun },
        (value, prefix) => value.startsWith(prefix),
      )
    }

    for (const jobName of signedJobs) expect(evaluate(workflow.jobs[jobName].if), jobName).toBe(signed)
    for (const jobName of tagMutationJobs) expect(evaluate(workflow.jobs[jobName].if), jobName).toBe(mutation)
  })

  it('rejects missing or bypassed signing credential gates', () => {
    const missing = clone()
    const gate = namedStep(missing.jobs['package-mac'], 'Fail closed on missing Mac release credentials')!
    delete gate.env!.APPLE_API_KEY_ID
    expect(workflowErrors(missing)).toContain('package-mac credential gate must map APPLE_API_KEY_ID')

    const bypass = clone()
    namedStep(bypass.jobs['package-win'], 'Fail closed on missing Windows release credentials')!['continue-on-error'] = true
    expect(workflowErrors(bypass)).toContain('package-win step must not continue on error')
  })

  it('binds every secret consumer to the split signing or publish environment', () => {
    expect(Object.fromEntries(
      Object.entries(workflow.jobs)
        .filter(([, job]) => JSON.stringify(job).includes('secrets.'))
        .map(([jobName, job]) => [jobName, job.environment]),
    )).toEqual(secretJobEnvironments)

    const unprotected = clone()
    delete unprotected.jobs['package-mac'].environment
    expect(workflowErrors(unprotected)).toContain(
      `package-mac must use protected environment ${SIGNING_ENVIRONMENT}`,
    )
  })

  it('rejects signing, notarization, verification, and manifest ordering regressions', () => {
    const noNotary = clone()
    noNotary.jobs['package-mac'].steps = noNotary.jobs['package-mac'].steps.filter(step => !step.run?.includes('notarytool submit'))
    expect(workflowErrors(noNotary)).toContain('Mac credential, build, DMG notarize/staple, metadata refresh, verify, internal upload order is invalid')

    const earlyManifest = clone()
    earlyManifest.jobs['package-win'].steps.splice(2, 0, { run: 'node scripts/create-release-manifest.mjs' })
    expect(workflowErrors(earlyManifest)).toContain('manifest must not be created in a package job before smoke')
  })

  it('rejects stale artifact names and a rebuild after smoke', () => {
    const stale = clone()
    stepByUse(stale.jobs['smoke-mac-intel'], 'actions/download-artifact@v4')[0].with!.name = 'signed-mac-packages'
    expect(workflowErrors(stale)).toContain(`smoke-mac-intel must download ${MAC_PACKAGE_ARTIFACT}`)

    const rebuilt = clone()
    rebuilt.jobs['release-win'].steps.push({ run: 'npx electron-builder --win' })
    expect(workflowErrors(rebuilt)).toContain('release-win must never rebuild after smoke')
  })

  it.each(allSmokeJobs)('rejects removing %s from either manifest gate', smokeJob => {
    for (const manifestJob of ['manifest-mac', 'manifest-win']) {
      const mutated = clone()
      mutated.jobs[manifestJob].needs = needs(mutated.jobs[manifestJob]).filter(name => name !== smokeJob)
      expect(workflowErrors(mutated)).toContain(`${manifestJob} must need ${smokeJob}`)
    }
  })

  it('rejects removing ARM, Intel, Windows, package, preflight, or unpacked E2E dependencies from upload', () => {
    for (const dependency of ['release-preflight', 'e2e-mac', 'e2e-win', 'package-mac', 'package-win', ...allSmokeJobs]) {
      const mutated = clone()
      mutated.jobs['release-mac'].needs = needs(mutated.jobs['release-mac']).filter(name => name !== dependency)
      expect(workflowErrors(mutated)).toContain(`release-mac must need ${dependency}`)
    }
  })

  it('rejects accidental external release mutation from the manual signed dry-run path', () => {
    const mutated = clone()
    mutated.jobs['manifest-mac'].steps.push({ run: 'node scripts/upload-release-assets.mjs', env: { GH_TOKEN: '${{ secrets.RELEASE_TOKEN }}' } })
    expect(workflowErrors(mutated)).toContain('signed dry-run capable jobs must not mutate an external release')
  })

  it('rejects fail-open always/continue-on-error mutations', () => {
    const always = clone()
    always.jobs['release-win'].if = `${PRODUCTION_TAG_PUSH} && always()`
    expect(workflowErrors(always)).toEqual(expect.arrayContaining([
      'release-win must remain production tag-push-only',
      'release-win must not bypass failed dependencies',
    ]))

    const continueOnError = clone()
    continueOnError.jobs['smoke-win']['continue-on-error'] = true
    expect(workflowErrors(continueOnError)).toContain('smoke-win must not continue on error')
  })
})
