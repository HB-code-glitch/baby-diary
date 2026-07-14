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

const BASELINE_ARTIFACT = `upgrade-baseline-v038-${RUN_SCOPE}`
const BASELINE_SOURCE_SHA = '4ad44829c0de56da33d9123c16f92e6090f0df4a'
const BASELINE_RELEASE_ID = '352876543'
const BASELINE_WIN_ASSET = { id: '474870034', size: '233249330', sha256: 'edb3a3e2d036f0d16dc8d75948c3f160c35adc9d1277a3dedc41d8671bd6a6de' }
const BASELINE_MAC_ASSET = { id: '474869787', size: '351533375', sha256: '2793e91c0dc49b436451f150ba0c8dc625cfd1a988841823a114d597e2f60974' }

const baselineJob = 'baseline-v038'
const upgradeJobs = ['upgrade-win', 'upgrade-mac-arm64', 'upgrade-mac-intel']
const ordinaryCiJobs = [
  'security-check',
  'build-mac',
  'e2e-mac',
  'e2e-win',
  'personal-smoke-mac-arm64',
  'personal-smoke-mac-intel',
]
const fetchDepthZeroJobs = ['security-check', baselineJob, ...upgradeJobs]

const signedJobs = [
  'release-context',
  baselineJob,
  'package-mac',
  'package-win',
  ...upgradeJobs,
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
  'upgrade-win': SIGNING_ENVIRONMENT,
  'upgrade-mac-arm64': SIGNING_ENVIRONMENT,
  'upgrade-mac-intel': SIGNING_ENVIRONMENT,
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
  const winEnvNames = [
    'WIN_CSC_LINK',
    'WIN_CSC_KEY_PASSWORD',
    'WIN_EXPECTED_PUBLISHER',
    'WIN_EXPECTED_CERT_SHA256',
  ]
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

  const winBuilder = namedStep(winPackage, 'Build signed Windows packages once')
  const winVerification = namedStep(winPackage, 'Hard-verify final signed Windows package bytes')
  for (const name of winEnvNames) {
    if (winVerification?.env?.[name] !== `\${{ secrets.${name} }}`) {
      errors.push(`package-win artifact verifier must map ${name}`)
    }
  }
  if (winBuilder?.env?.WIN_EXPECTED_CERT_SHA256 !== undefined) {
    errors.push('Windows builder must not receive the verification-only certificate thumbprint')
  }

  const smokeWin = candidate.jobs['smoke-win']
  const smokeWinStep = namedStep(smokeWin, 'Silent-install, exercise, and uninstall the signed Setup')
  for (const name of ['WIN_EXPECTED_PUBLISHER', 'WIN_EXPECTED_CERT_SHA256']) {
    if (smokeWinStep?.env?.[name] !== `\${{ secrets.${name} }}`) {
      errors.push(`smoke-win must map ${name}`)
    }
  }
  if (!smokeWinStep?.run?.includes('-ExpectedCertificateSha256 "${env:WIN_EXPECTED_CERT_SHA256}"')) {
    errors.push('smoke-win must pass the expected SHA-256 certificate thumbprint')
  }

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

  const baseline = candidate.jobs[baselineJob]
  if (!baseline) {
    errors.push(`missing ${baselineJob}`)
  } else {
    if (JSON.stringify(baseline).includes('secrets.')) {
      errors.push(`${baselineJob} must not consume any signing or release secret`)
    }
    const checkout = stepByUse(baseline, 'actions/checkout@v4')[0]
    if (checkout?.with?.['fetch-depth'] !== 0) {
      errors.push(`${baselineJob} must check out full history with fetch-depth 0`)
    }
    const runText = commands(baseline).join('\n')
    for (const fragment of [
      BASELINE_RELEASE_ID, BASELINE_SOURCE_SHA,
      BASELINE_WIN_ASSET.id, BASELINE_WIN_ASSET.size, BASELINE_WIN_ASSET.sha256,
      BASELINE_MAC_ASSET.id, BASELINE_MAC_ASSET.size, BASELINE_MAC_ASSET.sha256,
    ]) {
      if (!runText.includes(fragment)) errors.push(`${baselineJob} must pin exact baseline identity ${fragment}`)
    }
    const downloadStep = namedStep(baseline, 'Download and hard-verify the exact historical v0.3.8 release assets by asset ID')
    if (downloadStep?.env?.GH_TOKEN !== '${{ github.token }}') {
      errors.push(`${baselineJob} must authenticate GitHub API requests with github.token, not a secret`)
    }
    const curlLines = runText.split('\n').filter(line => line.includes('curl '))
    if (curlLines.length === 0 || curlLines.some(line => !line.includes('Authorization: Bearer'))) {
      errors.push(`${baselineJob} must send an Authorization header on every GitHub API curl request to avoid the shared-runner unauthenticated rate limit`)
    }
    const upload = stepByUse(baseline, 'actions/upload-artifact@v4')[0]
    if (upload?.with?.['retention-days'] !== 1 || upload?.with?.['if-no-files-found'] !== 'error') {
      errors.push(`${baselineJob} artifact must be short-lived and fail when missing`)
    }
    const baselineArtifactName = String(upload?.with?.name ?? '')
    const reservedNames = [MAC_PACKAGE_ARTIFACT, WIN_PACKAGE_ARTIFACT, MAC_VERIFIED_MANIFEST, WIN_VERIFIED_MANIFEST]
    if (!baselineArtifactName || reservedNames.includes(baselineArtifactName)) {
      errors.push(`${baselineJob} artifact name must not collide with any release-bound artifact name`)
    }
    const baselinePath = String(upload?.with?.path ?? '')
    if (baselinePath.startsWith('release/') || baselinePath.startsWith('release-upload')) {
      errors.push(`${baselineJob} artifact must not stage inside a release-upload glob path`)
    }
  }

  const upgradeSpecs = [
    ['upgrade-win', 'windows-latest', 'package-win', WIN_PACKAGE_ARTIFACT, ['WIN_EXPECTED_PUBLISHER', 'WIN_EXPECTED_CERT_SHA256'], 'windows-in-place-upgrade-smoke.ps1'],
    ['upgrade-mac-arm64', 'macos-15', 'package-mac', MAC_PACKAGE_ARTIFACT, ['MAC_EXPECTED_TEAM_ID'], 'mac-in-place-upgrade-smoke.sh'],
    ['upgrade-mac-intel', 'macos-15-intel', 'package-mac', MAC_PACKAGE_ARTIFACT, ['MAC_EXPECTED_TEAM_ID'], 'mac-in-place-upgrade-smoke.sh'],
  ] as const
  for (const [jobName, runner, packageNeed, packageArtifact, expectedIdentitySecrets, wrapperScript] of upgradeSpecs) {
    const job = candidate.jobs[jobName]
    if (!job) {
      errors.push(`missing ${jobName}`)
      continue
    }
    if (job['runs-on'] !== runner) errors.push(`${jobName} must run on ${runner}`)
    for (const dependency of ['release-context', packageNeed, baselineJob]) {
      if (!needs(job).includes(dependency)) errors.push(`${jobName} must need ${dependency}`)
    }
    const checkout = stepByUse(job, 'actions/checkout@v4')[0]
    if (checkout?.with?.['fetch-depth'] !== 0) {
      errors.push(`${jobName} must check out full history with fetch-depth 0 for the rules tag loader`)
    }
    if (!artifactName(job, 'actions/download-artifact@v4').includes(packageArtifact)) {
      errors.push(`${jobName} must download the signed candidate ${packageArtifact}`)
    }
    if (!artifactName(job, 'actions/download-artifact@v4').some(name => name.startsWith('upgrade-baseline-v038-'))) {
      errors.push(`${jobName} must download the verified v0.3.8 baseline artifact`)
    }
    if (!java21(job)) errors.push(`${jobName} must configure Temurin Java 21 for the Firestore rules emulator`)
    const stepsJson = JSON.stringify(job.steps)
    for (const name of expectedIdentitySecrets) {
      if (!stepsJson.includes(`secrets.${name}`)) errors.push(`${jobName} must map ${name}`)
    }
    const runText = commands(job).join('\n')
    if (!runText.includes('upgrade-firestore-rules.mjs')) {
      errors.push(`${jobName} must prepare the exact v0.3.8 Firestore rules workspace`)
    }
    if (!runText.includes('emulators:exec') || !runText.includes('auth,firestore')) {
      errors.push(`${jobName} must run baseline and candidate phases inside one Auth/Firestore emulator process`)
    }
    if (!runText.includes(wrapperScript)) {
      errors.push(`${jobName} must run the exact in-place upgrade wrapper ${wrapperScript}`)
    }
    if (/electron-builder|npm run build|create-release-manifest|upload-release-assets/.test(runText)) {
      errors.push(`${jobName} must not rebuild, hash for release, or upload release bytes`)
    }
  }

  const allSmokeNeeds = ['package-mac', 'package-win', ...allSmokeJobs, ...upgradeJobs]
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
    'package-mac', 'package-win', ...allSmokeJobs, ...upgradeJobs,
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

  for (const jobName of ordinaryCiJobs) {
    const job = candidate.jobs[jobName]
    if (!job) {
      errors.push(`missing ordinary CI job ${jobName}`)
      continue
    }
    if (job.if != null) errors.push(`${jobName} must remain unconditional ordinary PR CI`)
    if (JSON.stringify(job).includes('secrets.')) errors.push(`${jobName} must remain secret-free ordinary PR CI`)
  }

  const securityCheckout = stepByUse(candidate.jobs['security-check'], 'actions/checkout@v4')[0]
  if (securityCheckout?.with?.['fetch-depth'] !== 0) {
    errors.push('security-check calls an upgrade/rules tag loader and must check out with fetch-depth 0')
  }

  for (const [jobName, job] of Object.entries(candidate.jobs)) {
    const runText = commands(job).join('\n')
    if (/upgrade-firestore-rules\.mjs|rev-parse\s+v0\.3\.8/.test(runText)) {
      const checkout = stepByUse(job, 'actions/checkout@v4')[0]
      if (checkout?.with?.['fetch-depth'] !== 0) {
        errors.push(`${jobName} calls an upgrade/rules tag loader and must check out with fetch-depth 0`)
      }
    }
  }

  return errors
}

