param(
  [Parameter(Mandatory = $true)]
  [string]$SetupPath,
  [ValidateSet('AllowUnsigned', 'RequireTrusted')]
  [string]$SignaturePolicy = 'AllowUnsigned',
  [string]$ExpectedPublisher = $env:WIN_EXPECTED_PUBLISHER,
  [string]$ExpectedCertificateSha256 = $env:WIN_EXPECTED_CERT_SHA256,
  [string]$EvidenceDirectory = '.artifacts/installed-release-smoke'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-BabyDiaryInstall {
  $registryRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $entries = foreach ($root in $registryRoots) {
    Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
      Where-Object {
        $displayName = $_.PSObject.Properties['DisplayName']
        $null -ne $displayName -and $displayName.Value -eq 'Baby Diary'
      }
  }
  return @($entries)
}

function Assert-TrustedSignature {
  param([string]$Path)
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status.ToString() -ne 'Valid') {
    throw "Authenticode status is not Valid: $Path"
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "Trusted timestamp is missing: $Path"
  }
  if ($null -eq $signature.SignerCertificate) {
    throw "Authenticode signer certificate is missing: $Path"
  }
  if (-not [string]::Equals(
      $signature.SignerCertificate.Subject,
      $ExpectedPublisher,
      [System.StringComparison]::Ordinal
    )) {
    throw "Authenticode publisher does not match WIN_EXPECTED_PUBLISHER: $Path"
  }
  $certificateSha256 = $signature.SignerCertificate.GetCertHashString(
    [System.Security.Cryptography.HashAlgorithmName]::SHA256
  )
  if (-not [string]::Equals(
      $certificateSha256,
      $ExpectedCertificateSha256,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Authenticode certificate SHA-256 does not match WIN_EXPECTED_CERT_SHA256: $Path"
  }
}

function Invoke-NpmScript {
  param([string]$Name)
  & npm run $Name
  if ($LASTEXITCODE -ne 0) {
    throw "npm run $Name failed with exit code $LASTEXITCODE"
  }
}

function Invoke-NodeInline {
  param(
    [string]$Label,
    [string]$Source,
    [string[]]$Arguments
  )
  & node --input-type=module -e $Source @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE"
  }
}

function Get-UninstallerPath {
  param([string]$UninstallString)
  if ($UninstallString -match '^"([^"]+\.exe)"') {
    return $Matches[1]
  }
  if ($UninstallString -match '^(.+?\.exe)(?:\s|$)') {
    return $Matches[1]
  }
  throw 'Could not parse the Baby Diary UninstallString'
}

