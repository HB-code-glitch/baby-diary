param(
  [Parameter(Mandatory = $true)]
  [string]$BaselineSetupPath,
  [Parameter(Mandatory = $true)]
  [string]$CandidateSetupPath,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedPublisher,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedCertificateSha256,
  [string]$ExpectedBaselineVersion = '0.3.8',
  [string]$ExpectedCandidateVersion = '0.3.9',
  [Parameter(Mandatory = $true)]
  [string]$CandidateSourceSha,
  [ValidateSet(
    'none',
    'after-baseline-close',
    'after-manifest-creation',
    'after-candidate-replacement',
    'before-candidate-first-launch'
  )]
  [string]$FailurePoint = 'none'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$BaselineReleaseId = 352876543
$BaselineAssetId = 474870034
$BaselineAssetName = 'Baby-Diary-Setup-0.3.8.exe'
$BaselineAssetSize = 233249330
$BaselineAssetSha256 = 'edb3a3e2d036f0d16dc8d75948c3f160c35adc9d1277a3dedc41d8671bd6a6de'
$BaselineSourceSha = '4ad44829c0de56da33d9123c16f92e6090f0df4a'

$repoRoot = Split-Path -Parent $PSScriptRoot
$upgradeDriver = Join-Path $PSScriptRoot 'upgrade-e2e.mjs'
$dataContract = Join-Path $PSScriptRoot 'upgrade-data-contract.mjs'
$runId = [Guid]::NewGuid().ToString('N')
$runRoot = Join-Path ([IO.Path]::GetTempPath()) "baby-diary-upgrade-$runId"
$isolatedAppData = Join-Path $runRoot 'AppData\Roaming'
$canonicalProfile = Join-Path $isolatedAppData 'baby-diary'
$baselineProjection = Join-Path $runRoot 'baseline-projection.json'
$firstProjection = Join-Path $runRoot 'candidate-first-projection.json'
$secondProjection = Join-Path $runRoot 'candidate-second-projection.json'
$baselineManifest = Join-Path $runRoot 'baseline-raw-manifest.json'
$originalAppData = $env:APPDATA
$originalE2eExecutable = $env:BABYDIARY_E2E_EXECUTABLE
$originalSyncE2eExecutable = $env:BABYDIARY_SYNC_E2E_EXECUTABLE
$originalExpectedE2eArch = $env:BABYDIARY_EXPECTED_E2E_ARCH
$originalCanonicalData = if ([string]::IsNullOrWhiteSpace($originalAppData)) {
  $null
} else {
  Join-Path $originalAppData 'baby-diary'
}

$script:failureInjected = $false

function Resolve-RegularFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  $item = Get-Item -LiteralPath $resolved -Force
  if (-not $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    return $resolved
  }
  throw "Expected a regular file without a reparse point: $Path"
}

function Get-BabyDiaryInstall {
  $registryRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  $entries = foreach ($root in $registryRoots) {
    Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq 'Baby Diary' }
  }
  return @($entries)
}

function Get-UninstallerPath {
  param([Parameter(Mandatory = $true)][string]$UninstallString)
  if ($UninstallString -match '^"([^"]+\.exe)"') { return $Matches[1] }
  if ($UninstallString -match '^(.+?\.exe)(?:\s|$)') { return $Matches[1] }
  throw 'Could not parse the exact Baby Diary UninstallString'
}

function Get-ExactInstalledApplication {
  $entries = @(Get-BabyDiaryInstall)
  if ($entries.Count -ne 1) {
    throw "Expected exactly one Baby Diary uninstall entry, found $($entries.Count)"
  }
  $uninstallerPath = Get-UninstallerPath -UninstallString $entries[0].UninstallString
  $uninstallerPath = [IO.Path]::GetFullPath($uninstallerPath)
  if (-not (Test-Path -LiteralPath $uninstallerPath -PathType Leaf)) {
    throw "Baby Diary uninstaller not found: $uninstallerPath"
  }
  $installLocation = Split-Path -Parent $uninstallerPath
  $executable = Join-Path $installLocation 'Baby Diary.exe'
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Installed Baby Diary executable not found: $executable"
  }
  return [pscustomobject]@{
    Entry = $entries[0]
    UninstallerPath = $uninstallerPath
    InstallLocation = [IO.Path]::GetFullPath($installLocation)
    Executable = [IO.Path]::GetFullPath($executable)
  }
}

