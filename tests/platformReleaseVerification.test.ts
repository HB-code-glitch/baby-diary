import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const verificationModule = import('../scripts/platform-release-verification.mjs').catch(() => ({}))

type PlatformModule = {
  requiredCredentialErrors?: (platform: 'mac' | 'windows', env: Record<string, string | undefined>) => string[]
  verifyMacRelease?: (options: unknown, dependencies: unknown) => Promise<unknown>
  verifyWindowsRelease?: (options: unknown, dependencies: unknown) => Promise<unknown>
  readPeMachine?: (bytes: Buffer) => string
}

async function api<K extends keyof PlatformModule>(name: K): Promise<NonNullable<PlatformModule[K]>> {
  const module = await verificationModule as PlatformModule
  expect(typeof module[name], `${String(name)} must be exported`).toBe('function')
  return module[name] as NonNullable<PlatformModule[K]>
}

const version = '0.3.9'
const releaseDir = '/fixture/release'
const expectedIdentity = 'Developer ID Application: HB-code-glitch (ABCDEF1234)'
const expectedTeamId = 'ABCDEF1234'
const expectedPublisher = 'CN=HB-code-glitch, O="Expected, Publisher", C=KR'
const expectedCertificateSha256 = 'A'.repeat(64)
const sameCommonNameDifferentOrganization = 'CN=HB-code-glitch, O="Different, Publisher", C=KR'
const invalidPublisherNameFixtures: Array<[string, string, unknown]> = [
  ['scalar exact publisher', expectedPublisher, expectedPublisher],
  ['empty array', expectedPublisher, []],
  ['empty string', expectedPublisher, ''],
  ['duplicate expected publisher', expectedPublisher, [expectedPublisher, expectedPublisher]],
  ['extra alternate publisher', expectedPublisher, [expectedPublisher, 'CN=Attacker']],
  ['equivalent but non-identical RDN', 'CN=Acme,OU=Unit', ['CN=Acme+OU=Unit']],
  ['non-string element', expectedPublisher, [42]],
  ['mixed expected and non-string elements', expectedPublisher, [expectedPublisher, 42]],
]

const macCredentials = {
  MAC_CSC_LINK: 'fixture-p12',
  MAC_CSC_KEY_PASSWORD: 'fixture-password',
  MAC_CSC_NAME: expectedIdentity,
  MAC_EXPECTED_TEAM_ID: expectedTeamId,
  APPLE_API_KEY: 'fixture-api-key',
  APPLE_API_KEY_ID: 'FIXTURE123',
  APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
}

const windowsCredentials = {
  WIN_CSC_LINK: 'fixture-pfx',
  WIN_CSC_KEY_PASSWORD: 'fixture-password',
  WIN_EXPECTED_PUBLISHER: expectedPublisher,
  WIN_EXPECTED_CERT_SHA256: expectedCertificateSha256,
}

const windowsVerificationOptions = {
  version,
  releaseDir,
  expectedPublisher,
  expectedCertificateSha256,
}

function validMacReport(expectedArchitectures: string[]) {
  return {
    containerValid: true,
    signatureValid: true,
    authority: expectedIdentity,
    teamId: expectedTeamId,
    timestamped: true,
    hardenedRuntime: true,
    entitlements: {
      'com.apple.security.cs.allow-jit': true,
      'com.apple.security.cs.allow-unsigned-executable-memory': true,
    },
    architectures: expectedArchitectures,
    gatekeeperAccepted: true,
    notarized: true,
    stapled: true,
  }
}

function validWindowsReport(role: string) {
  return {
    status: 'Valid',
    publisher: expectedPublisher,
    certificateSha256: expectedCertificateSha256,
    timestamped: true,
    machine: role === 'installed-main' ? 'x64' : 'x86',
  }
}

function setupBytes() {
  return Buffer.from('signed-setup-fixture')
}

