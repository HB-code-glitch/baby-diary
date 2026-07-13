import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const MAC_CREDENTIALS = [
  'MAC_CSC_LINK',
  'MAC_CSC_KEY_PASSWORD',
  'MAC_CSC_NAME',
  'MAC_EXPECTED_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER',
]

const WINDOWS_CREDENTIALS = [
  'WIN_CSC_LINK',
  'WIN_CSC_KEY_PASSWORD',
  'WIN_EXPECTED_PUBLISHER',
  'WIN_EXPECTED_CERT_SHA256',
]

const REQUIRED_MAC_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
]

function present(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isFullPublisherSubject(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) return false
  if (!/^(?:[A-Z][A-Z0-9.-]*|\d+(?:\.\d+)+)=/.test(value)) return false
  return /(?:^|,\s*)CN=(?!,|$)./.test(value)
}

function canonicalCertificateSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
    ? value.toUpperCase()
    : null
}

export function requiredCredentialErrors(platform, env) {
  const names = platform === 'mac' ? MAC_CREDENTIALS : WINDOWS_CREDENTIALS
  const errors = names
    .filter(name => !present(env[name]))
    .map(name => `missing required release credential: ${name}`)

  if (platform === 'mac' && present(env.MAC_CSC_NAME) && present(env.MAC_EXPECTED_TEAM_ID)) {
    const identity = env.MAC_CSC_NAME.trim()
    const teamId = env.MAC_EXPECTED_TEAM_ID.trim()
    if (!identity.startsWith('Developer ID Application: ') || !identity.includes(`(${teamId})`)) {
      errors.push('MAC_CSC_NAME must be a Developer ID Application identity containing MAC_EXPECTED_TEAM_ID')
    }
  }
  if (platform === 'windows'
    && present(env.WIN_EXPECTED_PUBLISHER)
    && !isFullPublisherSubject(env.WIN_EXPECTED_PUBLISHER)) {
    errors.push('WIN_EXPECTED_PUBLISHER must be a full Subject DN containing CN')
  }
  if (platform === 'windows'
    && present(env.WIN_EXPECTED_CERT_SHA256)
    && canonicalCertificateSha256(env.WIN_EXPECTED_CERT_SHA256) === null) {
    errors.push('WIN_EXPECTED_CERT_SHA256 must be a 64-character hexadecimal SHA-256 certificate thumbprint')
  }

  return errors
}

function sameStringSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false
  const actualSet = new Set(actual)
  return actualSet.size === expected.length && expected.every(value => actualSet.has(value))
}

function validateMacReport(descriptor, report, options) {
  const errors = []
  const label = descriptor.path

  if (report.containerValid !== true) errors.push(`${label}: container verification failed`)
  if (report.signatureValid !== true) errors.push(`${label}: expected a valid Developer ID signature`)
  if (report.authority !== options.expectedIdentity) errors.push(`${label}: Developer ID authority does not match`)
  if (report.teamId !== options.expectedTeamId) errors.push(`${label}: TeamIdentifier does not match`)
  if (report.timestamped !== true) errors.push(`${label}: signature has no secure timestamp`)
  if (report.hardenedRuntime !== true) errors.push(`${label}: hardened runtime is not enabled`)

  const entitlements = report.entitlements && typeof report.entitlements === 'object'
    ? report.entitlements
    : {}
  for (const key of Object.keys(entitlements)) {
    if (!REQUIRED_MAC_ENTITLEMENTS.includes(key) || entitlements[key] !== true) {
      errors.push(`${label}: forbidden Mac entitlement: ${key}`)
    }
  }
  for (const key of REQUIRED_MAC_ENTITLEMENTS) {
    if (entitlements[key] !== true) errors.push(`${label}: required Mac entitlement is missing: ${key}`)
  }

  if (!sameStringSet(report.architectures, descriptor.expectedArchitectures)) {
    errors.push(`${label}: architectures do not match ${descriptor.expectedArchitectures.join(', ')}`)
  }
  if (report.gatekeeperAccepted !== true || report.notarized !== true) {
    errors.push(`${label}: notarized Gatekeeper assessment failed`)
  }
  if (report.stapled !== true) errors.push(`${label}: stapled notarization ticket is missing`)

  return errors
}