function Assert-BaselineAssetContract {
  param([Parameter(Mandatory = $true)][string]$Path)
  $item = Get-Item -LiteralPath $Path
  if (-not [string]::Equals($item.Name, $BaselineAssetName, [StringComparison]::Ordinal)) {
    throw 'Historical baseline asset name does not match the pinned release asset'
  }
  if ($item.Length -ne $BaselineAssetSize) {
    throw "Historical baseline asset size mismatch: $($item.Length)"
  }
  $digest = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  if (-not [string]::Equals($digest, $BaselineAssetSha256, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Historical baseline asset SHA-256 mismatch'
  }
}

function Record-BaselineLegacyTrust {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$OutputPath
  )
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  $record = [ordered]@{
    releaseId = $BaselineReleaseId
    assetId = $BaselineAssetId
    assetName = $BaselineAssetName
    sourceSha = $BaselineSourceSha
    sha256 = $BaselineAssetSha256
    trustPolicy = 'legacy-input-evidence-only'
    authenticodeStatus = $signature.Status.ToString()
    signerSubject = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Subject }
    signerThumbprint = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Thumbprint }
    timestampPresent = ($null -ne $signature.TimeStamperCertificate)
  }
  $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $OutputPath -Encoding UTF8
}

function Assert-CandidateSignature {
  param([Parameter(Mandatory = $true)][string]$Path)
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status.ToString() -ne 'Valid') {
    throw "Candidate Authenticode status is not Valid: $Path"
  }
  if ($null -eq $signature.TimeStamperCertificate) {
    throw "Candidate trusted timestamp is missing: $Path"
  }
  if ($null -eq $signature.SignerCertificate) {
    throw "Candidate signer certificate is missing: $Path"
  }
  if (-not [string]::Equals(
      $signature.SignerCertificate.Subject,
      $ExpectedPublisher,
      [System.StringComparison]::Ordinal
    )) {
    throw "Candidate publisher Subject mismatch: $Path"
  }
  $certificateSha256 = $signature.SignerCertificate.GetCertHashString(
    [System.Security.Cryptography.HashAlgorithmName]::SHA256
  )
  if (-not [string]::Equals(
      $certificateSha256,
      $ExpectedCertificateSha256,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Candidate signer certificate SHA-256 mismatch: $Path"
  }
}

function Assert-X64Pe {
  param([Parameter(Mandatory = $true)][string]$Path)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $reader = New-Object IO.BinaryReader($stream)
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw "PE DOS header is invalid: $Path" }
    $stream.Position = 0x3C
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) { throw "PE offset is invalid: $Path" }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw "PE signature is invalid: $Path" }
    if ($reader.ReadUInt16() -ne 0x8664) { throw "Installed Baby Diary executable is not x64: $Path" }
  }
  finally {
    $stream.Dispose()
  }
}

function Start-VerifiedSetup {
  param(
    [Parameter(Mandatory = $true)][string]$SetupPath,
    [Parameter(Mandatory = $true)][ValidateSet('Baseline', 'Candidate')][string]$Label
  )
  $process = Start-Process -FilePath $SetupPath -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -ne 0) {
    if ($Label -eq 'Candidate') {
      throw "Candidate Setup failed with exit code $($process.ExitCode)"
    }
    throw "Baseline Setup failed with exit code $($process.ExitCode)"
  }
}

