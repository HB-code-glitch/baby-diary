import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const expectedPublisher = 'CN=HB-code-glitch, O="Expected, Publisher", C=KR'

function loadReleaseConfig() {
  const configPath = resolve(root, 'electron-builder.release.cjs')
  if (!existsSync(configPath)) return undefined

  const script = `process.stdout.write(JSON.stringify(require(${JSON.stringify(configPath)})))`
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      MAC_CSC_LINK: 'fixture-mac-link',
      MAC_CSC_KEY_PASSWORD: 'fixture-mac-password',
      MAC_CSC_NAME: 'Developer ID Application: HB-code-glitch (ABCDEF1234)',
      WIN_CSC_LINK: 'fixture-win-link',
      WIN_CSC_KEY_PASSWORD: 'fixture-win-password',
      WIN_EXPECTED_PUBLISHER: expectedPublisher,
      WIN_EXPECTED_CERT_SHA256: 'A'.repeat(64),
    },
  })
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}

function plistEntitlements(name: string) {
  const path = resolve(root, 'build', name)
  if (!existsSync(path)) return []
  const source = readFileSync(path, 'utf8')
  const entries = [...source.matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/g)]
  return entries.map(match => match[1]).sort()
}

describe('stable cross-platform application metadata', () => {
  it('pins app identity, version, company, file description, and ASCII shortcut metadata', () => {
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(packageJson.author).toEqual({ name: 'HB-code-glitch' })
    expect(packageJson.description).toBe('Baby Diary')
    expect(packageJson.build.appId).toBe('com.family.babydiary')
    expect(packageJson.build.productName).toBe('Baby Diary')
    expect(packageJson.build.win.legalTrademarks).toBe('HB-code-glitch')
    expect(packageJson.build.nsis.shortcutName).toBe('Baby Diary')
    expect(packageJson.build.nsis.shortcutName).toMatch(/^[\x20-\x7e]+$/)
    expect(packageJson.build.nsis.uninstallDisplayName).toBe('Baby Diary')
  })

  it('keeps the default branch and pull-request builder unsigned-capable', () => {
    expect(packageJson.build.forceCodeSigning).toBeUndefined()
    expect(packageJson.build.mac.identity).toBeUndefined()
    expect(packageJson.build.mac.notarize).toBeUndefined()
    expect(packageJson.build.win.signtoolOptions).toBeUndefined()
  })
})

describe('release-only electron-builder trust configuration', () => {
  it('requires signing and maps protected Mac credentials without weakening runtime policy', () => {
    const config = loadReleaseConfig()
    expect(config).toBeDefined()
    expect(config.forceCodeSigning).toBe(true)
    expect(config.mac).toMatchObject({
      forceCodeSigning: true,
      cscLink: 'fixture-mac-link',
      cscKeyPassword: 'fixture-mac-password',
      identity: 'Developer ID Application: HB-code-glitch (ABCDEF1234)',
      hardenedRuntime: true,
      strictVerify: true,
      notarize: true,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    })
  })

  it('requires Windows signing, exact publisher verification, SHA-256, and RFC3161 timestamping', () => {
    const config = loadReleaseConfig()
    expect(config).toBeDefined()
    expect(config.win).toMatchObject({
      forceCodeSigning: true,
      cscLink: 'fixture-win-link',
      cscKeyPassword: 'fixture-win-password',
      legalTrademarks: 'HB-code-glitch',
      signtoolOptions: {
        publisherName: expectedPublisher,
        signingHashAlgorithms: ['sha256'],
        rfc3161TimeStampServer: 'http://timestamp.digicert.com',
      },
    })
  })
})

describe('minimal Electron JIT entitlements', () => {
  it.each(['entitlements.mac.plist', 'entitlements.mac.inherit.plist'])(
    '%s contains only the two required runtime exceptions',
    (name) => {
      expect(plistEntitlements(name)).toEqual([
        'com.apple.security.cs.allow-jit',
        'com.apple.security.cs.allow-unsigned-executable-memory',
      ])
    },
  )
})

describe('release signing operator documentation', () => {
  it('documents every protected secret, its encoding, and dry-run isolation', () => {
    const path = resolve(root, 'docs', 'platform-release-signing.md')
    const source = existsSync(path) ? readFileSync(path, 'utf8') : ''

    for (const name of [
      'MAC_CSC_LINK',
      'MAC_CSC_KEY_PASSWORD',
      'MAC_CSC_NAME',
      'MAC_EXPECTED_TEAM_ID',
      'APPLE_API_KEY',
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER',
      'WIN_CSC_LINK',
      'WIN_CSC_KEY_PASSWORD',
      'WIN_EXPECTED_PUBLISHER',
      'WIN_EXPECTED_CERT_SHA256',
      'RELEASE_TOKEN',
    ]) {
      expect(source).toContain(name)
    }

    expect(source).toMatch(/base64/i)
    expect(source).toContain('Developer ID Application')
    expect(source).toContain('signed_package_dry_run')
    expect(source).toContain('does not create, update, upload, or publish a GitHub release')
    expect(source).toContain('`platform-release-signing`')
    expect(source).toContain('`platform-release-publish`')
    expect(source).toContain('`Required reviewers`')
    expect(source).toContain('`Prevent self-review`')
    expect(source).toContain('`Selected branches and tags`')
    expect(source).toContain('`master` 브랜치')
    expect(source).toContain('`v*` 태그')
    expect(source).toContain('전체 Subject DN')
    expect(source).toContain('CN=')
    expect(source).toContain('SignerCertificate.Subject')
    expect(source).toContain('GetCertHashString')
    expect(source).toContain('HashAlgorithmName]::SHA256')
    expect(source).toMatch(/64.*16진수/)
    expect(source).toContain('정규화하거나 재정렬하지 않는다')
  })
})
