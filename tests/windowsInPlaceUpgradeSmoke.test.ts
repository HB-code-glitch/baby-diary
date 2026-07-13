import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
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
    expect(script).toContain("DisplayName -eq 'Baby Diary'")
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

  it('requires candidate Authenticode identity before replacement and accepts it only after NSIS success', () => {
    expect(script).toContain('Get-AuthenticodeSignature')
    expect(script).toContain('TimeStamperCertificate')
    expect(script).toContain('$signature.SignerCertificate.Subject')
    expect(script).toContain('GetCertHashString')
    expect(script).toContain('[System.Security.Cryptography.HashAlgorithmName]::SHA256')
    const signatureIndex = script.indexOf('Assert-CandidateSignature -Path $CandidateSetupPath')
    const candidateInstallIndex = script.indexOf('Start-VerifiedSetup -SetupPath $CandidateSetupPath')
    expect(signatureIndex).toBeGreaterThan(-1)
    expect(candidateInstallIndex).toBeGreaterThan(signatureIndex)
    expect(script).toContain('Candidate Setup failed with exit code')
    expect(script).toContain('Assert-X64Pe')
    expect(script).toContain("'--expected-version', $ExpectedVersion")
    expect(script).toContain('-ExpectedVersion $ExpectedCandidateVersion')
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
  })

  it('runs all three driver phases then the existing normal/sync E2E on the exact candidate', () => {
    expect(script).toContain("'baseline-initialize'")
    expect(script).toContain("'candidate-first-run'")
    expect(script).toContain("'candidate-second-run'")
    expect(script).toContain('$env:BABYDIARY_E2E_EXECUTABLE = $candidateExecutable')
    expect(script).toContain('$env:BABYDIARY_SYNC_E2E_EXECUTABLE = $candidateExecutable')
    expect(script).toContain("Invoke-NpmScript -Name 'test:e2e'")
    expect(script).toContain("Invoke-NpmScript -Name 'test:e2e:sync'")
  })

  it('uses deterministic failure seams, proves raw preservation, and cleans up without timing kills', () => {
    for (const point of [
      'after-baseline-close',
      'after-manifest-creation',
      'after-candidate-replacement',
      'before-candidate-first-launch',
    ]) expect(script).toContain(`'${point}'`)
    expect(script).toContain('Assert-FailureInvariant')
    expect(script).toContain('Scrub-DiagnosticSecrets')
    expect(script).toContain('finally')
    expect(script).toContain('Invoke-VerifiedUninstall')
    expect(script).toMatch(/installation cleanup/i)
    expect(script).not.toMatch(/Stop-Process|taskkill|process\.kill|Kill\(/i)
    expect(script).toContain('Remove-RunOwnedTempRoot')
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
})