function Invoke-Node {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & node @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Node command failed with exit code $LASTEXITCODE"
  }
}

function Invoke-UpgradePhase {
  param(
    [Parameter(Mandatory = $true)][string]$Mode,
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][string]$SourceSha,
    [Parameter(Mandatory = $true)][string]$DiagnosticPath,
    [Parameter(Mandatory = $true)][string]$ProjectionOutput,
    [string]$ComparisonProjection
  )
  $arguments = @(
    $upgradeDriver,
    '--mode', $Mode,
    '--executable', $Executable,
    '--profile-root', $canonicalProfile,
    '--temp-root', $runRoot,
    '--run-id', $runId,
    '--diagnostic', $DiagnosticPath,
    '--projection-output', $ProjectionOutput,
    '--source-sha', $SourceSha,
    '--expected-version', $ExpectedVersion,
    '--expected-arch', 'x64'
  )
  if (-not [string]::IsNullOrWhiteSpace($ComparisonProjection)) {
    $arguments += @('--comparison-projection', $ComparisonProjection)
  }
  if (-not [string]::IsNullOrWhiteSpace($originalCanonicalData)) {
    $arguments += @('--forbidden-root', $originalCanonicalData)
  }
  Invoke-Node -Arguments $arguments
}

function New-BaselineManifest {
  Invoke-Node -Arguments @(
    $dataContract,
    'manifest',
    '--root', $canonicalProfile,
    '--output', $baselineManifest
  )
}

function Assert-ProfileMatchesBaseline {
  if (-not (Test-Path -LiteralPath $baselineManifest -PathType Leaf)) {
    throw 'Baseline raw manifest is unavailable for preservation proof'
  }
  Invoke-Node -Arguments @(
    $dataContract,
    'compare-manifest',
    '--root', $canonicalProfile,
    '--before', $baselineManifest
  )
}

function Invoke-FailurePoint {
  param([Parameter(Mandatory = $true)][string]$Point)
  if ([string]::Equals($FailurePoint, $Point, [StringComparison]::Ordinal)) {
    $script:failureInjected = $true
    throw "Injected deterministic wrapper failure at $Point"
  }
}

function Assert-FailureInvariant {
  if ($script:failureInjected) {
    Assert-ProfileMatchesBaseline
  }
}