function windowsYamlFixtures() {
  const bytes = setupBytes()
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  return {
    latest: {
      version,
      path: `Baby-Diary-Setup-${version}.exe`,
      sha512,
      files: [{ url: `Baby-Diary-Setup-${version}.exe`, sha512, size: bytes.length }],
    },
    appUpdate: {
      provider: 'github',
      owner: 'HB-code-glitch',
      repo: 'baby-diary-releases',
      publisherName: [expectedPublisher],
    },
  }
}

describe('release credential fail-closed gate', () => {
  it('accepts only complete trusted Mac and Windows credential sets', async () => {
    const requiredCredentialErrors = await api('requiredCredentialErrors')
    expect(requiredCredentialErrors('mac', macCredentials)).toEqual([])
    expect(requiredCredentialErrors('windows', windowsCredentials)).toEqual([])
  })

  it('reports every missing or whitespace-only secret by name without exposing values', async () => {
    const requiredCredentialErrors = await api('requiredCredentialErrors')
    const macErrors = requiredCredentialErrors('mac', {
      ...macCredentials,
      MAC_CSC_LINK: '   ',
      APPLE_API_KEY_ID: undefined,
    })
    expect(macErrors).toEqual(expect.arrayContaining([
      'missing required release credential: MAC_CSC_LINK',
      'missing required release credential: APPLE_API_KEY_ID',
    ]))
    expect(macErrors.join('\n')).not.toContain('fixture-password')

    const windowsErrors = requiredCredentialErrors('windows', {
      ...windowsCredentials,
      WIN_CSC_KEY_PASSWORD: '',
      WIN_EXPECTED_PUBLISHER: ' ',
    })
    expect(windowsErrors).toEqual(expect.arrayContaining([
      'missing required release credential: WIN_CSC_KEY_PASSWORD',
      'missing required release credential: WIN_EXPECTED_PUBLISHER',
    ]))
  })

  it('rejects a bare common name instead of accepting it as the expected certificate Subject', async () => {
    const requiredCredentialErrors = await api('requiredCredentialErrors')
    expect(requiredCredentialErrors('windows', {
      ...windowsCredentials,
      WIN_EXPECTED_PUBLISHER: 'HB-code-glitch',
    })).toContain('WIN_EXPECTED_PUBLISHER must be a full Subject DN containing CN')
  })

  it('requires a well-formed SHA-256 certificate thumbprint before packaging', async () => {
    const requiredCredentialErrors = await api('requiredCredentialErrors')
    expect(requiredCredentialErrors('windows', {
      ...windowsCredentials,
      WIN_EXPECTED_CERT_SHA256: undefined,
    })).toContain('missing required release credential: WIN_EXPECTED_CERT_SHA256')
    expect(requiredCredentialErrors('windows', {
      ...windowsCredentials,
      WIN_EXPECTED_CERT_SHA256: 'not-a-sha256-thumbprint',
    })).toContain('WIN_EXPECTED_CERT_SHA256 must be a 64-character hexadecimal SHA-256 certificate thumbprint')
    expect(requiredCredentialErrors('windows', {
      ...windowsCredentials,
      WIN_EXPECTED_CERT_SHA256: expectedCertificateSha256.toLowerCase(),
    })).toEqual([])
    expect(requiredCredentialErrors('windows', {
      ...windowsCredentials,
      WIN_EXPECTED_CERT_SHA256: ` ${expectedCertificateSha256}`,
    })).toContain('WIN_EXPECTED_CERT_SHA256 must be a 64-character hexadecimal SHA-256 certificate thumbprint')
  })

  it('rejects an ad-hoc, development, or malformed Mac identity before packaging', async () => {
    const requiredCredentialErrors = await api('requiredCredentialErrors')
    for (const identity of ['-', 'Apple Development: Example', 'Developer ID Installer: Example']) {
      expect(requiredCredentialErrors('mac', { ...macCredentials, MAC_CSC_NAME: identity })).toContain(
        'MAC_CSC_NAME must be a Developer ID Application identity containing MAC_EXPECTED_TEAM_ID',
      )
    }
  })
})