export async function verifyMacRelease(options, dependencies) {
  const descriptors = [
    {
      kind: 'dmg',
      path: join(options.releaseDir, `Baby Diary-${options.version}-arm64.dmg`),
      expectedArchitectures: ['arm64'],
    },
    {
      kind: 'dmg',
      path: join(options.releaseDir, `Baby Diary-${options.version}-universal.dmg`),
      expectedArchitectures: ['arm64', 'x86_64'],
    },
    {
      kind: 'zip',
      path: join(options.releaseDir, `Baby Diary-${options.version}-arm64-mac.zip`),
      expectedArchitectures: ['arm64'],
    },
    {
      kind: 'zip',
      path: join(options.releaseDir, `Baby Diary-${options.version}-universal-mac.zip`),
      expectedArchitectures: ['arm64', 'x86_64'],
    },
  ]

  const errors = []
  for (const descriptor of descriptors) {
    if (!await dependencies.exists(descriptor.path)) {
      errors.push(`missing signed Mac package: ${descriptor.path}`)
      continue
    }
    const report = await dependencies.inspectPackage(descriptor)
    errors.push(...validateMacReport(descriptor, report, options))
  }

  if (errors.length > 0) throw new Error(errors.join('\n'))
  return { packageCount: descriptors.length }
}

function validateWindowsReport(descriptor, report, options) {
  const errors = []
  const label = descriptor.path
  if (report.status !== 'Valid') errors.push(`${label}: expected valid Authenticode status`)
  if (report.publisher !== options.expectedPublisher) {
    errors.push(`${label}: expected publisher does not match`)
  }
  if (canonicalCertificateSha256(report.certificateSha256) !== options.expectedCertificateSha256) {
    errors.push(`${label}: certificate SHA-256 thumbprint does not match`)
  }
  if (report.timestamped !== true) errors.push(`${label}: trusted timestamp is missing`)
  if (descriptor.role === 'installed-main' && report.machine !== 'x64') {
    errors.push(`${label}: installed application must be x64`)
  }
  return errors
}

function normalizedArtifactName(value) {
  return String(value ?? '').replaceAll(' ', '-').replaceAll('\\', '/').split('/').at(-1)
}

export function isCanonicalPublisherName(value, expectedPublisher) {
  return Array.isArray(value)
    && value.length === 1
    && typeof value[0] === 'string'
    && value[0] === expectedPublisher
}

function validateWindowsUpdaterMetadata({ version, expectedPublisher, setupBytes, latest, appUpdate }) {
  const errors = []
  const expectedName = `Baby-Diary-Setup-${version}.exe`
  const expectedSha512 = createHash('sha512').update(setupBytes).digest('base64')
  const expectedSize = setupBytes.length

  if (!isCanonicalPublisherName(appUpdate?.publisherName, expectedPublisher)) {
    errors.push('app-update.yml publisherName must be exactly one expected publisher')
  }

  const primaryFile = Array.isArray(latest?.files)
    ? latest.files.find(file => normalizedArtifactName(file?.url) === expectedName)
    : undefined
  const topLevelMatches = latest?.version === version
    && normalizedArtifactName(latest?.path) === expectedName
    && latest?.sha512 === expectedSha512
  const fileMatches = primaryFile?.sha512 === expectedSha512 && primaryFile?.size === expectedSize

  if (!topLevelMatches || !fileMatches) {
    errors.push('latest.yml is not bound to the signed Setup bytes')
  }

  return errors
}

