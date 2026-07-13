import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const scriptPath = resolve(root, 'scripts/windows-in-place-upgrade-smoke.ps1')
const script = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : ''

describe('Windows v0.3.8 -> v0.3.9 in-place upgrade wrapper', () => {
  it('pins the exact historical release input while treating baseline trust as legacy evidence only', () => {
    expect(script).toContain('$BaselineReleaseId = 352876543')
    expect(script).toContain('$BaselineAssetId = 474870034')
    expect(script).toContain("$BaselineAssetName = 'Baby-Diary-Setup-0.3.8.exe'")
    expect(script).toContain('$BaselineAssetSize = 233249330')
    expect(script).toContain("$BaselineAssetSha256 = 'edb3a3e2d036f0d16dc8d75948c3f160c35adc9d1277a3dedc41d8671bd6a6de'")
    expect(script).toContain("$BaselineSourceSha = '4ad44829c0de56da33d9123c16f92e6090f0df4a'")
    expect(script).toContain('Record-BaselineLegacyTrust')
    expect(script).toContain('baseline-legacy-trust.json')
    expect(script).not.toMatch(/Assert-TrustedSignature\s+-Path\s+\$BaselineSetupPath/i)
  })

  it('refuses existing install/data, uses canonical temp APPDATA, and proves one unchanged install identity', () => {
    expect(script).toContain('$ExpectedRegistryChildName')
    expect(script).toMatch(/pre-existing Baby Diary installation/i)
    expect(script).toContain("Join-Path $originalAppData 'baby-diary'")
    expect(script).toMatch(/pre-existing canonical data directory/i)
    expect(script).toContain("baby-diary-upgrade-$runId")
    expect(script).toContain("Join-Path $isolatedAppData 'baby-diary'")
    expect(script).toContain('$env:APPDATA = $isolatedAppData')
    expect(script).not.toContain('BABYDIARY_TEST_USERDATA')
    expect(script).toContain('$baselineInstallLocation')
    expect(script).toContain('[System.StringComparison]::OrdinalIgnoreCase')
    expect(script).toMatch(/Expected exactly one Baby Diary uninstall entry/i)
  })

  it('binds the exact historical-to-candidate registry transition without pretending changed metadata is equal', () => {
    for (const field of [
      'PSPath',
      'PSChildName',
      'RegistryHive',
      'DisplayName',
      'DisplayVersion',
      'Publisher',
      'InstallLocation',
      'UninstallString',
      'QuietUninstallString',
      'UninstallerPath',
      'Executable',
    ]) expect(script).toContain(field)
    expect(script).toContain("$ExpectedRegistryChildName = 'e6d921f5-ef98-5cc5-a617-ae4251276f45'")
    expect(script).toContain("$ExpectedAppId = 'com.family.babydiary'")
    expect(script).toContain("$ExpectedProductName = 'Baby Diary'")
    expect(script).toContain("$ExpectedInstallChannelArgument = '/currentuser'")
    expect(script).toContain('$ExpectedBaselineDisplayName = "$ExpectedProductName $ExpectedBaselineVersion"')
    expect(script).toContain('$ExpectedCandidateDisplayName = $ExpectedProductName')
    expect(script).toContain("$ExpectedCandidateRegistryPublisher = 'HB-code-glitch'")
    expect(script).toContain('$ExpectedBaselineShortcutName = -join @(')
    for (const codePoint of ['0xBCA0', '0xC774', '0xBE44', '0xB2E4', '0xC5B4', '0xB9AC']) {
      expect(script).toContain(codePoint)
    }
    expect(script).toContain('$ExpectedCandidateShortcutName = $ExpectedProductName')
    expect(script).toContain('InstallRegistryPSPath')
    expect(script).toContain('InstallRegistryPSChildName')
    expect(script).toContain('KeepShortcuts')
    expect(script).toContain('ShortcutName')
    expect(script).toContain('Get-RegistryHiveFromPsPath')
    expect(script).toContain('Assert-UpgradeRegistryIdentity')
    expect(script).toContain('-ExpectedVersion $ExpectedBaselineVersion')
    expect(script).toContain('-ExpectedVersion $ExpectedCandidateVersion')
    expect(script).toContain('-Baseline $baselineInstall -Candidate $candidateInstall')
    expect(script).toMatch(/registry PSPath changed/i)
    expect(script).toMatch(/registry PSChildName changed/i)
    expect(script).toMatch(/registry hive changed/i)
    expect(script).toMatch(/baseline registry Publisher must be absent/i)
    expect(script).toMatch(/candidate registry Publisher does not match/i)
    expect(script).toMatch(/registry Publisher transition/i)
    expect(script).toMatch(/registry InstallLocation changed/i)
    expect(script).toMatch(/registry UninstallString changed/i)
    expect(script).toMatch(/registry QuietUninstallString changed/i)
    expect(script).toContain("-Stage 'Baseline'")
    expect(script).toContain("-Stage 'Candidate'")
    expect(script).toContain('Get-BabyDiaryNamedUninstallEntries')
    expect(script).toMatch(/without a legacy duplicate/i)
    expect(script).toMatch(/exact per-user install channel/i)
    expect(script).toContain('Write-InstallRegistryEvidence')
    expect(script).toContain('baseline-registry-evidence.json')
    expect(script).toContain('candidate-registry-evidence.json')
    expect(script).toContain('published-v0.3.8-installer-and-tag-source')
    expect(script).toContain('candidate-package-config-provenance-and-signed-installer')
  })

  it('requires candidate Authenticode identity before replacement and accepts it only after NSIS success', () => {
    expect(script).toContain('Get-AuthenticodeSignature')
    expect(script).toContain('TimeStamperCertificate')
    expect(script).toContain('$signature.SignerCertificate.Subject')
    expect(script).toContain('GetCertHashString')
    expect(script).toContain('[System.Security.Cryptography.HashAlgorithmName]::SHA256')
    const signatureIndex = script.indexOf('Assert-CandidateSignature -Path $CandidateSetupPath')
    const candidateInstallIndex = script.lastIndexOf('Install-CandidateWithRetry')
    expect(signatureIndex).toBeGreaterThan(-1)
    expect(candidateInstallIndex).toBeGreaterThan(signatureIndex)
    expect(script).toContain('Candidate Setup failed with exit code')
    expect(script).toContain('Assert-X64Pe')
    expect(script).toContain("'--expected-version', $ExpectedVersion")
    expect(script).toContain('-ExpectedVersion $ExpectedCandidateVersion')
  })

  it('requires and prints an exact CI provenance binding before any candidate installation', () => {
    expect(script).toContain('$CandidatePackageSha256')
    expect(script).toContain('$CandidateProvenancePath')
    expect(script).toContain('$ExpectedRepository')
    expect(script).toContain('$ExpectedWorkflowRunId')
    expect(script).toContain("'verify-provenance'")
    expect(script).toContain("'--expected-release-tag', 'v0.3.9'")
    expect(script).toContain("'--expected-platform', 'windows-x64'")
    expect(script).toMatch(/CandidatePackageSha256.*64 lowercase hexadecimal/i)
    expect(script).toMatch(/verified candidate provenance binding/i)
    const provenanceIndex = script.indexOf('Assert-CandidateProvenance')
    const installIndex = script.indexOf('Start-VerifiedSetup -SetupPath $CandidateSetupPath')
    expect(provenanceIndex).toBeGreaterThan(-1)
    expect(installIndex).toBeGreaterThan(provenanceIndex)
  })

  it('compares the full pre-first-run manifest and resolves exactly one shortcut through COM', () => {
    expect(script).toContain("'manifest'")
    expect(script).toContain("'compare-manifest'")
    const rawCompareIndex = script.indexOf('Assert-ProfileMatchesBaseline')
    const firstRunIndex = script.indexOf("'candidate-first-run'")
    expect(rawCompareIndex).toBeGreaterThan(-1)
    expect(firstRunIndex).toBeGreaterThan(rawCompareIndex)
    expect(script).toContain('New-Object -ComObject WScript.Shell')
    expect(script).toContain("SpecialFolders.Item('Desktop')")
    expect(script).toContain("SpecialFolders.Item('AllUsersDesktop')")
    expect(script).toContain("CreateShortcut")
    expect(script).toContain("Baby Diary.lnk")
    expect(script).toContain('.TargetPath')
    expect(script).toContain('.Arguments')
    expect(script).toContain('.WorkingDirectory')
    expect(script).toMatch(/exactly one applicable Baby Diary shortcut/i)
    expect(script).toMatch(/zero legacy baseline shortcuts/i)
  })

  it('runs all three driver phases then the existing normal/sync E2E on the exact candidate', () => {
    expect(script).toContain("'baseline-initialize'")
    expect(script).toContain("'candidate-first-run'")
    expect(script).toContain("'candidate-second-run'")
    expect(script).toContain('$env:BABYDIARY_E2E_EXECUTABLE = $candidateExecutable')
    expect(script).toContain('$env:BABYDIARY_SYNC_E2E_EXECUTABLE = $candidateExecutable')
    expect(script).toContain('$env:BABYDIARY_SYNC_E2E_UPGRADE_PROFILE = $canonicalProfile')
    expect(script).toContain("Invoke-NpmScript -Name 'test:e2e'")
    expect(script).toContain("Invoke-NpmScript -Name 'test:e2e:sync'")
  })

  it('uses distinct failure seams, proves ordinary and injected raw preservation, and retries replacement', () => {
    for (const point of [
      'after-baseline-close',
      'after-manifest-creation',
      'before-candidate-replacement',
      'during-candidate-replacement',
      'after-candidate-replacement',
      'before-candidate-first-launch',
    ]) expect(script).toContain(`'${point}'`)
    expect(script).toContain('Assert-FailureInvariant')
    expect(script).toContain('$script:baselineManifestCreated')
    expect(script).toContain('$script:candidateFirstLaunchStarted')
    expect(script).toContain('Install-CandidateWithRetry')
    expect(script).toContain('$attempt -lt 2')
    expect(script).toMatch(/ordinary candidate replacement failure/i)
    expect(script).toContain('Scrub-DiagnosticSecrets')
    expect(script).toContain('finally')
    expect(script).toContain('Invoke-VerifiedUninstall')
    expect(script).toMatch(/installation cleanup/i)
    expect(script).toContain('Remove-RunOwnedTempRoot')
  })

  it('runs setup, driver, npm, and uninstall inside one kill-on-close Job Object', () => {
    expect(script).toContain('$SetupTimeoutSeconds')
    expect(script).toContain('$DriverTimeoutSeconds')
    expect(script).toContain('$NpmTimeoutSeconds')
    expect(script).toContain('$UninstallTimeoutSeconds')
    expect(script).toContain('Invoke-BoundedProcess')
    expect(script).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE')
    expect(script).toContain('CREATE_SUSPENDED')
    expect(script).toContain('CreateProcessW')
    expect(script).toContain('AssignProcessToJobObject')
    expect(script).toContain('ResumeThread')
    expect(script).toContain('QueryInformationJobObject')
    expect(script).toContain('CloseHandle')
    expect(script).not.toContain('Get-CimInstance Win32_Process')
    expect(script).not.toContain('Stop-BoundedProcessTree')
    expect(script).toContain('[TimeoutException]')
    expect(script).toMatch(/job object cleanup/i)
    expect(script).toMatch(/FailureKind.*timeout/i)
  })

  it('natively guards the canonical profile tree before and after every upgrade phase', () => {
    const phaseStart = script.indexOf('function Invoke-UpgradePhase')
    const phaseEnd = script.indexOf('function New-BaselineManifest')
    const phase = script.slice(phaseStart, phaseEnd)
    expect(phaseStart).toBeGreaterThanOrEqual(0)
    expect(phaseEnd).toBeGreaterThan(phaseStart)
    expect(phase.match(/Assert-CanonicalProfileTreeWithoutReparsePoints/g) ?? []).toHaveLength(2)
    expect(script).toContain('[IO.FileAttributes]::ReparsePoint')
    expect(script).not.toMatch(/Get-ChildItem[^\r\n]*-Recurse/i)
  })

  it.runIf(process.platform === 'win32')('parses as valid PowerShell', () => {
    const command = [
      '$tokens=$null',
      '$errors=$null',
      `[void][System.Management.Automation.Language.Parser]::ParseFile('${scriptPath.replace(/'/g, "''")}',[ref]$tokens,[ref]$errors)`,
      'if($errors.Count -gt 0){$errors | ForEach-Object { Write-Error $_.Message }; exit 1}',
    ].join(';')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  })

  it.runIf(process.platform === 'win32')('kills and reaps a real process after the internal timeout', () => {
    const quote = (value: string) => value.replaceAll("'", "''")
    const command = [
      '$tokens=$null',
      '$errors=$null',
      `$ast=[System.Management.Automation.Language.Parser]::ParseFile('${quote(scriptPath)}',[ref]$tokens,[ref]$errors)`,
      '$functions=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)',
      'Invoke-Expression (($functions | ForEach-Object { $_.Extent.Text }) -join "`n")',
      '$ProcessCleanupTimeoutSeconds=2',
      'try {',
      "  Invoke-BoundedProcess -FilePath 'powershell.exe' -Arguments @('-NoProfile','-NonInteractive','-Command','Start-Sleep','-Seconds','30') -TimeoutSeconds 1 -Label 'synthetic timeout' | Out-Null",
      '  exit 2',
      '}',
      'catch [TimeoutException] {',
      "  if ($_.Exception.Data['FailureKind'] -ne 'timeout') { exit 3 }",
      '  exit 0',
      '}',
    ].join('\n')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  })

  it.runIf(process.platform === 'win32')('closes native Job Object handles after repeated normal exits', () => {
    const quote = (value: string) => value.replaceAll("'", "''")
    const command = [
      '$tokens=$null',
      '$errors=$null',
      `$ast=[System.Management.Automation.Language.Parser]::ParseFile('${quote(scriptPath)}',[ref]$tokens,[ref]$errors)`,
      '$functions=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)',
      'Invoke-Expression (($functions | ForEach-Object { $_.Extent.Text }) -join "`n")',
      '$ProcessCleanupTimeoutSeconds=2',
      'Initialize-BoundedProcessJobApi',
      '[GC]::Collect()',
      '[GC]::WaitForPendingFinalizers()',
      '$before=(Get-Process -Id $PID).HandleCount',
      'for($index=0;$index -lt 8;$index+=1){',
      "  $result=Invoke-BoundedProcess -FilePath 'powershell.exe' -Arguments @('-NoProfile','-NonInteractive','-Command','exit 0') -TimeoutSeconds 5 -Label 'normal exit'",
      '  if($result.ExitCode -ne 0){exit 2}',
      '}',
      '[GC]::Collect()',
      '[GC]::WaitForPendingFinalizers()',
      '$after=(Get-Process -Id $PID).HandleCount',
      'if(($after-$before) -gt 4){Write-Error "Native handle count grew from $before to $after";exit 3}',
      'exit 0',
    ].join('\n')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  })

  it.runIf(process.platform === 'win32')('kills a grandchild after its intermediate parent exits before timeout', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'baby-diary-job-object-'))
    const grandchildScript = join(fixtureRoot, 'grandchild.ps1')
    const intermediateScript = join(fixtureRoot, 'intermediate.ps1')
    const rootScript = join(fixtureRoot, 'root.ps1')
    const grandchildPidPath = join(fixtureRoot, 'grandchild.pid')
    const quote = (value: string) => value.replaceAll("'", "''")
    try {
      writeFileSync(grandchildScript, '\uFEFFStart-Sleep -Seconds 30\n')
      writeFileSync(intermediateScript, `\uFEFF${[
        `$grandchild = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','"${quote(grandchildScript)}"') -PassThru -WindowStyle Hidden`,
        `Set-Content -LiteralPath '${quote(grandchildPidPath)}' -Value $grandchild.Id -NoNewline`,
        '$grandchild.Dispose()',
        'exit 0',
      ].join('\n')}`)
      writeFileSync(rootScript, `\uFEFF${[
        `$intermediate = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','"${quote(intermediateScript)}"') -PassThru -WindowStyle Hidden`,
        '$intermediate.WaitForExit()',
        '$intermediate.Dispose()',
        'Start-Sleep -Seconds 30',
      ].join('\n')}`)

      const command = [
        '$tokens=$null',
        '$errors=$null',
        `$ast=[System.Management.Automation.Language.Parser]::ParseFile('${quote(scriptPath)}',[ref]$tokens,[ref]$errors)`,
        '$functions=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)',
        'Invoke-Expression (($functions | ForEach-Object { $_.Extent.Text }) -join "`n")',
        '$ProcessCleanupTimeoutSeconds=3',
        '$caught=$false',
        'try {',
        `  Invoke-BoundedProcess -FilePath 'powershell.exe' -Arguments @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${quote(rootScript)}') -TimeoutSeconds 5 -Label 'dead intermediate parent' | Out-Null`,
        '}',
        'catch [TimeoutException] {',
        "  if ($_.Exception.Data['FailureKind'] -ne 'timeout') { exit 5 }",
        '  $caught=$true',
        '}',
        'if(-not $caught){exit 2}',
        `if(-not (Test-Path -LiteralPath '${quote(grandchildPidPath)}' -PathType Leaf)){exit 3}`,
        `$grandchildId=[int](Get-Content -LiteralPath '${quote(grandchildPidPath)}' -Raw)`,
        '$deadline=[DateTime]::UtcNow.AddSeconds(3)',
        'while((Get-Process -Id $grandchildId -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 50}',
        'if(Get-Process -Id $grandchildId -ErrorAction SilentlyContinue){exit 4}',
        'exit 0',
      ].join('\n')
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        cwd: root,
        encoding: 'utf8',
        timeout: 20_000,
      })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    } finally {
      if (existsSync(grandchildPidPath)) {
        const grandchildId = Number.parseInt(readFileSync(grandchildPidPath, 'utf8'), 10)
        if (Number.isSafeInteger(grandchildId)) {
          spawnSync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Stop-Process -Id ${grandchildId} -Force -ErrorAction SilentlyContinue`,
          ])
        }
      }
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('retries one ordinary replacement failure and applies the invariant to ordinary and injected failures', () => {
    const quote = (value: string) => value.replaceAll("'", "''")
    const command = [
      '$tokens=$null',
      '$errors=$null',
      `$ast=[System.Management.Automation.Language.Parser]::ParseFile('${quote(scriptPath)}',[ref]$tokens,[ref]$errors)`,
      '$functions=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)',
      'Invoke-Expression (($functions | ForEach-Object { $_.Extent.Text }) -join "`n")',
      '$script:attempts=0',
      '$script:invariants=0',
      '$script:failureInjected=$false',
      "$CandidateSetupPath='candidate.exe'",
      'function Invoke-FailurePoint {}',
      'function Start-VerifiedSetup { $script:attempts += 1; if($script:attempts -eq 1){ throw "ordinary candidate replacement failure" } }',
      'function Assert-ProfileMatchesBaseline { $script:invariants += 1 }',
      'Install-CandidateWithRetry',
      'if($script:attempts -ne 2 -or $script:invariants -ne 1){ exit 2 }',
      '$script:baselineManifestCreated=$true',
      '$script:candidateFirstLaunchStarted=$false',
      '$script:failureInjected=$false',
      'Assert-FailureInvariant',
      '$script:failureInjected=$true',
      'Assert-FailureInvariant',
      '$script:candidateFirstLaunchStarted=$true',
      'Assert-FailureInvariant',
      'if($script:invariants -ne 3){ exit 3 }',
      'exit 0',
    ].join('\n')
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  })

  it.runIf(process.platform === 'win32')('never scrubs through a canonical-profile junction into an external sentinel', () => {
    const root = mkdtempSync(join(tmpdir(), 'baby-diary-win-cleanup-root-'))
    const external = mkdtempSync(join(tmpdir(), 'baby-diary-win-cleanup-external-'))
    const linkedProfile = join(root, 'linked-profile')
    const settingsPath = join(external, 'settings.json')
    const sentinel = join(external, 'Local Storage', 'external-sentinel.txt')
    try {
      mkdirSync(join(external, 'Local Storage'))
      writeFileSync(settingsPath, JSON.stringify({ firebase: { apiKey: 'must-survive' } }))
      writeFileSync(sentinel, 'outside-run-root')
      symlinkSync(external, linkedProfile, 'junction')
      const quote = (value: string) => value.replaceAll("'", "''")
      const command = [
        '$tokens=$null',
        '$errors=$null',
        `$ast=[System.Management.Automation.Language.Parser]::ParseFile('${quote(scriptPath)}',[ref]$tokens,[ref]$errors)`,
        '$functions=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true)',
        'Invoke-Expression (($functions | ForEach-Object { $_.Extent.Text }) -join "`n")',
        `$runRoot='${quote(root)}'`,
        `$canonicalProfile='${quote(linkedProfile)}'`,
        'Scrub-DiagnosticSecrets',
      ].join(';')
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        cwd: root,
        encoding: 'utf8',
      })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(readFileSync(sentinel, 'utf8')).toBe('outside-run-root')
      expect(JSON.parse(readFileSync(settingsPath, 'utf8')).firebase.apiKey).toBe('must-survive')
      expect(existsSync(join(root, 'secrets-scrubbed.json'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(external, { recursive: true, force: true })
    }
  })
})