describe('signed platform release workflow', () => {
  it('uses a typed signed dry-run and the complete fail-closed release DAG', () => {
    expect(workflowErrors(workflow)).toEqual([])
  })

  it('has the exact normal, baseline, signed-package, upgrade, smoke, manifest, upload, and publish jobs', () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual([
      'baseline-v038',
      'build-mac', 'e2e-mac', 'e2e-win',
      'manifest-mac', 'manifest-win', 'package-mac', 'package-win',
      'personal-smoke-mac-arm64', 'personal-smoke-mac-intel',
      'publish-release', 'release-context', 'release-mac', 'release-preflight', 'release-win',
      'security-check',
      'smoke-mac-arm64', 'smoke-mac-intel', 'smoke-win',
      'upgrade-mac-arm64', 'upgrade-mac-intel', 'upgrade-win',
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

  it.each([...allSmokeJobs, ...upgradeJobs])('rejects removing %s from either manifest gate', smokeJob => {
    for (const manifestJob of ['manifest-mac', 'manifest-win']) {
      const mutated = clone()
      mutated.jobs[manifestJob].needs = needs(mutated.jobs[manifestJob]).filter(name => name !== smokeJob)
      expect(workflowErrors(mutated)).toContain(`${manifestJob} must need ${smokeJob}`)
    }
  })

  it('rejects removing ARM, Intel, Windows, upgrade, package, preflight, or unpacked E2E dependencies from upload', () => {
    for (const dependency of ['release-preflight', 'e2e-mac', 'e2e-win', 'package-mac', 'package-win', ...allSmokeJobs, ...upgradeJobs]) {
      const mutated = clone()
      mutated.jobs['release-mac'].needs = needs(mutated.jobs['release-mac']).filter(name => name !== dependency)
      expect(workflowErrors(mutated)).toContain(`release-mac must need ${dependency}`)
    }
  })

  it('fails closed: release jobs cannot run after any upgrade job is removed, skipped, or bypassed', () => {
    for (const upgradeJob of upgradeJobs) {
      for (const releaseJob of ['release-mac', 'release-win']) {
        const mutated = clone()
        mutated.jobs[releaseJob].needs = needs(mutated.jobs[releaseJob]).filter(name => name !== upgradeJob)
        expect(workflowErrors(mutated)).toContain(`${releaseJob} must need ${upgradeJob}`)
      }
    }
  })

  it('pins the exact historical release/asset identity in baseline-v038 and rejects a moved fetch', () => {
    expect(workflowErrors(workflow)).toEqual([])
    const moved = clone()
    const step = moved.jobs[baselineJob].steps.find(candidateStep => candidateStep.run?.includes(BASELINE_WIN_ASSET.sha256))!
    step.run = step.run!.replace(BASELINE_WIN_ASSET.sha256, 'f'.repeat(64))
    expect(workflowErrors(moved)).toContain(`${baselineJob} must pin exact baseline identity ${BASELINE_WIN_ASSET.sha256}`)
  })

  it('keeps baseline-v038 free of every signing/release secret', () => {
    const leaked = clone()
    leaked.jobs[baselineJob].steps.push({
      run: 'echo leaked',
      env: { WIN_CSC_LINK: '${{ secrets.WIN_CSC_LINK }}' },
    })
    expect(workflowErrors(leaked)).toContain(`${baselineJob} must not consume any signing or release secret`)
  })

  it('keeps baseline-v038 artifacts unable to satisfy any release-bound download', () => {
    const collided = clone()
    const upload = stepByUse(collided.jobs[baselineJob], 'actions/upload-artifact@v4')[0]!
    upload.with!.name = MAC_PACKAGE_ARTIFACT
    expect(workflowErrors(collided)).toContain(
      `${baselineJob} artifact name must not collide with any release-bound artifact name`,
    )

    const staged = clone()
    const stagedUpload = stepByUse(staged.jobs[baselineJob], 'actions/upload-artifact@v4')[0]!
    stagedUpload.with!.path = 'release/*'
    expect(workflowErrors(staged)).toContain(
      `${baselineJob} artifact must not stage inside a release-upload glob path`,
    )
  })

  it.each(fetchDepthZeroJobs)('requires %s to check out full history for the upgrade/rules tag loaders', jobName => {
    expect(workflowErrors(workflow)).toEqual([])
    const shallow = clone()
    const checkout = stepByUse(shallow.jobs[jobName], 'actions/checkout@v4')[0]!
    delete checkout.with
    expect(workflowErrors(shallow)).toContain(
      `${jobName} calls an upgrade/rules tag loader and must check out with fetch-depth 0`,
    )
  })

  it('requires the same protected identity secrets on every upgrade job', () => {
    const mutated = clone()
    const gate = mutated.jobs['upgrade-win'].steps.find(step => JSON.stringify(step).includes('WIN_EXPECTED_CERT_SHA256'))!
    delete gate.env!.WIN_EXPECTED_CERT_SHA256
    expect(workflowErrors(mutated)).toContain('upgrade-win must map WIN_EXPECTED_CERT_SHA256')

    const macMutated = clone()
    const macGate = macMutated.jobs['upgrade-mac-arm64'].steps.find(step => JSON.stringify(step).includes('MAC_EXPECTED_TEAM_ID'))!
    delete macGate.env!.MAC_EXPECTED_TEAM_ID
    expect(workflowErrors(macMutated)).toContain('upgrade-mac-arm64 must map MAC_EXPECTED_TEAM_ID')
  })

  it('keeps ordinary PR CI unconditional and free of every secret', () => {
    expect(workflowErrors(workflow)).toEqual([])
    for (const jobName of ordinaryCiJobs) {
      expect(workflow.jobs[jobName].if).toBeUndefined()
      expect(JSON.stringify(workflow.jobs[jobName])).not.toContain('secrets.')
    }

    const leaked = clone()
    leaked.jobs['e2e-mac'].steps.push({ run: 'echo leaked', env: { WIN_CSC_LINK: '${{ secrets.WIN_CSC_LINK }}' } })
    expect(workflowErrors(leaked)).toContain('e2e-mac must remain secret-free ordinary PR CI')
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