export async function verifyWindowsRelease(options, dependencies) {
  if (!isFullPublisherSubject(options.expectedPublisher)) {
    throw new Error('expected Windows publisher must be a full Subject DN containing CN')
  }
  const expectedCertificateSha256 = canonicalCertificateSha256(options.expectedCertificateSha256)
  if (expectedCertificateSha256 === null) {
    throw new Error('expected Windows certificate SHA-256 thumbprint must be 64 hexadecimal characters')
  }
  const descriptors = [
    { role: 'setup', path: join(options.releaseDir, `Baby Diary Setup ${options.version}.exe`) },
    { role: 'portable', path: join(options.releaseDir, `Baby Diary ${options.version}.exe`) },
    { role: 'installed-main', path: join(options.releaseDir, 'win-unpacked', 'Baby Diary.exe') },
    { role: 'elevate', path: join(options.releaseDir, 'win-unpacked', 'resources', 'elevate.exe') },
  ]

  const errors = []
  for (const descriptor of descriptors) {
    if (!await dependencies.exists(descriptor.path)) {
      errors.push(`missing signed Windows executable: ${descriptor.path}`)
      continue
    }
    const report = await dependencies.inspectExecutable(descriptor)
    errors.push(...validateWindowsReport(descriptor, report, {
      expectedPublisher: options.expectedPublisher,
      expectedCertificateSha256,
    }))
  }

  const setupPath = descriptors[0].path
  if (await dependencies.exists(setupPath)) {
    const setupBytes = await dependencies.readBytes(setupPath)
    const latest = await dependencies.readYaml(join(options.releaseDir, 'latest.yml'))
    const appUpdate = await dependencies.readYaml(join(
      options.releaseDir,
      'win-unpacked',
      'resources',
      'app-update.yml',
    ))
    errors.push(...validateWindowsUpdaterMetadata({
      version: options.version,
      expectedPublisher: options.expectedPublisher,
      setupBytes,
      latest,
      appUpdate,
    }))
  }

  if (errors.length > 0) throw new Error(errors.join('\n'))
  return { executableCount: descriptors.length }
}

export function readPeMachine(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('not a valid PE executable')
  }
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset < 0 || peOffset + 6 > bytes.length || bytes.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('not a valid PE executable')
  }
  const machine = bytes.readUInt16LE(peOffset + 4)
  if (machine === 0x8664) return 'x64'
  if (machine === 0x014c) return 'x86'
  throw new Error('not a valid PE executable')
}

export function parseMacSignatureDetails(output) {
  const lines = String(output).split(/\r?\n/)
  const authorities = lines
    .filter(line => line.startsWith('Authority='))
    .map(line => line.slice('Authority='.length).trim())
  const authority = authorities.find(value => value.startsWith('Developer ID Application:')) ?? authorities[0]
  const teamId = lines.find(line => line.startsWith('TeamIdentifier='))?.slice('TeamIdentifier='.length).trim()

  return {
    authority,
    teamId,
    timestamped: lines.some(line => /^Timestamp=\S/.test(line)),
    hardenedRuntime: lines.some(line => /^flags=.*\bruntime\b/i.test(line)),
  }
}

export function parseMacEntitlements(output) {
  const entitlements = {}
  const source = String(output)
  const pattern = /<key>([^<]+)<\/key>/g
  for (const match of source.matchAll(pattern)) {
    const value = source.slice((match.index ?? 0) + match[0].length)
      .match(/^\s*<(true|false)\s*\/>/)?.[1]
    entitlements[match[1]] = value === 'true'
  }
  return entitlements
}

function combinedOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

async function inspectMacApp(appPath, runtime) {
  const executablePath = join(appPath, 'Contents', 'MacOS', 'Baby Diary')
  await runtime.run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath])
  const detailsResult = await runtime.run('codesign', ['-dv', '--verbose=4', appPath])
  const entitlementsResult = await runtime.run('codesign', ['-d', '--entitlements', ':-', appPath])
  const architecturesResult = await runtime.run('lipo', ['-archs', executablePath])
  const gatekeeperResult = await runtime.run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
  await runtime.run('xcrun', ['stapler', 'validate', appPath])

  const gatekeeperOutput = combinedOutput(gatekeeperResult)
  return {
    signatureValid: true,
    ...parseMacSignatureDetails(combinedOutput(detailsResult)),
    entitlements: parseMacEntitlements(combinedOutput(entitlementsResult)),
    architectures: String(architecturesResult.stdout ?? '').trim().split(/\s+/).filter(Boolean),
    gatekeeperAccepted: /\baccepted\b/i.test(gatekeeperOutput),
    notarized: /source=Notarized Developer ID/i.test(gatekeeperOutput),
    stapled: true,
  }
}