describe('Mac signed artifact verification with an injected runner', () => {
  it('verifies both DMG and ZIP containers for arm64 and universal without running real commands', async () => {
    const verifyMacRelease = await api('verifyMacRelease')
    const calls: Array<{ path: string; kind: string; expectedArchitectures: string[] }> = []
    const result = await verifyMacRelease({
      version,
      releaseDir,
      expectedIdentity,
      expectedTeamId,
    }, {
      exists: async () => true,
      inspectPackage: async (descriptor: { path: string; kind: string; expectedArchitectures: string[] }) => {
        calls.push(descriptor)
        return validMacReport(descriptor.expectedArchitectures)
      },
    }) as { packageCount: number }

    expect(result.packageCount).toBe(4)
    expect(calls.map(call => [call.kind, call.path, call.expectedArchitectures])).toEqual([
      ['dmg', join(releaseDir, `Baby Diary-${version}-arm64.dmg`), ['arm64']],
      ['dmg', join(releaseDir, `Baby Diary-${version}-universal.dmg`), ['arm64', 'x86_64']],
      ['zip', join(releaseDir, `Baby Diary-${version}-arm64-mac.zip`), ['arm64']],
      ['zip', join(releaseDir, `Baby Diary-${version}-universal-mac.zip`), ['arm64', 'x86_64']],
    ])
  })

  it.each([
    ['unsigned', { signatureValid: false }, /valid Developer ID signature/],
    ['wrong authority', { authority: 'Developer ID Application: Attacker (ABCDEF1234)' }, /Developer ID authority/],
    ['wrong team', { teamId: 'ZZZZZZ9999' }, /TeamIdentifier/],
    ['untimestamped', { timestamped: false }, /secure timestamp/],
    ['no hardened runtime', { hardenedRuntime: false }, /hardened runtime/],
    ['forbidden entitlement', { entitlements: { 'com.apple.security.cs.allow-jit': true, 'com.apple.security.get-task-allow': true } }, /forbidden Mac entitlement/],
    ['missing JIT entitlement', { entitlements: {} }, /required Mac entitlement/],
    ['one missing architecture', { architectures: ['arm64'] }, /architectures/],
    ['not notarized', { gatekeeperAccepted: false, notarized: false }, /notarized Gatekeeper/],
    ['unstapled', { stapled: false }, /stapled notarization ticket/],
    ['invalid container', { containerValid: false }, /container verification/],
  ])('rejects a %s package report', async (_label, mutation, message) => {
    const verifyMacRelease = await api('verifyMacRelease')
    await expect(verifyMacRelease({
      version,
      releaseDir,
      expectedIdentity,
      expectedTeamId,
    }, {
      exists: async () => true,
      inspectPackage: async (descriptor: { expectedArchitectures: string[] }) => ({
        ...validMacReport(descriptor.expectedArchitectures),
        ...(descriptor.expectedArchitectures.length === 2 ? mutation : {}),
      }),
    })).rejects.toThrow(message as RegExp)
  })

  it('fails before inspection when any expected package is absent', async () => {
    const verifyMacRelease = await api('verifyMacRelease')
    await expect(verifyMacRelease({ version, releaseDir, expectedIdentity, expectedTeamId }, {
      exists: async (path: string) => !path.endsWith(`-${version}-universal.dmg`),
      inspectPackage: async () => validMacReport(['arm64']),
    })).rejects.toThrow(/missing signed Mac package.*universal\.dmg/)
  })
})

