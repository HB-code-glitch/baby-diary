import { describe, expect, it, vi } from 'vitest'

const verificationModule = import('../scripts/platform-release-verification.mjs').catch(() => ({}))

type CliModule = {
  parseMacSignatureDetails?: (output: string) => Record<string, unknown>
  parseMacEntitlements?: (output: string) => Record<string, boolean>
  inspectMacPackageWithRunner?: (descriptor: unknown, runtime: unknown) => Promise<Record<string, unknown>>
  inspectWindowsExecutableWithRunner?: (descriptor: unknown, runtime: unknown) => Promise<Record<string, unknown>>
  runPlatformReleaseCli?: (argv: string[], env: Record<string, string | undefined>, runtime?: unknown) => Promise<unknown>
}

async function api<K extends keyof CliModule>(name: K): Promise<NonNullable<CliModule[K]>> {
  const module = await verificationModule as CliModule
  expect(typeof module[name], `${String(name)} must be exported`).toBe('function')
  return module[name] as NonNullable<CliModule[K]>
}

const macCredentials = {
  MAC_CSC_LINK: 'fixture-p12',
  MAC_CSC_KEY_PASSWORD: 'fixture-password',
  MAC_CSC_NAME: 'Developer ID Application: HB-code-glitch (ABCDEF1234)',
  MAC_EXPECTED_TEAM_ID: 'ABCDEF1234',
  APPLE_API_KEY: 'fixture-key',
  APPLE_API_KEY_ID: 'FIXTURE123',
  APPLE_API_ISSUER: '00000000-0000-0000-0000-000000000000',
}

const expectedPublisher = 'CN=HB-code-glitch, O="Expected, Publisher", C=KR'

function minimalPe(machine = 0x8664) {
  const bytes = Buffer.alloc(256)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(128, 0x3c)
  bytes.write('PE\0\0', 128, 'binary')
  bytes.writeUInt16LE(machine, 132)
  return bytes
}

