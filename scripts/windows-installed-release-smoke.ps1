param(
  [Parameter(Mandatory = $true)]
  [string]$SetupPath,
  [string]$ExpectedPublisher = $env:WIN_EXPECTED_PUBLISHER,
  [string]$ExpectedCertificateSha256 = $env:WIN_EXPECTED_CERT_SHA256
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
      Where-Object { $_.DisplayName -eq 'Baby Diary' }
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

if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
  throw 'WIN_EXPECTED_PUBLISHER is required'
}
if ($ExpectedCertificateSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
  throw 'WIN_EXPECTED_CERT_SHA256 must be exactly 64 hexadecimal characters'
}
$SetupPath = (Resolve-Path -LiteralPath $SetupPath).Path
$existing = @(Get-BabyDiaryInstall)
if ($existing.Count -ne 0) {
  throw 'Refusing to overwrite a pre-existing Baby Diary installation on the clean smoke runner'
}

$installLocation = $null
try {
  Assert-TrustedSignature -Path $SetupPath
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

  Assert-TrustedSignature -Path $installedExecutable
  & node -e "import('./scripts/platform-release-verification.mjs').then(async m => { const fs = await import('node:fs/promises'); if (m.readPeMachine(await fs.readFile(process.argv[1])) !== 'x64') throw new Error('installed application must be x64') })" $installedExecutable
  if ($LASTEXITCODE -ne 0) { throw 'Installed application PE architecture validation failed' }

  $appUpdatePath = Join-Path $installLocation 'resources\app-update.yml'
  & node -e "const fs=require('node:fs'); const yaml=require('js-yaml'); import('./scripts/platform-release-verification.mjs').then(m => { const value=yaml.load(fs.readFileSync(process.argv[1],'utf8')).publisherName; const expected=process.argv[2]; if(!m.isCanonicalPublisherName(value, expected)) throw new Error('installed app-update.yml publisherName mismatch') })" $appUpdatePath $ExpectedPublisher
  if ($LASTEXITCODE -ne 0) { throw 'Installed updater publisherName validation failed' }

  $env:BABYDIARY_E2E_EXECUTABLE = $installedExecutable
  $env:BABYDIARY_SYNC_E2E_EXECUTABLE = $installedExecutable
  $env:BABYDIARY_EXPECTED_E2E_ARCH = 'x64'
  Invoke-NpmScript -Name 'test:e2e'
  Invoke-NpmScript -Name 'test:e2e:sync'
}
finally {
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
}