function New-FalsePositivePrePublicationEvidence {
  param(
    [string]$ProfileRoot,
    [string]$BeforeManifestPath,
    [string]$BeforeProjectionPath
  )
  $source = @'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as contract from './scripts/upgrade-data-contract.mjs'

const [profileRoot, beforeManifestPath, beforeProjectionPath] = process.argv.slice(1)
const descriptor = bytes => ({
  size: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'),
})

await contract.writeV038Fixture(profileRoot)
await contract.materializeMigratedBabyInfoJournal(profileRoot)

const entries = await readdir(profileRoot, { withFileTypes: true })
const journalEntry = entries.find(entry => (
  entry.isFile() && entry.name.includes('baby-info') && entry.name.endsWith('.jsonl')
))
if (!journalEntry) throw new Error('exact v0.3.8 fixture did not materialize a baby-info journal')

const settingsPath = path.join(profileRoot, 'settings.json')
const journalPath = path.join(profileRoot, journalEntry.name)
const liveSettingsBytes = await readFile(settingsPath)
const liveSettings = JSON.parse(liveSettingsBytes.toString('utf8'))
const staleSettings = structuredClone(liveSettings)
staleSettings.profile.name = 'stale-pre-publication-recovery'
const stagedSettingsBytes = Buffer.from(`${JSON.stringify(staleSettings, null, 2)}\n`, 'utf8')
const journalBytes = await readFile(journalPath)
const stagingRoot = path.join(profileRoot, '.baby-info-pair-restore-v1')
await mkdir(stagingRoot)
await writeFile(path.join(stagingRoot, 'settings.json'), stagedSettingsBytes)
await writeFile(path.join(stagingRoot, journalEntry.name), journalBytes)

// Match preserveOriginals/hashForensicSourceSet exactly. The archive contains
// the untouched readable live pair, while staging contains the stale pair that
// a pre-publication v0.3.9 recovery attempt must retire without publishing.
const archivedAt = '2026-07-13T00:17:33.000Z'
const forensicSources = [
  { path: 'settings.json', bytes: liveSettingsBytes },
  { path: journalEntry.name, bytes: journalBytes },
]
const aggregate = createHash('sha256')
aggregate.update(Buffer.from('baby-diary-forensic-v1\0', 'utf8'))
for (const source of forensicSources) {
  const nameBytes = Buffer.from(source.path, 'utf8')
  const frame = Buffer.alloc(12)
  frame.writeUInt32BE(nameBytes.byteLength, 0)
  frame.writeBigUInt64BE(BigInt(source.bytes.byteLength), 4)
  aggregate.update(frame)
  aggregate.update(nameBytes)
  aggregate.update(source.bytes)
}
const evidenceDigest = aggregate.digest('hex').slice(0, 16)
const forensicArchiveId = `${archivedAt.replace(/[:.]/g, '-')}-${evidenceDigest}`
const forensicArchive = path.join(profileRoot, 'recovery-forensics', forensicArchiveId)
await mkdir(forensicArchive, { recursive: true })
for (const source of forensicSources) {
  await writeFile(path.join(forensicArchive, source.path), source.bytes)
}
const forensicManifest = {
  version: 1,
  source: 'baby-diary-recovery',
  archivedAt,
  files: forensicSources.map(source => ({ path: source.path, ...descriptor(source.bytes) })),
}
const forensicManifestBytes = Buffer.from(JSON.stringify(forensicManifest, null, 2), 'utf8')
await writeFile(path.join(forensicArchive, 'manifest.json'), forensicManifestBytes)

const transaction = {
  version: 3,
  snapshotId: 'v038-false-positive-pre-publication',
  snapshotTimestamp: '2026-07-13T00:17:33.000Z',
  settings: descriptor(stagedSettingsBytes),
  journal: descriptor(journalBytes),
  phase: 'awaiting-windows-confirmation',
  windowsVerifiedStartups: 1,
  lastWindowsStartupId: 'v038-false-positive-boot',
  forensicArchiveId,
  forensicManifest: descriptor(forensicManifestBytes),
}
const transactionBytes = `${JSON.stringify(transaction, null, 2)}\n`
await writeFile(path.join(stagingRoot, 'restore-transaction.json'), transactionBytes, 'utf8')
await writeFile(path.join(profileRoot, '.baby-info-pair-restore-v1.json'), transactionBytes, 'utf8')

const beforeManifest = await contract.createRawManifest(profileRoot)
const beforeProjection = await contract.projectUpgradeSemantics(profileRoot)
await writeFile(beforeManifestPath, `${JSON.stringify(beforeManifest, null, 2)}\n`, 'utf8')
await writeFile(beforeProjectionPath, `${JSON.stringify(beforeProjection, null, 2)}\n`, 'utf8')
'@
  Invoke-NodeInline -Label 'exact v0.3.8 false-positive recovery fixture seeding' -Source $source -Arguments @(
    $ProfileRoot,
    $BeforeManifestPath,
    $BeforeProjectionPath
  )
}