function Assert-ExactShortcut {
  param([Parameter(Mandatory = $true)][string]$CandidateExecutable)
  $shell = New-Object -ComObject WScript.Shell
  try {
    $desktopFolders = @(
      $shell.SpecialFolders.Item('Desktop'),
      $shell.SpecialFolders.Item('AllUsersDesktop')
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
    $resolved = foreach ($folder in $desktopFolders) {
      if (-not (Test-Path -LiteralPath $folder -PathType Container)) { continue }
      foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File -ErrorAction SilentlyContinue) {
        $shortcut = $shell.CreateShortcut($file.FullName)
        [pscustomobject]@{
          Path = $file.FullName
          Name = $file.Name
          TargetPath = [string]$shortcut.TargetPath
          Arguments = [string]$shortcut.Arguments
          WorkingDirectory = [string]$shortcut.WorkingDirectory
        }
      }
    }
    $applicable = @($resolved | Where-Object {
      $nameMatches = [string]::Equals($_.Name, 'Baby Diary.lnk', [StringComparison]::OrdinalIgnoreCase)
      $targetMatches = -not [string]::IsNullOrWhiteSpace($_.TargetPath) -and
        [string]::Equals(
          [IO.Path]::GetFullPath($_.TargetPath),
          $CandidateExecutable,
          [StringComparison]::OrdinalIgnoreCase
        )
      $nameMatches -or $targetMatches
    })
    if ($applicable.Count -ne 1) {
      throw "Expected exactly one applicable Baby Diary shortcut, found $($applicable.Count)"
    }
    $candidate = $applicable[0]
    if (-not [string]::Equals($candidate.Name, 'Baby Diary.lnk', [StringComparison]::Ordinal)) {
      throw "Applicable shortcut name is not exactly Baby Diary.lnk: $($candidate.Name)"
    }
    if (-not [string]::Equals(
        [IO.Path]::GetFullPath($candidate.TargetPath),
        $CandidateExecutable,
        [StringComparison]::OrdinalIgnoreCase
      )) {
      throw 'Baby Diary shortcut TargetPath does not match the exact candidate executable'
    }
    if (-not [string]::Equals($candidate.Arguments, '', [StringComparison]::Ordinal)) {
      throw 'Baby Diary shortcut Arguments must be empty'
    }
    $installDirectory = Split-Path -Parent $CandidateExecutable
    if (-not [string]::Equals(
        [IO.Path]::GetFullPath($candidate.WorkingDirectory),
        $installDirectory,
        [StringComparison]::OrdinalIgnoreCase
      )) {
      throw 'Baby Diary shortcut WorkingDirectory does not match the candidate install directory'
    }
  }
  finally {
    if ($null -ne $shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
  }
}

function Invoke-NpmScript {
  param([Parameter(Mandatory = $true)][string]$Name)
  & npm run $Name
  if ($LASTEXITCODE -ne 0) { throw "npm run $Name failed with exit code $LASTEXITCODE" }
}

function Invoke-VerifiedUninstall {
  param([string]$KnownInstallLocation)
  $entries = @(Get-BabyDiaryInstall)
  if ($entries.Count -gt 1) {
    throw "Installation cleanup found multiple Baby Diary uninstall entries: $($entries.Count)"
  }
  if ($entries.Count -eq 1) {
    $uninstaller = Get-UninstallerPath -UninstallString $entries[0].UninstallString
    $uninstaller = [IO.Path]::GetFullPath($uninstaller)
    if (-not [string]::IsNullOrWhiteSpace($KnownInstallLocation)) {
      $actualLocation = Split-Path -Parent $uninstaller
      if (-not [string]::Equals(
          [IO.Path]::GetFullPath($actualLocation),
          [IO.Path]::GetFullPath($KnownInstallLocation),
          [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'Installation cleanup refused an unexpected uninstall location'
      }
    }
    $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "Silent uninstall failed with exit code $($process.ExitCode)" }
  }
  for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
    $remaining = @(Get-BabyDiaryInstall)
    $locationExists = -not [string]::IsNullOrWhiteSpace($KnownInstallLocation) -and
      (Test-Path -LiteralPath $KnownInstallLocation)
    if ($remaining.Count -eq 0 -and -not $locationExists) { return }
    Start-Sleep -Milliseconds 500
  }
  throw 'Baby Diary installation cleanup did not remove the exact registry identity and install directory'
}

function Scrub-DiagnosticSecrets {
  if (-not (Test-Path -LiteralPath $runRoot -PathType Container)) { return }
  $settingsFiles = @(Get-ChildItem -LiteralPath $runRoot -Filter 'settings.json' -File -Recurse -Force -ErrorAction SilentlyContinue)
  foreach ($file in $settingsFiles) {
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    try {
      $settings = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
      if ($null -ne $settings.PSObject.Properties['firebase']) { $settings.firebase = $null }
      $settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $file.FullName -Encoding UTF8
    }
    catch {
      Remove-Item -LiteralPath $file.FullName -Force
    }
  }
  foreach ($relative in @('Local Storage', 'Session Storage', 'IndexedDB', 'Network', 'WebStorage', 'Cookies')) {
    $sensitivePath = Join-Path $canonicalProfile $relative
    if (Test-Path -LiteralPath $sensitivePath) {
      Remove-Item -LiteralPath $sensitivePath -Recurse -Force
    }
  }
  [ordered]@{
    version = 1
    scrubbed = $true
    removedAuthStores = $true
    firebaseConfigRedacted = $true
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'secrets-scrubbed.json') -Encoding UTF8
}

function Remove-RunOwnedTempRoot {
  if (-not (Test-Path -LiteralPath $runRoot)) { return }
  $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $resolvedRunRoot = [IO.Path]::GetFullPath($runRoot)
  if (-not $resolvedRunRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals(
        [IO.Path]::GetFileName($resolvedRunRoot),
        "baby-diary-upgrade-$runId",
        [StringComparison]::Ordinal
      )) {
    throw 'Refusing to remove a path that is not the run-owned temp root'
  }
  Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force
}

if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) { throw 'ExpectedPublisher is required' }
if ($ExpectedCertificateSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
  throw 'ExpectedCertificateSha256 must be exactly 64 hexadecimal characters'
}
if ($CandidateSourceSha -notmatch '^[0-9a-f]{40}$') {
  throw 'CandidateSourceSha must be exactly 40 lowercase hexadecimal characters'
}
if (-not [string]::Equals($ExpectedBaselineVersion, '0.3.8', [StringComparison]::Ordinal)) {
  throw 'This gate accepts only the pinned v0.3.8 baseline version'
}
if (-not [string]::Equals($ExpectedCandidateVersion, '0.3.9', [StringComparison]::Ordinal)) {
  throw 'This gate accepts only the v0.3.9 candidate version'
}
if ([string]::IsNullOrWhiteSpace($originalAppData)) { throw 'The runner APPDATA path is unavailable' }