export async function inspectMacPackageWithRunner(descriptor, runtime) {
  const temporaryPath = await runtime.makeTempDir()
  let mounted = false
  let primaryError
  let result

  try {
    if (descriptor.kind === 'dmg') {
      await runtime.run('hdiutil', ['verify', descriptor.path])
      await runtime.run('hdiutil', [
        'attach',
        '-readonly',
        '-nobrowse',
        '-mountpoint',
        temporaryPath,
        descriptor.path,
      ])
      mounted = true
    } else if (descriptor.kind === 'zip') {
      await runtime.run('ditto', ['-x', '-k', descriptor.path, temporaryPath])
    } else {
      throw new Error(`unsupported Mac package kind: ${descriptor.kind}`)
    }

    const appPath = await runtime.findApp(temporaryPath)
    const appReport = await inspectMacApp(appPath, runtime)
    let packageGatekeeperAccepted = true
    let packageNotarized = true
    let packageSignatureDetails = null

    if (descriptor.kind === 'dmg') {
      await runtime.run('codesign', ['--verify', '--strict', '--verbose=4', descriptor.path])
      const packageDetailsResult = await runtime.run('codesign', ['-dv', '--verbose=4', descriptor.path])
      packageSignatureDetails = parseMacSignatureDetails(combinedOutput(packageDetailsResult))
      const packageGatekeeper = await runtime.run('spctl', [
        '--assess',
        '--type',
        'open',
        '--context',
        'context:primary-signature',
        '--verbose=4',
        descriptor.path,
      ])
      const gatekeeperOutput = combinedOutput(packageGatekeeper)
      packageGatekeeperAccepted = /\baccepted\b/i.test(gatekeeperOutput)
      packageNotarized = /source=Notarized Developer ID/i.test(gatekeeperOutput)
      await runtime.run('xcrun', ['stapler', 'validate', descriptor.path])
    }

    result = {
      containerValid: true,
      ...appReport,
      authority: packageSignatureDetails == null || packageSignatureDetails.authority === appReport.authority
        ? appReport.authority
        : undefined,
      teamId: packageSignatureDetails == null || packageSignatureDetails.teamId === appReport.teamId
        ? appReport.teamId
        : undefined,
      timestamped: appReport.timestamped
        && (packageSignatureDetails == null || packageSignatureDetails.timestamped),
      gatekeeperAccepted: appReport.gatekeeperAccepted && packageGatekeeperAccepted,
      notarized: appReport.notarized && packageNotarized,
    }
  } catch (error) {
    primaryError = error
  }

  const cleanupErrors = []
  if (mounted) {
    try {
      await runtime.run('hdiutil', ['detach', temporaryPath])
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  try {
    await runtime.remove(temporaryPath)
  } catch (error) {
    cleanupErrors.push(error)
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], 'Mac package verification and cleanup failed')
  }
  if (primaryError) throw primaryError
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Mac package cleanup failed')
  return result
}

const AUTHENTICODE_SCRIPT = `& {
  $FilePath = $env:BABYDIARY_AUTHENTICODE_PATH
  if ([string]::IsNullOrWhiteSpace($FilePath)) { throw 'BABYDIARY_AUTHENTICODE_PATH is required' }
  $signature = Get-AuthenticodeSignature -LiteralPath $FilePath
  $publisher = if ($null -ne $signature.SignerCertificate) {
    $signature.SignerCertificate.Subject
  } else { $null }
  $certificateSha256 = if ($null -ne $signature.SignerCertificate) {
    $signature.SignerCertificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)
  } else { $null }
  [pscustomobject]@{
    status = $signature.Status.ToString()
    publisher = $publisher
    certificateSha256 = $certificateSha256
    timestamped = ($null -ne $signature.TimeStamperCertificate)
  } | ConvertTo-Json -Compress
}`