function Invoke-PackagedRecoveryProbe {
  param(
    [string]$ExecutablePath,
    [string]$ProfileRoot,
    [string]$RuntimeEvidencePath
  )
  $source = @'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'

const [executablePath, profileRoot, runtimeEvidencePath] = process.argv.slice(1)
const execFileAsync = promisify(execFile)
const observedTopLevelWindowTitles = new Set()
const observedBrowserWindows = new Set()
const recoveryDialogTitle = /^Baby Diary (?:recovery required|startup failed)$/i
let application
let launchedProcess
let observeWindowTitles = false
let titleMonitor
let rendererReady = false
let publicState = null
let browserWindowCount = 0
let additionalWindowCount = 0
let processExitObserved = false
let processExitCode = null
let processExitSignal = null
let probeFailure

async function readMainProcessWindowTitle(pid) {
  try {
    const command = `$candidate = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -ne $candidate) { [Console]::Out.Write($candidate.MainWindowTitle) }`
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command,
    ], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

try {
  application = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      BABYDIARY_TEST_USERDATA: profileRoot,
      BABYDIARY_FIREBASE_EMULATOR: '1',
      BABYDIARY_FIREBASE_EMULATOR_PROJECT_ID: 'demo-baby-diary',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      NODE_ENV: 'production',
    },
    args: [
      '--proxy-server=127.0.0.1:9',
      '--proxy-bypass-list=<-loopback>',
      '--disable-background-networking',
    ],
  })
  launchedProcess = application.process()
  launchedProcess.once('exit', (code, signal) => {
    processExitObserved = true
    processExitCode = code
    processExitSignal = signal
  })
  application.on('window', window => observedBrowserWindows.add(window))
  for (const window of application.windows()) observedBrowserWindows.add(window)
  observeWindowTitles = true
  titleMonitor = (async () => {
    while (observeWindowTitles && !processExitObserved) {
      const title = await readMainProcessWindowTitle(launchedProcess.pid)
      if (title) observedTopLevelWindowTitles.add(title)
      await delay(100)
    }
  })()

  const page = await application.firstWindow({ timeout: 30_000 })
  await page.waitForFunction(() => Boolean(window.babyDiary), undefined, { timeout: 30_000 })
  publicState = await page.evaluate(async () => {
    const [settings, events, dataInfo] = await Promise.all([
      window.babyDiary.getSettings(),
      window.babyDiary.listEvents(),
      window.babyDiary.getDataInfo(),
    ])
    return {
      profileUid: settings.profile.uid,
      familyId: settings.familyId,
      eventCount: events.length,
      dataDir: dataInfo.dataDir,
    }
  })
  await page.waitForTimeout(1_000)
  if (page.isClosed()) throw new Error('renderer closed after readiness')
  rendererReady = true
} catch (error) {
  probeFailure = error
} finally {
  observeWindowTitles = false
  if (titleMonitor) await titleMonitor.catch(() => {})
  if (application) {
    try {
      for (const window of application.windows()) observedBrowserWindows.add(window)
      browserWindowCount = observedBrowserWindows.size
    } catch {
      browserWindowCount = 0
    }
  }
  additionalWindowCount = Math.max(0, browserWindowCount - (rendererReady ? 1 : 0))
  const recoveryDialogTitles = Array.from(observedTopLevelWindowTitles)
    .filter(title => recoveryDialogTitle.test(title))
  const recoveryDialogCount = recoveryDialogTitles.length
  const processExitObservedBeforeClose = Boolean(
    processExitObserved || (launchedProcess && launchedProcess.exitCode !== null),
  )
  await writeFile(runtimeEvidencePath, `${JSON.stringify({
    rendererReady,
    observedTopLevelWindowTitles: Array.from(observedTopLevelWindowTitles),
    recoveryDialogTitles,
    recoveryDialogCount: recoveryDialogTitles.length,
    browserWindowCount,
    additionalWindowCount: Number(additionalWindowCount),
    processExitObserved: Boolean(processExitObservedBeforeClose),
    processExitCode,
    processExitSignal,
    publicState,
    probeFailure: probeFailure instanceof Error ? probeFailure.message : probeFailure ? String(probeFailure) : null,
  }, null, 2)}\n`, 'utf8')
  if (application) await application.close().catch(() => {})
  if (recoveryDialogCount > 0) {
    throw new Error(`packaged application displayed a recovery/startup dialog: ${recoveryDialogTitles.join(', ')}`)
  }
  if (additionalWindowCount > 0) {
    throw new Error(`packaged application opened ${additionalWindowCount} unexpected additional window(s)`)
  }
  if (processExitObservedBeforeClose) {
    throw new Error(`packaged application exited during readiness probe: code=${processExitCode}, signal=${processExitSignal}`)
  }
}
if (probeFailure) throw probeFailure
'@
  Invoke-NodeInline -Label 'installed packaged recovery probe' -Source $source -Arguments @(
    $ExecutablePath,
    $ProfileRoot,
    $RuntimeEvidencePath
  )
}