$BaselineSetupPath = Resolve-RegularFile -Path $BaselineSetupPath
$CandidateSetupPath = Resolve-RegularFile -Path $CandidateSetupPath
$expectedCandidateName = "Baby-Diary-Setup-$ExpectedCandidateVersion.exe"
if (-not [string]::Equals(
    [IO.Path]::GetFileName($CandidateSetupPath),
    $expectedCandidateName,
    [StringComparison]::Ordinal
  )) {
  throw "Candidate Setup filename must be exactly $expectedCandidateName"
}

$success = $false
$installationStarted = $false
$installLocation = $null
$baselineInstallLocation = $null
$cleanupError = $null

New-Item -ItemType Directory -Path $isolatedAppData -Force | Out-Null

try {
  if (@(Get-BabyDiaryInstall).Count -ne 0) {
    throw 'Refusing to run with a pre-existing Baby Diary installation'
  }
  if (Test-Path -LiteralPath $originalCanonicalData) {
    throw 'Refusing to run with a pre-existing canonical data directory'
  }
  if (Test-Path -LiteralPath $canonicalProfile) {
    throw 'Refusing to reuse the isolated canonical data directory'
  }

  Assert-BaselineAssetContract -Path $BaselineSetupPath
  Record-BaselineLegacyTrust -Path $BaselineSetupPath -OutputPath (Join-Path $runRoot 'baseline-legacy-trust.json')
  # Candidate trust is mandatory and is checked before any candidate bytes can replace v0.3.8.
  Assert-CandidateSignature -Path $CandidateSetupPath

  $env:APPDATA = $isolatedAppData
  $installationStarted = $true
  Start-VerifiedSetup -SetupPath $BaselineSetupPath -Label 'Baseline'
  $baselineInstall = Get-ExactInstalledApplication
  $baselineInstallLocation = $baselineInstall.InstallLocation
  $installLocation = $baselineInstallLocation
  Assert-X64Pe -Path $baselineInstall.Executable

  Invoke-UpgradePhase `
    -Mode 'baseline-initialize' `
    -Executable $baselineInstall.Executable `
    -ExpectedVersion $ExpectedBaselineVersion `
    -SourceSha $BaselineSourceSha `
    -DiagnosticPath (Join-Path $runRoot 'baseline-diagnostic.json') `
    -ProjectionOutput $baselineProjection

  # Capture before either post-close failure seam so the catch path can prove no bytes changed.
  New-BaselineManifest
  Invoke-FailurePoint -Point 'after-baseline-close'
  Invoke-FailurePoint -Point 'after-manifest-creation'
  Assert-ProfileMatchesBaseline

  Start-VerifiedSetup -SetupPath $CandidateSetupPath -Label 'Candidate'
  $candidateInstall = Get-ExactInstalledApplication
  $installLocation = $candidateInstall.InstallLocation
  if (-not [string]::Equals(
      $candidateInstall.InstallLocation,
      $baselineInstallLocation,
      [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw 'Candidate Setup changed the Baby Diary install identity/location'
  }
  Assert-CandidateSignature -Path $candidateInstall.Executable
  Assert-X64Pe -Path $candidateInstall.Executable
  $candidateExecutable = $candidateInstall.Executable

  Invoke-FailurePoint -Point 'after-candidate-replacement'
  Assert-ProfileMatchesBaseline
  Assert-ExactShortcut -CandidateExecutable $candidateExecutable
  Invoke-FailurePoint -Point 'before-candidate-first-launch'

  Invoke-UpgradePhase `
    -Mode 'candidate-first-run' `
    -Executable $candidateExecutable `
    -ExpectedVersion $ExpectedCandidateVersion `
    -SourceSha $CandidateSourceSha `
    -DiagnosticPath (Join-Path $runRoot 'candidate-first-diagnostic.json') `
    -ProjectionOutput $firstProjection `
    -ComparisonProjection $baselineProjection

  Invoke-UpgradePhase `
    -Mode 'candidate-second-run' `
    -Executable $candidateExecutable `
    -ExpectedVersion $ExpectedCandidateVersion `
    -SourceSha $CandidateSourceSha `
    -DiagnosticPath (Join-Path $runRoot 'candidate-second-diagnostic.json') `
    -ProjectionOutput $secondProjection `
    -ComparisonProjection $firstProjection

  $env:BABYDIARY_E2E_EXECUTABLE = $candidateExecutable
  $env:BABYDIARY_SYNC_E2E_EXECUTABLE = $candidateExecutable
  $env:BABYDIARY_EXPECTED_E2E_ARCH = 'x64'
  Push-Location $repoRoot
  try {
    Invoke-NpmScript -Name 'test:e2e'
    Invoke-NpmScript -Name 'test:e2e:sync'
  }
  finally {
    Pop-Location
  }
  $success = $true
}
catch {
  Assert-FailureInvariant
  throw
}
finally {
  $env:APPDATA = $originalAppData
  if ($null -eq $originalE2eExecutable) { Remove-Item Env:BABYDIARY_E2E_EXECUTABLE -ErrorAction SilentlyContinue }
  else { $env:BABYDIARY_E2E_EXECUTABLE = $originalE2eExecutable }
  if ($null -eq $originalSyncE2eExecutable) { Remove-Item Env:BABYDIARY_SYNC_E2E_EXECUTABLE -ErrorAction SilentlyContinue }
  else { $env:BABYDIARY_SYNC_E2E_EXECUTABLE = $originalSyncE2eExecutable }
  if ($null -eq $originalExpectedE2eArch) { Remove-Item Env:BABYDIARY_EXPECTED_E2E_ARCH -ErrorAction SilentlyContinue }
  else { $env:BABYDIARY_EXPECTED_E2E_ARCH = $originalExpectedE2eArch }
  if ($installationStarted) {
    try { Invoke-VerifiedUninstall -KnownInstallLocation $installLocation }
    catch { $cleanupError = $_ }
  }
  if ($success -and $null -eq $cleanupError) {
    Remove-RunOwnedTempRoot
  }
  else {
    Scrub-DiagnosticSecrets
    Write-Warning "Upgrade diagnostics preserved at: $runRoot"
  }
  if ($null -ne $cleanupError) { throw $cleanupError }
}