export async function inspectWindowsExecutableWithRunner(descriptor, runtime) {
  const powershell = process.platform === 'win32' ? 'powershell.exe' : 'powershell'
  const result = await runtime.run(powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    AUTHENTICODE_SCRIPT,
  ], {
    env: { BABYDIARY_AUTHENTICODE_PATH: descriptor.path },
  })
  let signature
  try {
    signature = JSON.parse(String(result.stdout).trim())
  } catch {
    throw new Error(`Authenticode inspection returned invalid JSON for ${descriptor.path}`)
  }
  const bytes = await runtime.readFile(descriptor.path)
  return {
    status: signature.status,
    publisher: signature.publisher,
    certificateSha256: signature.certificateSha256,
    timestamped: signature.timestamped === true,
    machine: readPeMachine(bytes),
  }
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) {
        resolvePromise({ stdout, stderr })
      } else {
        reject(new Error(`${command} exited with code ${code}: ${(stderr || stdout).trim()}`))
      }
    })
  })
}

async function findSingleBabyDiaryApp(root) {
  const matches = []
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() && entry.name === 'Baby Diary.app') {
        matches.push(path)
      } else if (entry.isDirectory()) {
        await visit(path)
      }
    }
  }
  await visit(root)
  if (matches.length !== 1) {
    throw new Error(`expected exactly one Baby Diary.app, found ${matches.length}`)
  }
  return matches[0]
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function createDefaultDependencies(platform) {
  if (platform === 'mac') {
    if (process.platform !== 'darwin') throw new Error('Mac release verification must run on macOS')
    const runtime = {
      run: runCommand,
      makeTempDir: () => mkdtemp(join(tmpdir(), 'baby-diary-release-')),
      findApp: findSingleBabyDiaryApp,
      remove: path => rm(path, { recursive: true, force: true }),
    }
    return {
      exists: pathExists,
      inspectPackage: descriptor => inspectMacPackageWithRunner(descriptor, runtime),
    }
  }

  if (process.platform !== 'win32') throw new Error('Windows release verification must run on Windows')
  const runtime = { run: runCommand, readFile }
  return {
    exists: pathExists,
    inspectExecutable: descriptor => inspectWindowsExecutableWithRunner(descriptor, runtime),
    readBytes: readFile,
    readYaml: async path => yaml.load(await readFile(path, 'utf8')),
  }
}

function parseCliArguments(argv) {
  const result = { credentialsOnly: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--credentials-only') {
      result.credentialsOnly = true
    } else if (['--platform', '--release-dir', '--version'].includes(argument)) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`)
      result[argument.slice(2).replace('-', '')] = value
      index += 1
    } else {
      throw new Error(`unknown platform release verification argument: ${argument}`)
    }
  }
  if (!['mac', 'windows'].includes(result.platform)) {
    throw new Error('--platform must be mac or windows')
  }
  if (!result.credentialsOnly && (!present(result.releasedir) || !present(result.version))) {
    throw new Error('--release-dir and --version are required for artifact verification')
  }
  return result
}

export async function runPlatformReleaseCli(argv, env, runtime = {}) {
  const options = parseCliArguments(argv)
  const credentialErrors = requiredCredentialErrors(options.platform, env)
  if (credentialErrors.length > 0) throw new Error(credentialErrors.join('\n'))
  if (options.credentialsOnly) return { platform: options.platform, credentialsOnly: true }

  const dependencies = runtime.createDependencies
    ? runtime.createDependencies(options.platform)
    : createDefaultDependencies(options.platform)
  if (options.platform === 'mac') {
    return await verifyMacRelease({
      version: options.version,
      releaseDir: options.releasedir,
      expectedIdentity: env.MAC_CSC_NAME.trim(),
      expectedTeamId: env.MAC_EXPECTED_TEAM_ID.trim(),
    }, dependencies)
  }
  return await verifyWindowsRelease({
    version: options.version,
    releaseDir: options.releasedir,
    expectedPublisher: env.WIN_EXPECTED_PUBLISHER,
    expectedCertificateSha256: env.WIN_EXPECTED_CERT_SHA256,
  }, dependencies)
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  runPlatformReleaseCli(process.argv.slice(2), process.env)
    .then(result => {
      console.log(`platform release verification passed: ${JSON.stringify(result)}`)
    })
    .catch(error => {
      console.error(`platform release verification failed: ${error.message}`)
      process.exitCode = 1
    })
}
