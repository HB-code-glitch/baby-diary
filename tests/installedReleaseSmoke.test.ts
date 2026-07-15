import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  FirebasePersistenceRegistry,
  captureFirebaseProfileInitialState,
  detectPreexistingFirebaseProfile,
} from '../electron/store/firebasePersistenceRegistry'
import { SettingsStore } from '../electron/store/settings'

const root = resolve(import.meta.dirname, '..')

function source(path: string) {
  const absolute = resolve(root, path)
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : ''
}

function embeddedNodeSource(script: string, functionName: string): string {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = script.match(new RegExp(
    `function\\s+${escapedName}\\s*\\{[\\s\\S]*?\\$source\\s*=\\s*@'\\r?\\n([\\s\\S]*?)\\r?\\n'@`,
  ))
  if (!match) throw new Error(`embedded Node source not found for ${functionName}`)
  return match[1]
}

function descriptor(bytes: Buffer): { size: number; sha256: string } {
  return {
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

function findPropertyInitializers(sourceText: string, propertyName: string): ts.Expression[] {
  const ast = ts.createSourceFile('embedded.mjs', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const matches: ts.Expression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)
      && ((ts.isIdentifier(node.name) && node.name.text === propertyName)
        || (ts.isStringLiteral(node.name) && node.name.text === propertyName))) {
      matches.push(node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return matches
}

function hasThrowingGuard(sourceText: string, identifier: string): boolean {
  const ast = ts.createSourceFile('embedded.mjs', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let found = false
  const containsIdentifier = (node: ts.Node): boolean => {
    let contains = false
    const visit = (candidate: ts.Node): void => {
      if (ts.isIdentifier(candidate) && candidate.text === identifier) contains = true
      ts.forEachChild(candidate, visit)
    }
    visit(node)
    return contains
  }
  const containsThrow = (node: ts.Node): boolean => {
    let contains = false
    const visit = (candidate: ts.Node): void => {
      if (ts.isThrowStatement(candidate)) contains = true
      ts.forEachChild(candidate, visit)
    }
    visit(node)
    return contains
  }
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)
      && containsIdentifier(node.expression)
      && containsThrow(node.thenStatement)) found = true
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return found
}

describe('installed Mac release smoke script', () => {
  const script = source('scripts/mac-installed-release-smoke.sh')

  it('defaults to the strict trusted policy and rejects every unknown policy', () => {
    expect(script).toContain('signature_policy="${3:-RequireTrusted}"')
    expect(script).toContain('AllowUnsigned|RequireTrusted)')
    expect(script).toContain('Unsupported Mac signature policy: $signature_policy')
    expect(script).not.toContain('signature_policy="${3:-AllowUnsigned}"')
  })

  it('runs trust verification by default and bypasses Gatekeeper only for explicit AllowUnsigned', () => {
    expect(script).toMatch(
      /if \[\[ "\$signature_policy" == "RequireTrusted" \]\]; then[\s\S]*codesign --verify --deep --strict[\s\S]*spctl --assess --type execute[\s\S]*xcrun stapler validate[\s\S]*else[\s\S]*xattr -dr com\.apple\.quarantine "\$installed_app"[\s\S]*fi/,
    )
    expect(script).toContain('Unsigned smoke could not remove quarantine metadata')
  })

  it('requires the expected host architecture and mounts the supplied DMG read-only', () => {
    expect(script).toContain('uname -m')
    expect(script).toContain('expected_host_arch')
    expect(script).toMatch(/hdiutil\s+verify/)
    expect(script).toMatch(/hdiutil\s+attach[^\n]*-readonly[^\n]*-nobrowse/)
  })

  it('copies to an Applications-style path, retains quarantine, and cleans up the mount', () => {
    expect(script).toContain('/Applications')
    expect(script).toContain('com.apple.quarantine')
    expect(script).toMatch(/hdiutil\s+detach/)
    expect(script).toContain('trap cleanup EXIT')
  })

  it('proves the installed universal app and runs both packaged E2E suites against one executable', () => {
    expect(script).toMatch(/lipo\s+-archs/)
    expect(script).toContain('x86_64')
    expect(script).toContain('arm64')
    expect(script).toContain('BABYDIARY_E2E_EXECUTABLE="$installed_executable"')
    expect(script).toContain('BABYDIARY_SYNC_E2E_EXECUTABLE="$installed_executable"')
    expect(script).toContain('npm run test:e2e')
    expect(script).toContain('npm run test:e2e:sync')
  })
})

describe('installed Windows release smoke script', () => {
  const script = source('scripts/windows-installed-release-smoke.ps1')
  const workflow = source('.github/workflows/build.yml')

  it('canonicalizes an aliased Node temp root with the manifest contract async realpath API', async () => {
    const allocator = embeddedNodeSource(script, 'New-IsolatedSmokePaths')
    const runId = '0123456789abcdef0123456789abcdef'
    const contractRoot = mkdtempSync(join(tmpdir(), 'baby-diary-installed-smoke-alias-'))
    const canonicalTempRoot = join(contractRoot, 'canonical-temp')
    const lexicalTempRoot = join(contractRoot, 'raw-temp-alias')

    expect(script).not.toContain('[IO.Path]::GetTempPath()')
    expect(allocator).toContain("import { mkdtempSync } from 'node:fs'")
    expect(allocator).toContain("import { realpath } from 'node:fs/promises'")
    expect(allocator).toContain("import { tmpdir } from 'node:os'")
    expect(allocator).toContain('const tempRoot = await realpath(tmpdir())')
    expect(allocator.match(/await realpath\(mkdtempSync\(/g)).toHaveLength(3)
    expect(allocator).not.toContain('realpathSync')
    expect(Array.from(allocator).filter(character => character.codePointAt(0)! > 0x7f)).toEqual([])

    try {
      mkdirSync(canonicalTempRoot)
      symlinkSync(canonicalTempRoot, lexicalTempRoot, process.platform === 'win32' ? 'junction' : 'dir')
      const childEnv = { ...process.env }
      if (process.platform === 'win32') {
        childEnv.TEMP = lexicalTempRoot
        childEnv.TMP = lexicalTempRoot
      } else {
        childEnv.TMPDIR = lexicalTempRoot
      }
      const allocated = JSON.parse(execFileSync(process.execPath, [
        '--input-type=module',
        '-e',
        allocator,
        runId,
      ], { cwd: root, env: childEnv, stdio: 'pipe' }).toString('utf8')) as {
        tempRoot: string
        runRoot: string
        referenceProfileRoot: string
        installedProfileRoot: string
      }

      const contractTempRoot = await realpath(lexicalTempRoot)
      expect(allocated.tempRoot).toBe(contractTempRoot)
      expect(allocated.tempRoot).not.toBe(resolve(lexicalTempRoot))
      expect(await realpath(allocated.runRoot)).toBe(allocated.runRoot)
      expect(allocated.referenceProfileRoot).not.toBe(allocated.installedProfileRoot)
      for (const profileRoot of [allocated.referenceProfileRoot, allocated.installedProfileRoot]) {
        expect(resolve(profileRoot).startsWith(`${resolve(allocated.tempRoot)}${sep}`)).toBe(true)
        expect((await realpath(profileRoot)).startsWith(`${contractTempRoot}${sep}`)).toBe(true)
        expect(await realpath(profileRoot)).toBe(profileRoot)
      }
    } finally {
      rmSync(contractRoot, { recursive: true, force: true })
    }
  })

  it('pins canonical child temp variables before fixtures and restores exact prior state after cleanup', () => {
    const main = script.slice(script.indexOf('$SetupPath ='))
    const originalTemp = main.indexOf('$originalTemp = $env:TEMP')
    const originalTmp = main.indexOf('$originalTmp = $env:TMP')
    const outerTry = main.indexOf('try {', originalTmp)
    const setTemp = main.indexOf('$env:TEMP = $tempRoot', outerTry)
    const setTmp = main.indexOf('$env:TMP = $tempRoot', outerTry)
    const firstFixture = main.indexOf('New-FalsePositivePrePublicationEvidence `')
    const syncE2e = main.indexOf("Invoke-NpmScript -Name 'test:e2e:sync'")
    const outerFinally = main.indexOf('finally {', syncE2e)
    const cleanup = main.indexOf('Remove-Item -LiteralPath $resolvedRunRoot -Recurse -Force', outerFinally)
    const restorationFinally = main.indexOf('finally {', outerFinally + 1)
    const restoreTemp = main.indexOf('if ($null -eq $originalTemp)', restorationFinally)
    const restoreTmp = main.indexOf('if ($null -eq $originalTmp)', restorationFinally)
    const restoration = main.slice(restorationFinally)

    expect(originalTemp).toBeGreaterThanOrEqual(0)
    expect(originalTmp).toBeGreaterThan(originalTemp)
    expect(outerTry).toBeGreaterThan(originalTmp)
    expect(setTemp).toBeGreaterThan(outerTry)
    expect(setTmp).toBeGreaterThan(setTemp)
    expect(setTmp).toBeLessThan(firstFixture)
    expect(syncE2e).toBeLessThan(outerFinally)
    expect(cleanup).toBeGreaterThan(outerFinally)
    expect(restorationFinally).toBeGreaterThan(cleanup)
    expect(restoreTemp).toBeGreaterThan(restorationFinally)
    expect(restoreTmp).toBeGreaterThan(restoreTemp)
    expect(restoration).toContain(
      'if ($null -eq $originalTemp) { Remove-Item Env:TEMP -ErrorAction SilentlyContinue }',
    )
    expect(restoration).toContain('else { $env:TEMP = $originalTemp }')
    expect(restoration).toContain(
      'if ($null -eq $originalTmp) { Remove-Item Env:TMP -ErrorAction SilentlyContinue }',
    )
    expect(restoration).toContain('else { $env:TMP = $originalTmp }')
  })

  it('runs the packaged regression on an isolated nonce profile with the exact v0.3.8 recovery fixture', () => {
    expect(script).toContain("[ValidateSet('AllowUnsigned', 'RequireTrusted')]")
    expect(script).toContain("[string]$SignaturePolicy = 'AllowUnsigned'")
    expect(script).toMatch(/\$runId\s*=\s*\[Guid\]::NewGuid\(\)\.ToString\('N'\)/)
    expect(script).toContain('$referenceProfileRoot = [string]$smokePaths.referenceProfileRoot')
    expect(script).toContain('$profileRoot = [string]$smokePaths.installedProfileRoot')
    expect(script).toContain('writeV038Fixture')
    expect(script).toContain('New-FalsePositivePrePublicationEvidence')
    expect(script).toContain('.baby-info-pair-restore-v1.json')
    expect(script).toContain('restore-transaction.json')
    expect(script).toContain("phase: 'awaiting-windows-confirmation'")
    expect(script).toContain('BABYDIARY_TEST_USERDATA')
    expect(script).toContain('launchCdpElectronApplication')
    expect(script).toContain('firstWindow')
    expect(script).toContain('window.babyDiary')
  })

  it('runs the same recovery probe on the co-built unpacked reference before Setup', () => {
    const main = script.slice(script.indexOf('$SetupPath ='))
    const referenceFixture = main.indexOf('New-FalsePositivePrePublicationEvidence `')
    const referenceProbe = main.indexOf('Invoke-PackagedRecoveryProbe `')
    const installedFixture = main.indexOf('New-FalsePositivePrePublicationEvidence `', referenceFixture + 1)
    const setup = main.indexOf('$setupProcess = Start-Process')
    const installedProbe = main.indexOf('Invoke-PackagedRecoveryProbe `', referenceProbe + 1)

    expect(script).toContain('[string]$ReferenceExecutablePath')
    expect(referenceFixture).toBeGreaterThanOrEqual(0)
    expect(referenceFixture).toBeLessThan(referenceProbe)
    expect(referenceProbe).toBeLessThan(installedFixture)
    expect(installedFixture).toBeLessThan(setup)
    expect(setup).toBeLessThan(installedProbe)
    expect(main.slice(referenceFixture, referenceProbe)).toContain('-ProfileRoot $referenceProfileRoot')
    expect(main.slice(referenceProbe, installedFixture)).toContain('-ExecutablePath $ReferenceExecutablePath')
    expect(main.slice(referenceProbe, installedFixture)).toContain('-ProfileRoot $referenceProfileRoot')
    expect(main.slice(installedFixture, setup)).toContain('-ProfileRoot $profileRoot')
    expect(main.slice(installedProbe)).toContain('-ExecutablePath $installedExecutable')
    expect(main.slice(installedProbe)).toContain('-ProfileRoot $profileRoot')
    expect(main.match(/Invoke-PackagedRecoveryProbe `/g)).toHaveLength(2)
  })

  it('passes the co-built unpacked reference to both Windows installed smoke jobs', () => {
    expect(workflow.match(
      /-ReferenceExecutablePath "\$\{\{ github\.workspace \}\}\/release\/win-unpacked\/Baby Diary\.exe"/g,
    )).toHaveLength(2)
  })

  it('attaches to the installed recovery probe over Chromium CDP without the Electron Node inspector', () => {
    const probe = embeddedNodeSource(script, 'Invoke-PackagedRecoveryProbe')

    expect(probe).toContain("import { chromium } from 'playwright'")
    expect(probe).toContain(
      "import { closeDevice, launchCdpElectronApplication } from './scripts/sync-e2e.mjs'",
    )
    expect(probe).toContain('application = await launchCdpElectronApplication({')
    expect(probe).toContain(
      'connectOverCDP: (endpoint, options) => chromium.connectOverCDP(endpoint, options)',
    )
    expect(probe).toContain("'--proxy-server=127.0.0.1:9'")
    expect(probe).toContain("'--proxy-bypass-list=<-loopback>'")
    expect(probe).toContain("'--disable-background-networking'")
    expect(probe).toContain('application.context().pages()')
    expect(probe).toContain('await closeDevice(')
    expect(probe).not.toContain('_electron')
    expect(probe).not.toMatch(/\belectron\.launch\s*\(/)
    expect(probe).not.toContain('application.close().catch(() => {})')
  })

  it('starts bounded sanitized process evidence at spawn before CDP readiness', () => {
    const probe = embeddedNodeSource(script, 'Invoke-PackagedRecoveryProbe')
    const launchStart = probe.indexOf('application = await launchCdpElectronApplication({')
    const onSpawnStart = probe.indexOf('onSpawn: child =>', launchStart)
    const connectStart = probe.indexOf('connectOverCDP:', launchStart)
    const evidenceStart = probe.indexOf('await writeFile(runtimeEvidencePath')
    const evidenceEnd = probe.indexOf('}, null, 2)', evidenceStart)
    const evidence = probe.slice(evidenceStart, evidenceEnd)

    expect(onSpawnStart).toBeGreaterThan(launchStart)
    expect(onSpawnStart).toBeLessThan(connectStart)
    expect(probe).toContain('startProcessObservation(child)')
    expect(probe).toContain('launchedProcess = child')
    expect(probe).toContain("launchedProcess.once('exit'")
    expect(probe).toContain("launchedProcess.stderr?.on?.('data'")
    expect(probe).toContain('titleMonitor =')
    expect(probe).toContain('MAX_CAPTURED_STDERR_CHARS')
    expect(probe).toContain('MAX_RECORDED_WINDOW_TITLES')
    expect(probe).toContain('MAX_RECORDED_TITLE_CHARS')
    expect(probe).toContain('sanitizeDiagnosticText')
    expect(probe).toContain(
      'const recoveryDialogTitle = /^(?:Baby Diary (?:recovery required|startup failed)|Error|\\uC624\\uB958|\\u30A8\\u30E9\\u30FC)$/i',
    )
    expect(Array.from(probe).filter(character => character.codePointAt(0)! > 0x7f)).toEqual([])
    expect(probe).not.toContain('"')
    expect(probe).toContain("'[redacted-path]'")
    expect(probe).toContain("'[redacted-url]'")
    expect(evidence).toContain('childPid,')
    expect(evidence).toContain('processExitObserved:')
    expect(evidence).toContain('processExitCode:')
    expect(evidence).toContain('processExitSignal:')
    expect(evidence).toContain('observedTopLevelWindowTitles: boundedTopLevelWindowTitles')
    expect(evidence).toContain('recoveryDialogCount:')
    expect(evidence).toContain('processStderr:')
    expect(evidence).toContain('titleHelperError:')
    expect(evidence).toContain('probeFailure:')
    expect(evidence).not.toMatch(/executablePath|profileRoot|dataDir|endpoint|\benv\b|\bport\b/)
    expect(probe).not.toContain('dataDir: dataInfo.dataDir')
  })

  it('captures a bounded sanitized Electron startup log without rapid PowerShell polling', () => {
    const probe = embeddedNodeSource(script, 'Invoke-PackagedRecoveryProbe')
    const evidenceStart = probe.indexOf('await writeFile(runtimeEvidencePath')
    const evidenceEnd = probe.indexOf('}, null, 2)', evidenceStart)
    const evidence = probe.slice(evidenceStart, evidenceEnd)

    expect(script).toContain("$processLogPath = Join-Path $runRoot 'electron-startup.log'")
    expect(script).toContain('-ProcessLogPath $processLogPath')
    expect(probe).toContain('const [executablePath, profileRoot, runtimeEvidencePath, processLogPath]')
    expect(probe).toContain("'--enable-logging=file'")
    expect(probe).toContain('`--log-file=${processLogPath}`')
    expect(probe).toContain('MAX_PROCESS_LOG_BYTES')
    expect(probe).toContain('await handle.read(buffer, 0, buffer.length, 0)')
    expect(probe).toContain('sanitizeDiagnosticText(')
    expect(probe).toContain('await delay(500)')
    expect(probe).not.toContain('await delay(100)')
    expect(evidence).toContain('processLog,')
    expect(evidence).not.toMatch(/processLogPath|electron-startup\.log|--log-file/)
  })

  it('executes the fixture helper and proves production recovery retires only verified pre-publication controls', async () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'baby-diary-installed-smoke-fixture-'))
    const profileRoot = join(runRoot, 'profile')
    const beforeManifestPath = join(runRoot, 'before-manifest.json')
    const beforeProjectionPath = join(runRoot, 'before-projection.json')
    try {
      execFileSync(process.execPath, [
        '--input-type=module',
        '-e',
        embeddedNodeSource(script, 'New-FalsePositivePrePublicationEvidence'),
        profileRoot,
        beforeManifestPath,
        beforeProjectionPath,
      ], { cwd: root, stdio: 'pipe' })

      const intentPath = join(profileRoot, '.baby-info-pair-restore-v1.json')
      const stagingPath = join(profileRoot, '.baby-info-pair-restore-v1')
      const transaction = JSON.parse(readFileSync(intentPath, 'utf8'))
      const forensicRoot = join(profileRoot, 'recovery-forensics')
      const archiveNames = readdirSync(forensicRoot)
      expect(archiveNames).toEqual([transaction.forensicArchiveId])

      const archivePath = join(forensicRoot, transaction.forensicArchiveId)
      const manifestBytes = readFileSync(join(archivePath, 'manifest.json'))
      const manifest = JSON.parse(manifestBytes.toString('utf8'))
      expect(manifest).toMatchObject({
        version: 1,
        source: 'baby-diary-recovery',
      })
      expect(transaction.forensicManifest).toEqual(descriptor(manifestBytes))
      expect(readdirSync(archivePath).sort()).toEqual([
        'baby-info-journal-v1.jsonl',
        'manifest.json',
        'settings.json',
      ])
      for (const entry of manifest.files) {
        expect(entry).toEqual({ path: entry.path, ...descriptor(readFileSync(join(archivePath, entry.path))) })
        expect(readFileSync(join(archivePath, entry.path))).toEqual(readFileSync(join(profileRoot, entry.path)))
      }

      const settingsBefore = readFileSync(join(profileRoot, 'settings.json'))
      const journalBefore = readFileSync(join(profileRoot, 'baby-info-journal-v1.jsonl'))
      const opaqueBefore = JSON.parse(settingsBefore.toString('utf8')).upgradeOpaque
      const { recoverSettingsAndJournalPair } = await import('../electron/store/backupSnapshot')
      expect(() => recoverSettingsAndJournalPair(profileRoot, {
        platform: 'win32',
        startupId: 'installed-smoke-fixture-boot',
      })).not.toThrow()

      expect(existsSync(intentPath)).toBe(false)
      expect(existsSync(stagingPath)).toBe(false)
      expect(existsSync(archivePath)).toBe(true)
      expect(readFileSync(join(profileRoot, 'settings.json'))).toEqual(settingsBefore)
      expect(readFileSync(join(profileRoot, 'baby-info-journal-v1.jsonl'))).toEqual(journalBefore)
      expect(JSON.parse(readFileSync(join(profileRoot, 'settings.json'), 'utf8')).upgradeOpaque)
        .toEqual(opaqueBefore)
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  it('continues the exact Windows startup publication sequence after retiring verified stale controls', () => {
    const runRoot = mkdtempSync(join(tmpdir(), 'baby-diary-installed-smoke-startup-'))
    const profileRoot = join(runRoot, 'profile')
    const beforeManifestPath = join(runRoot, 'before-manifest.json')
    const beforeProjectionPath = join(runRoot, 'before-projection.json')
    try {
      execFileSync(process.execPath, [
        '--input-type=module',
        '-e',
        embeddedNodeSource(script, 'New-FalsePositivePrePublicationEvidence'),
        profileRoot,
        beforeManifestPath,
        beforeProjectionPath,
      ], { cwd: root, stdio: 'pipe' })

      const recoveryEvidencePaths = [
        join(profileRoot, 'backups'),
        join(profileRoot, 'documents-backup'),
      ]
      const initialState = captureFirebaseProfileInitialState(profileRoot, {
        platform: 'win32',
        recoveryEvidencePaths,
      })

      expect(() => {
        const settingsStore = new SettingsStore(profileRoot, {
          platform: 'win32',
          startupId: 'installed-smoke-startup',
        })
        const eligibility = detectPreexistingFirebaseProfile(profileRoot, {
          platform: 'win32',
          initialState,
        })
        FirebasePersistenceRegistry.openAfterSettingsValidation(
          profileRoot,
          eligibility,
          settingsStore.get(),
          { platform: 'win32' },
        )
      }).not.toThrow()
    } finally {
      rmSync(runRoot, { recursive: true, force: true })
    }
  })

  it('derives dialog, additional-window, and process-exit evidence from observations and fails on each', () => {
    const probe = embeddedNodeSource(script, 'Invoke-PackagedRecoveryProbe')
    const dialogCount = findPropertyInitializers(probe, 'recoveryDialogCount')
    const additionalWindowCount = findPropertyInitializers(probe, 'additionalWindowCount')
    const processExitObserved = findPropertyInitializers(probe, 'processExitObserved')

    expect(dialogCount).toHaveLength(1)
    expect(ts.isPropertyAccessExpression(dialogCount[0])).toBe(true)
    expect(ts.isPropertyAccessExpression(dialogCount[0]) && dialogCount[0].name.text).toBe('length')
    expect(additionalWindowCount).toHaveLength(1)
    expect(additionalWindowCount[0].kind).not.toBe(ts.SyntaxKind.NumericLiteral)
    expect(processExitObserved).toHaveLength(1)
    expect(processExitObserved[0].kind).not.toBe(ts.SyntaxKind.FalseKeyword)
    expect(hasThrowingGuard(probe, 'recoveryDialogCount')).toBe(true)
    expect(hasThrowingGuard(probe, 'additionalWindowCount')).toBe(true)
    expect(hasThrowingGuard(probe, 'processExitObservedBeforeClose')).toBe(true)
  })

  it('records package, executable, before/after preservation, readiness, and retired recovery evidence', () => {
    expect(script).toContain('Get-FileHash -Algorithm SHA256')
    expect(script).toContain('packageSha256')
    expect(script).toContain('installedExecutable')
    expect(script).toContain('before-manifest.json')
    expect(script).toContain('after-manifest.json')
    expect(script).toContain('before-projection.json')
    expect(script).toContain('after-projection.json')
    expect(script).toContain('rendererReady')
    expect(script).toContain('semanticProjectionUnchanged')
    expect(script).toContain('activeRecoveryEvidenceCount')
    expect(script).toContain('Get-Content -Raw -Encoding utf8 -LiteralPath $runtimeEvidencePath')
    expect(script).toContain('Get-Content -Raw -Encoding utf8 -LiteralPath $comparisonPath')
    expect(script).toContain('installed-release-smoke-evidence.json')
  })

  it('records path-free reference and installed payload hash comparisons in success evidence', () => {
    const main = script.slice(script.indexOf('$SetupPath ='))
    const evidenceStart = main.indexOf('$evidence = [ordered]@{')
    const evidenceEnd = main.indexOf('($evidence | ConvertTo-Json', evidenceStart)
    const evidence = main.slice(evidenceStart, evidenceEnd)

    expect(main).toContain("$referenceAppAsarPath = Join-Path (Split-Path -Parent $ReferenceExecutablePath) 'resources\\app.asar'")
    expect(main).toContain("$installedAppAsarPath = Join-Path $installLocation 'resources\\app.asar'")
    expect(main).toContain('Get-FileHash -Algorithm SHA256 -LiteralPath $ReferenceExecutablePath')
    expect(main).toContain('Get-FileHash -Algorithm SHA256 -LiteralPath $referenceAppAsarPath')
    expect(main).toContain('Get-FileHash -Algorithm SHA256 -LiteralPath $installedExecutable')
    expect(main).toContain('Get-FileHash -Algorithm SHA256 -LiteralPath $installedAppAsarPath')
    expect(main).toContain('$executableSha256Match = [string]::Equals(')
    expect(main).toContain('$appAsarSha256Match = [string]::Equals(')
    expect(main).toMatch(/if \(-not \$executableSha256Match -or -not \$appAsarSha256Match\)[\s\S]*payload hashes do not match/i)

    expect(evidence).toContain('referenceExecutableSha256 = $referenceExecutableSha256')
    expect(evidence).toContain('installedExecutableSha256 = $installedExecutableSha256')
    expect(evidence).toContain('executableSha256Match = [bool]$executableSha256Match')
    expect(evidence).toContain('referenceAppAsarSha256 = $referenceAppAsarSha256')
    expect(evidence).toContain('installedAppAsarSha256 = $installedAppAsarSha256')
    expect(evidence).toContain('appAsarSha256Match = [bool]$appAsarSha256Match')
    expect(evidence).not.toMatch(/^\s*(?:setupPath|referenceExecutablePath|installedExecutable|profileRoot)\s*=/m)
  })

  it('fails on a pre-existing install and performs a silent install with deterministic registry discovery', () => {
    expect(script).toContain("PSObject.Properties['DisplayName']")
    expect(script).toContain("$displayName.Value -eq 'Baby Diary'")
    expect(script).not.toContain("$_.DisplayName -eq 'Baby Diary'")
    expect(script).toMatch(/pre-existing Baby Diary installation/i)
    expect(script).toMatch(/Start-Process[^\n]*SetupPath/)
    expect(script).toContain("'/S'")
    expect(script).toContain('$uninstallerPath = Get-UninstallerPath -UninstallString $entry.UninstallString')
    expect(script).toContain('$installLocation = Split-Path -Parent $uninstallerPath')
    expect(script).not.toContain('$entry.InstallLocation')
    expect(script).toContain("Join-Path $installLocation 'Baby Diary.exe'")
  })

  it('requires a silent install to leave no exact installed application process behind', () => {
    const main = script.slice(script.indexOf('$SetupPath ='))
    expect(script).toContain('function Get-ExactInstalledApplicationProcesses')
    expect(script).toContain('[IO.Path]::GetFullPath($ExecutablePath)')
    expect(script).toContain('[StringComparison]::OrdinalIgnoreCase')
    expect(script).toContain('$unexpectedInstalledProcesses = @(')
    expect(script).toContain('Get-ExactInstalledApplicationProcesses -ExecutablePath $installedExecutable')
    expect(script).toMatch(/unexpectedly launched the installed application/i)
    expect(script).not.toMatch(/Stop-Process|taskkill/i)
    expect(main.indexOf('$unexpectedInstalledProcesses = @('))
      .toBeLessThan(main.indexOf('-ExecutablePath $installedExecutable'))
  })

  it('checks trusted publisher/updater metadata, runs both E2E suites, and always uninstalls', () => {
    expect(script).toContain('Get-AuthenticodeSignature')
    expect(script).toContain('TimeStamperCertificate')
    expect(script).toContain('$signature.SignerCertificate.Subject')
    expect(script).toContain('GetCertHashString')
    expect(script).toContain('HashAlgorithmName]::SHA256')
    expect(script).not.toContain('GetNameInfo')
    expect(script).not.toContain('normalizePublisherSubject')
    expect(script).toContain('StringComparison]::Ordinal')
    expect(script).toContain('StringComparison]::OrdinalIgnoreCase')
    expect(script).toContain('WIN_EXPECTED_PUBLISHER')
    expect(script).toContain('WIN_EXPECTED_CERT_SHA256')
    expect(script).toContain('ExpectedCertificateSha256')
    expect(script).toContain('publisherName')
    expect(script).toContain('m.isCanonicalPublisherName(value, expected)')
    expect(script).not.toContain('.some(')
    expect(script).toContain('BABYDIARY_E2E_EXECUTABLE')
    expect(script).toContain('BABYDIARY_SYNC_E2E_EXECUTABLE')
    expect(script).toContain("Invoke-NpmScript -Name 'test:e2e'")
    expect(script).toContain("Invoke-NpmScript -Name 'test:e2e:sync'")
    expect(script).toContain('finally')
    expect(script).toMatch(/UninstallString/)
    expect(script).toMatch(/installation cleanup/i)
    expect(script).toContain("if ($SignaturePolicy -eq 'RequireTrusted')")
  })
})

describe('packaged E2E architecture attestation', () => {
  it('checks the main-process architecture when an installed smoke job supplies an expectation', () => {
    const e2e = source('scripts/mac-e2e.mjs')
    expect(e2e).toContain('BABYDIARY_EXPECTED_E2E_ARCH')
    expect(e2e).toMatch(/process\.arch/)
    expect(e2e).toMatch(/packaged architecture/)
  })
})