describe('native platform inspection adapters', () => {
  it('parses Developer ID authority, team, timestamp, and runtime flags fail-closed', async () => {
    const parse = await api('parseMacSignatureDetails')
    expect(parse([
      'Authority=Developer ID Application: HB-code-glitch (ABCDEF1234)',
      'TeamIdentifier=ABCDEF1234',
      'Timestamp=13 Jul 2026 at 12:00:00',
      'flags=0x10000(runtime) count=0 size=12',
    ].join('\n'))).toEqual({
      authority: 'Developer ID Application: HB-code-glitch (ABCDEF1234)',
      teamId: 'ABCDEF1234',
      timestamped: true,
      hardenedRuntime: true,
    })
    expect(parse('Authority=Apple Root CA')).toMatchObject({ timestamped: false, hardenedRuntime: false })
  })

  it('parses only true plist entitlement keys', async () => {
    const parse = await api('parseMacEntitlements')
    expect(parse(`<?xml version="1.0"?><plist><dict>
      <key>com.apple.security.cs.allow-jit</key><true/>
      <key>com.apple.security.get-task-allow</key><false/>
      <key>com.apple.security.application-groups</key><array><string>attacker.group</string></array>
    </dict></plist>`)).toEqual({
      'com.apple.security.cs.allow-jit': true,
      'com.apple.security.get-task-allow': false,
      'com.apple.security.application-groups': false,
    })
  })

  it('mounts a DMG read-only, inspects its app, validates notarization/stapling, and always detaches', async () => {
    const inspect = await api('inspectMacPackageWithRunner')
    const calls: Array<[string, string[]]> = []
    const run = vi.fn(async (command: string, args: string[]) => {
      calls.push([command, args])
      const commandLine = [command, ...args].join(' ')
      if (commandLine.includes('codesign -dv')) return {
        stdout: '',
        stderr: [
          'Authority=Developer ID Application: HB-code-glitch (ABCDEF1234)',
          'TeamIdentifier=ABCDEF1234',
          'Timestamp=13 Jul 2026 at 12:00:00',
          'flags=0x10000(runtime)',
        ].join('\n'),
      }
      if (commandLine.includes('--entitlements')) return {
        stdout: '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>',
        stderr: '',
      }
      if (command === 'lipo') return { stdout: 'x86_64 arm64\n', stderr: '' }
      if (command === 'spctl') return { stdout: '', stderr: 'accepted\nsource=Notarized Developer ID\n' }
      return { stdout: '', stderr: '' }
    })
    const remove = vi.fn(async () => {})

    const report = await inspect({
      kind: 'dmg',
      path: '/release/Baby Diary-0.3.9-universal.dmg',
      expectedArchitectures: ['arm64', 'x86_64'],
    }, {
      run,
      makeTempDir: async () => '/tmp/baby-diary-dmg',
      findApp: async () => '/tmp/baby-diary-dmg/Baby Diary.app',
      remove,
    })

    expect(report).toMatchObject({
      containerValid: true,
      signatureValid: true,
      authority: 'Developer ID Application: HB-code-glitch (ABCDEF1234)',
      teamId: 'ABCDEF1234',
      timestamped: true,
      hardenedRuntime: true,
      architectures: ['x86_64', 'arm64'],
      gatekeeperAccepted: true,
      notarized: true,
      stapled: true,
    })
    expect(calls).toContainEqual(['hdiutil', [
      'attach', '-readonly', '-nobrowse', '-mountpoint', '/tmp/baby-diary-dmg',
      '/release/Baby Diary-0.3.9-universal.dmg',
    ]])
    expect(calls).toContainEqual(['codesign', [
      '--verify', '--strict', '--verbose=4', '/release/Baby Diary-0.3.9-universal.dmg',
    ]])
    expect(calls).toContainEqual(['codesign', [
      '-dv', '--verbose=4', '/release/Baby Diary-0.3.9-universal.dmg',
    ]])
    expect(calls).toContainEqual(['hdiutil', ['detach', '/tmp/baby-diary-dmg']])
    expect(calls).toContainEqual(['xcrun', ['stapler', 'validate', '/release/Baby Diary-0.3.9-universal.dmg']])
    expect(remove).toHaveBeenCalledWith('/tmp/baby-diary-dmg')
  })

  it('extracts a ZIP without mounting and validates the stapled app inside it', async () => {
    const inspect = await api('inspectMacPackageWithRunner')
    const calls: Array<[string, string[]]> = []
    const run = async (command: string, args: string[]) => {
      calls.push([command, args])
      const line = [command, ...args].join(' ')
      if (line.includes('codesign -dv')) return {
        stdout: '',
        stderr: 'Authority=Developer ID Application: HB-code-glitch (ABCDEF1234)\nTeamIdentifier=ABCDEF1234\nTimestamp=x\nflags=0x10000(runtime)',
      }
      if (line.includes('--entitlements')) return { stdout: '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/></dict></plist>', stderr: '' }
      if (command === 'lipo') return { stdout: 'arm64', stderr: '' }
      if (command === 'spctl') return { stdout: 'accepted\nsource=Notarized Developer ID', stderr: '' }
      return { stdout: '', stderr: '' }
    }

    await inspect({ kind: 'zip', path: '/release/app.zip', expectedArchitectures: ['arm64'] }, {
      run,
      makeTempDir: async () => '/tmp/baby-diary-zip',
      findApp: async () => '/tmp/baby-diary-zip/Baby Diary.app',
      remove: async () => {},
    })

    expect(calls).toContainEqual(['ditto', ['-x', '-k', '/release/app.zip', '/tmp/baby-diary-zip']])
    expect(calls.some(([command, args]) => command === 'hdiutil' && args[0] === 'attach')).toBe(false)
    expect(calls).toContainEqual(['xcrun', ['stapler', 'validate', '/tmp/baby-diary-zip/Baby Diary.app']])
  })

  it('reads Windows Authenticode JSON and PE architecture with no shell interpolation', async () => {
    const inspect = await api('inspectWindowsExecutableWithRunner')
    const calls: Array<[string, string[], { env?: Record<string, string> } | undefined]> = []
    const report = await inspect({ role: 'installed-main', path: 'C:\\release\\Baby Diary.exe' }, {
      run: async (command: string, args: string[], options?: { env?: Record<string, string> }) => {
        calls.push([command, args, options])
        return {
          stdout: JSON.stringify({ status: 'Valid', publisher: expectedPublisher, timestamped: true }),
          stderr: '',
        }
      },
      readFile: async () => minimalPe(),
    })
    expect(report).toEqual({
      status: 'Valid',
      publisher: expectedPublisher,
      timestamped: true,
      machine: 'x64',
    })
    expect(calls[0][0]).toMatch(/powershell(?:\.exe)?$/i)
    expect(calls[0][1].join(' ')).not.toContain('Baby Diary.exe')
    expect(calls[0][1].join(' ')).toContain('$signature.SignerCertificate.Subject')
    expect(calls[0][1].join(' ')).not.toContain('GetNameInfo')
    expect(calls[0][2]?.env).toEqual({
      BABYDIARY_AUTHENTICODE_PATH: 'C:\\release\\Baby Diary.exe',
    })
  })
})

describe('platform release CLI fail-closed mode', () => {
  it('checks credentials without constructing an artifact inspector', async () => {
    const runCli = await api('runPlatformReleaseCli')
    const createDependencies = vi.fn(() => { throw new Error('must not construct artifact inspector') })
    await expect(runCli(['--platform', 'mac', '--credentials-only'], macCredentials, {
      createDependencies,
    })).resolves.toEqual({ platform: 'mac', credentialsOnly: true })
    expect(createDependencies).not.toHaveBeenCalled()
  })

  it('rejects missing credentials before any packaging command can run', async () => {
    const runCli = await api('runPlatformReleaseCli')
    const createDependencies = vi.fn()
    await expect(runCli(['--platform', 'mac', '--credentials-only'], {
      ...macCredentials,
      APPLE_API_KEY_ID: ' ',
    }, { createDependencies })).rejects.toThrow(/missing required release credential: APPLE_API_KEY_ID/)
    expect(createDependencies).not.toHaveBeenCalled()
  })
})