function Complete-PreservationEvidence {
  param(
    [string]$ProfileRoot,
    [string]$BeforeProjectionPath,
    [string]$AfterManifestPath,
    [string]$AfterProjectionPath,
    [string]$ComparisonPath
  )
  $source = @'
import { access, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as contract from './scripts/upgrade-data-contract.mjs'

const [profileRoot, beforeProjectionPath, afterManifestPath, afterProjectionPath, comparisonPath] = process.argv.slice(1)
const beforeProjection = JSON.parse(await (await import('node:fs/promises')).readFile(beforeProjectionPath, 'utf8'))
const afterManifest = await contract.createRawManifest(profileRoot)
const afterProjection = await contract.projectUpgradeSemantics(profileRoot)
const recoveryPaths = [
  path.join(profileRoot, '.baby-info-pair-restore-v1.json'),
  path.join(profileRoot, '.baby-info-pair-restore-v1'),
]
let activeRecoveryEvidenceCount = 0
for (const candidate of recoveryPaths) {
  try { await access(candidate); activeRecoveryEvidenceCount += 1 } catch {}
}
const semanticProjectionUnchanged = contract.canonicalJson(beforeProjection)
  === contract.canonicalJson(afterProjection)
if (!semanticProjectionUnchanged) throw new Error('installed candidate changed the v0.3.8 semantic projection')
if (activeRecoveryEvidenceCount !== 0) throw new Error('installed candidate left active pre-publication recovery evidence')
await writeFile(afterManifestPath, `${JSON.stringify(afterManifest, null, 2)}\n`, 'utf8')
await writeFile(afterProjectionPath, `${JSON.stringify(afterProjection, null, 2)}\n`, 'utf8')
await writeFile(comparisonPath, `${JSON.stringify({
  semanticProjectionUnchanged,
  activeRecoveryEvidenceCount,
}, null, 2)}\n`, 'utf8')
'@
  Invoke-NodeInline -Label 'installed semantic preservation verification' -Source $source -Arguments @(
    $ProfileRoot,
    $BeforeProjectionPath,
    $AfterManifestPath,
    $AfterProjectionPath,
    $ComparisonPath
  )
}

if ($SignaturePolicy -eq 'RequireTrusted') {
  if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
    throw 'WIN_EXPECTED_PUBLISHER is required for RequireTrusted'
  }
  if ($ExpectedCertificateSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
    throw 'WIN_EXPECTED_CERT_SHA256 must be exactly 64 hexadecimal characters for RequireTrusted'
  }
}

$SetupPath = (Resolve-Path -LiteralPath $SetupPath).Path
$packageSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $SetupPath).Hash.ToLowerInvariant()
$existing = @(Get-BabyDiaryInstall)
if ($existing.Count -ne 0) {
  throw 'Refusing to overwrite a pre-existing Baby Diary installation on the clean smoke runner'
}

$runId = [Guid]::NewGuid().ToString('N')
$runRoot = Join-Path ([IO.Path]::GetTempPath()) "baby-diary-installed-smoke-$runId"
$profileRoot = Join-Path $runRoot 'user-data\baby-diary'
$beforeManifestPath = Join-Path $runRoot 'before-manifest.json'
$afterManifestPath = Join-Path $runRoot 'after-manifest.json'
$beforeProjectionPath = Join-Path $runRoot 'before-projection.json'
$afterProjectionPath = Join-Path $runRoot 'after-projection.json'
$runtimeEvidencePath = Join-Path $runRoot 'renderer-readiness.json'
$comparisonPath = Join-Path $runRoot 'preservation-comparison.json'
$evidencePath = Join-Path $runRoot 'installed-release-smoke-evidence.json'
$installLocation = $null
$installedExecutable = $null
$originalTestUserData = $env:BABYDIARY_TEST_USERDATA
$originalE2eExecutable = $env:BABYDIARY_E2E_EXECUTABLE
$originalSyncE2eExecutable = $env:BABYDIARY_SYNC_E2E_EXECUTABLE
$originalExpectedE2eArch = $env:BABYDIARY_EXPECTED_E2E_ARCH
New-Item -ItemType Directory -Path $profileRoot -Force | Out-Null