describe('Windows Authenticode, publisher, architecture, and updater verification', () => {
  it('verifies Setup, portable, installed main, elevate, and signed updater metadata through fixtures', async () => {
    const verifyWindowsRelease = await api('verifyWindowsRelease')
    const yaml = windowsYamlFixtures()
    const calls: string[] = []
    const result = await verifyWindowsRelease(windowsVerificationOptions, {
      exists: async () => true,
      inspectExecutable: async (descriptor: { path: string; role: string }) => {
        calls.push(descriptor.role)
        return validWindowsReport(descriptor.role)
      },
      readBytes: async () => setupBytes(),
      readYaml: async (path: string) => path.endsWith('latest.yml') ? yaml.latest : yaml.appUpdate,
    }) as { executableCount: number }

    expect(result.executableCount).toBe(4)
    expect(calls).toEqual(['setup', 'portable', 'installed-main', 'elevate'])
  })

  it.each([
    ['escaped leading space', 'CN=Acme', 'CN=\\ Acme'],
    ['escaped trailing space', 'CN=Acme', 'CN=Acme\\ '],
    ['multi-valued RDN', 'CN=Acme,OU=Unit', 'CN=Acme+OU=Unit'],
    ['embedded quotes', 'CN=Acme', 'CN=A"c"me'],
  ])('rejects a non-identical %s Subject instead of normalizing it to the expected identity', async (_label, exactSubject, bypassSubject) => {
    const verifyWindowsRelease = await api('verifyWindowsRelease')
    const yaml = windowsYamlFixtures()
    await expect(verifyWindowsRelease({
      ...windowsVerificationOptions,
      expectedPublisher: exactSubject,
    }, {
      exists: async () => true,
      inspectExecutable: async (descriptor: { role: string }) => ({
        ...validWindowsReport(descriptor.role),
        publisher: bypassSubject,
      }),
      readBytes: async () => setupBytes(),
      readYaml: async (path: string) => path.endsWith('latest.yml')
        ? yaml.latest
        : { ...yaml.appUpdate, publisherName: [exactSubject] },
    })).rejects.toThrow(/expected publisher/)
  })

  it.each(invalidPublisherNameFixtures)(
    'rejects %s in app-update.yml',
    async (_label, exactSubject, invalidPublisherName) => {
      const verifyWindowsRelease = await api('verifyWindowsRelease')
      const yaml = windowsYamlFixtures()
      await expect(verifyWindowsRelease({
        ...windowsVerificationOptions,
        expectedPublisher: exactSubject,
      }, {
        exists: async () => true,
        inspectExecutable: async (descriptor: { role: string }) => ({
          ...validWindowsReport(descriptor.role),
          publisher: exactSubject,
        }),
        readBytes: async () => setupBytes(),
        readYaml: async (path: string) => path.endsWith('latest.yml')
          ? yaml.latest
          : { ...yaml.appUpdate, publisherName: invalidPublisherName },
      })).rejects.toThrow(/app-update\.yml publisherName/)
    },
  )

  it.each([
    ['unsigned', { status: 'NotSigned' }, /valid Authenticode/],
    ['invalid chain', { status: 'HashMismatch' }, /valid Authenticode/],
    ['same CN but different organization', { publisher: sameCommonNameDifferentOrganization }, /expected publisher/],
    ['untimestamped', { timestamped: false }, /trusted timestamp/],
  ])('rejects a %s executable', async (_label, mutation, message) => {
    const verifyWindowsRelease = await api('verifyWindowsRelease')
    const yaml = windowsYamlFixtures()
    await expect(verifyWindowsRelease(windowsVerificationOptions, {
      exists: async () => true,
      inspectExecutable: async (descriptor: { role: string }) => ({
        ...validWindowsReport(descriptor.role),
        ...(descriptor.role === 'setup' ? mutation : {}),
      }),
      readBytes: async () => setupBytes(),
      readYaml: async (path: string) => path.endsWith('latest.yml') ? yaml.latest : yaml.appUpdate,
    })).rejects.toThrow(message as RegExp)
  })

  it.each(['setup', 'portable', 'installed-main', 'elevate'])(
    'rejects a different %s signing certificate even when its full Subject matches exactly',
    async mismatchedRole => {
      const verifyWindowsRelease = await api('verifyWindowsRelease')
      const yaml = windowsYamlFixtures()
      await expect(verifyWindowsRelease(windowsVerificationOptions, {
        exists: async () => true,
        inspectExecutable: async (descriptor: { role: string }) => ({
          ...validWindowsReport(descriptor.role),
          ...(descriptor.role === mismatchedRole ? { certificateSha256: 'B'.repeat(64) } : {}),
        }),
        readBytes: async () => setupBytes(),
        readYaml: async (path: string) => path.endsWith('latest.yml') ? yaml.latest : yaml.appUpdate,
      })).rejects.toThrow(/certificate SHA-256 thumbprint/)
    },
  )

  it('rejects a non-x64 installed app while allowing x86 NSIS wrappers', async () => {
    const verifyWindowsRelease = await api('verifyWindowsRelease')
    const yaml = windowsYamlFixtures()
    await expect(verifyWindowsRelease(windowsVerificationOptions, {
      exists: async () => true,
      inspectExecutable: async (descriptor: { role: string }) => ({
        ...validWindowsReport(descriptor.role),
        machine: descriptor.role === 'installed-main' ? 'x86' : 'x86',
      }),
      readBytes: async () => setupBytes(),
      readYaml: async (path: string) => path.endsWith('latest.yml') ? yaml.latest : yaml.appUpdate,
    })).rejects.toThrow(/installed application must be x64/)
  })

  it('rejects missing publisherName and Setup metadata not bound to the signed bytes', async () => {
    const verifyWindowsRelease = await api('verifyWindowsRelease')
    const yaml = windowsYamlFixtures()
    const dependencies = (appUpdate: unknown, latest = yaml.latest) => ({
      exists: async () => true,
      inspectExecutable: async (descriptor: { role: string }) => validWindowsReport(descriptor.role),
      readBytes: async () => setupBytes(),
      readYaml: async (path: string) => path.endsWith('latest.yml') ? latest : appUpdate,
    })

    await expect(verifyWindowsRelease(windowsVerificationOptions, dependencies({
      ...yaml.appUpdate,
      publisherName: undefined,
    }))).rejects.toThrow(/publisherName/)

    await expect(verifyWindowsRelease(windowsVerificationOptions, dependencies(
      yaml.appUpdate,
      { ...yaml.latest, sha512: Buffer.alloc(64).toString('base64') },
    ))).rejects.toThrow(/latest\.yml.*signed Setup bytes/)
  })

  it('fails before signature inspection when an expected executable is missing', async () => {
    const verifyWindowsRelease = await api('verifyWindowsRelease')
    const yaml = windowsYamlFixtures()
    await expect(verifyWindowsRelease(windowsVerificationOptions, {
      exists: async (path: string) => !path.endsWith('elevate.exe'),
      inspectExecutable: async (descriptor: { role: string }) => validWindowsReport(descriptor.role),
      readBytes: async () => setupBytes(),
      readYaml: async (path: string) => path.endsWith('latest.yml') ? yaml.latest : yaml.appUpdate,
    })).rejects.toThrow(/missing signed Windows executable.*elevate\.exe/)
  })
})

describe('PE architecture parser', () => {
  it('reads x64 and x86 machine fields from a minimal PE header', async () => {
    const readPeMachine = await api('readPeMachine')
    const pe = (machine: number) => {
      const bytes = Buffer.alloc(256)
      bytes.write('MZ', 0, 'ascii')
      bytes.writeUInt32LE(128, 0x3c)
      bytes.write('PE\0\0', 128, 'binary')
      bytes.writeUInt16LE(machine, 132)
      return bytes
    }
    expect(readPeMachine(pe(0x8664))).toBe('x64')
    expect(readPeMachine(pe(0x014c))).toBe('x86')
    expect(() => readPeMachine(Buffer.from('not-pe'))).toThrow(/valid PE/)
  })
})
