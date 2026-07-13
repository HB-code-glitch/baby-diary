import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

function source(path: string) {
  const absolute = resolve(root, path)
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : ''
}

describe('installed Mac release smoke script', () => {
  const script = source('scripts/mac-installed-release-smoke.sh')

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

  it('fails on a pre-existing install and performs a silent install with deterministic registry discovery', () => {
    expect(script).toContain("DisplayName -eq 'Baby Diary'")
    expect(script).toMatch(/pre-existing Baby Diary installation/i)
    expect(script).toMatch(/Start-Process[^\n]*SetupPath/)
    expect(script).toContain("'/S'")
    expect(script).toContain('$uninstallerPath = Get-UninstallerPath -UninstallString $entry.UninstallString')
    expect(script).toContain('$installLocation = Split-Path -Parent $uninstallerPath')
    expect(script).not.toContain('$entry.InstallLocation')
    expect(script).toContain("Join-Path $installLocation 'Baby Diary.exe'")
  })

  it('checks trusted publisher/updater metadata, runs both E2E suites, and always uninstalls', () => {
    expect(script).toContain('Get-AuthenticodeSignature')
    expect(script).toContain('TimeStamperCertificate')
    expect(script).toContain('$signature.SignerCertificate.Subject')
    expect(script).not.toContain('GetNameInfo')
    expect(script).toContain('normalizePublisherSubject')
    expect(script).toContain('WIN_EXPECTED_PUBLISHER')
    expect(script).toContain('publisherName')
    expect(script).toContain('BABYDIARY_E2E_EXECUTABLE')
    expect(script).toContain('BABYDIARY_SYNC_E2E_EXECUTABLE')
    expect(script).toContain("Invoke-NpmScript -Name 'test:e2e'")
    expect(script).toContain("Invoke-NpmScript -Name 'test:e2e:sync'")
    expect(script).toContain('finally')
    expect(script).toMatch(/UninstallString/)
    expect(script).toMatch(/installation cleanup/i)
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