try {
  New-FalsePositivePrePublicationEvidence `
    -ProfileRoot $profileRoot `
    -BeforeManifestPath $beforeManifestPath `
    -BeforeProjectionPath $beforeProjectionPath

  if ($SignaturePolicy -eq 'RequireTrusted') {
    Assert-TrustedSignature -Path $SetupPath
  }
  $setupProcess = Start-Process -FilePath $SetupPath -ArgumentList '/S' -Wait -PassThru
  if ($setupProcess.ExitCode -ne 0) {
    throw "Silent Setup failed with exit code $($setupProcess.ExitCode)"
  }

  $entries = @()
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    $entries = @(Get-BabyDiaryInstall)
    if ($entries.Count -eq 1) { break }
    Start-Sleep -Seconds 2
  }
  if ($entries.Count -ne 1) {
    throw "Expected exactly one Baby Diary uninstall entry, found $($entries.Count)"
  }

  $entry = $entries[0]
  $uninstallerPath = Get-UninstallerPath -UninstallString $entry.UninstallString
  if (-not (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
    throw "Baby Diary uninstaller not found: $uninstallerPath"
  }
  $installLocation = Split-Path -Parent $uninstallerPath
  $installedExecutable = Join-Path $installLocation 'Baby Diary.exe'
  if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) {
    throw "Installed executable not found: $installedExecutable"
  }

  if ($SignaturePolicy -eq 'RequireTrusted') {
    Assert-TrustedSignature -Path $installedExecutable
  }
  & node -e "import('./scripts/platform-release-verification.mjs').then(async m => { const fs = await import('node:fs/promises'); if (m.readPeMachine(await fs.readFile(process.argv[1])) !== 'x64') throw new Error('installed application must be x64') })" $installedExecutable
  if ($LASTEXITCODE -ne 0) { throw 'Installed application PE architecture validation failed' }

  if ($SignaturePolicy -eq 'RequireTrusted') {
    $appUpdatePath = Join-Path $installLocation 'resources\app-update.yml'
    & node -e "const fs=require('node:fs'); const yaml=require('js-yaml'); import('./scripts/platform-release-verification.mjs').then(m => { const value=yaml.load(fs.readFileSync(process.argv[1],'utf8')).publisherName; const expected=process.argv[2]; if(!m.isCanonicalPublisherName(value, expected)) throw new Error('installed app-update.yml publisherName mismatch') })" $appUpdatePath $ExpectedPublisher
    if ($LASTEXITCODE -ne 0) { throw 'Installed updater publisherName validation failed' }
  }

  $env:BABYDIARY_TEST_USERDATA = $profileRoot
  Invoke-PackagedRecoveryProbe `
    -ExecutablePath $installedExecutable `
    -ProfileRoot $profileRoot `
    -RuntimeEvidencePath $runtimeEvidencePath
  Complete-PreservationEvidence `
    -ProfileRoot $profileRoot `
    -BeforeProjectionPath $beforeProjectionPath `
    -AfterManifestPath $afterManifestPath `
    -AfterProjectionPath $afterProjectionPath `
    -ComparisonPath $comparisonPath

  $env:BABYDIARY_E2E_EXECUTABLE = $installedExecutable
  $env:BABYDIARY_SYNC_E2E_EXECUTABLE = $installedExecutable
  $env:BABYDIARY_EXPECTED_E2E_ARCH = 'x64'
  Invoke-NpmScript -Name 'test:e2e'
  Invoke-NpmScript -Name 'test:e2e:sync'

  $runtimeEvidence = Get-Content -Raw -Encoding utf8 -LiteralPath $runtimeEvidencePath | ConvertFrom-Json
  $comparison = Get-Content -Raw -Encoding utf8 -LiteralPath $comparisonPath | ConvertFrom-Json
  $evidence = [ordered]@{
    schemaVersion = 1
    runId = $runId
    signaturePolicy = $SignaturePolicy
    setupPath = $SetupPath
    packageSha256 = $packageSha256
    installedExecutable = $installedExecutable
    profileRoot = $profileRoot
    beforeManifest = 'before-manifest.json'
    afterManifest = 'after-manifest.json'
    beforeProjection = 'before-projection.json'
    afterProjection = 'after-projection.json'
    rendererReady = [bool]$runtimeEvidence.rendererReady
    recoveryDialogCount = [int]$runtimeEvidence.recoveryDialogCount
    additionalWindowCount = [int]$runtimeEvidence.additionalWindowCount
    processExitObserved = [bool]$runtimeEvidence.processExitObserved
    semanticProjectionUnchanged = [bool]$comparison.semanticProjectionUnchanged
    activeRecoveryEvidenceCount = [int]$comparison.activeRecoveryEvidenceCount
  }
  ($evidence | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $evidencePath -Encoding utf8
  New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
  foreach ($artifact in @(
      $evidencePath,
      $beforeManifestPath,
      $afterManifestPath,
      $beforeProjectionPath,
      $afterProjectionPath,
      $runtimeEvidencePath,
      $comparisonPath
    )) {
    Copy-Item -LiteralPath $artifact -Destination $EvidenceDirectory -Force
  }
}
finally {
  if ($null -eq $originalTestUserData) { Remove-Item Env:BABYDIARY_TEST_USERDATA -ErrorAction SilentlyContinue }
  else { $env:BABYDIARY_TEST_USERDATA = $originalTestUserData }
  if ($null -eq $originalE2eExecutable) { Remove-Item Env:BABYDIARY_E2E_EXECUTABLE -ErrorAction SilentlyContinue }
  else { $env:BABYDIARY_E2E_EXECUTABLE = $originalE2eExecutable }
  if ($null -eq $originalSyncE2eExecutable) { Remove-Item Env:BABYDIARY_SYNC_E2E_EXECUTABLE -ErrorAction SilentlyContinue }
  else { $env:BABYDIARY_SYNC_E2E_EXECUTABLE = $originalSyncE2eExecutable }
  if ($null -eq $originalExpectedE2eArch) { Remove-Item Env:BABYDIARY_EXPECTED_E2E_ARCH -ErrorAction SilentlyContinue }
  else { $env:BABYDIARY_EXPECTED_E2E_ARCH = $originalExpectedE2eArch }

  # Preserve observable failure evidence before nonce cleanup. This stays
  # best-effort so evidence publication cannot hide the original smoke error.
  if (Test-Path -LiteralPath $runtimeEvidencePath -PathType Leaf) {
    try {
      New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
      Copy-Item -LiteralPath $runtimeEvidencePath -Destination $EvidenceDirectory -Force
    }
    catch {
      Write-Warning "Could not preserve packaged recovery probe evidence: $($_.Exception.Message)"
    }
  }

  $remainingEntries = @(Get-BabyDiaryInstall)
  if ($remainingEntries.Count -gt 0) {
    $uninstaller = Get-UninstallerPath -UninstallString $remainingEntries[0].UninstallString
    $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
    if ($uninstallProcess.ExitCode -ne 0) {
      throw "Silent uninstall failed with exit code $($uninstallProcess.ExitCode)"
    }
  }

  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    $remainingEntries = @(Get-BabyDiaryInstall)
    $locationExists = $null -ne $installLocation -and (Test-Path -LiteralPath $installLocation)
    if ($remainingEntries.Count -eq 0 -and -not $locationExists) { break }
    Start-Sleep -Seconds 2
  }
  $locationExists = $null -ne $installLocation -and (Test-Path -LiteralPath $installLocation)
  if (@(Get-BabyDiaryInstall).Count -ne 0 -or $locationExists) {
    throw 'Baby Diary installation cleanup did not remove the registry entry and install directory'
  }

  if (Test-Path -LiteralPath $runRoot) {
    $resolvedRunRoot = [IO.Path]::GetFullPath($runRoot)
    $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedRunRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $resolvedRunRoot) -ne "baby-diary-installed-smoke-$runId") {
      throw 'Refusing to clean a non-nonce installed smoke directory'
    }
    Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force
  }
}
