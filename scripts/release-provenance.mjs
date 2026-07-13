import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

const yaml = createRequire(import.meta.url)('js-yaml')

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1
export const SOURCE_PROVENANCE_SCHEMA_VERSION = 1

const SOURCE_MARKER_PATTERN = /<!-- baby-diary-source-provenance:([A-Za-z0-9_-]+) -->/g
const SOURCE_FIELDS = [
  'sourceRepository',
  'releaseRepository',
  'tag',
  'sha',
  'version',
  'workflowRunId',
  'workflowRunAttempt',
]
const MARKER_SOURCE_FIELDS = SOURCE_FIELDS.slice(0, 5)

export function expectedReleaseAssetNames(version) {
  return [
    `Baby-Diary-${version}-arm64-mac.zip`,
    `Baby-Diary-${version}-arm64.dmg`,
    `Baby-Diary-${version}-arm64.dmg.blockmap`,
    `Baby-Diary-${version}-universal-mac.zip`,
    `Baby-Diary-${version}-universal.dmg`,
    `Baby-Diary-${version}-universal.dmg.blockmap`,
    `Baby-Diary-${version}.exe`,
    `Baby-Diary-Setup-${version}.exe`,
    `Baby-Diary-Setup-${version}.exe.blockmap`,
    `Baby.Diary-${version}-arm64-mac.zip.blockmap`,
    `Baby.Diary-${version}-universal-mac.zip.blockmap`,
    'INSTALL-ME-BabyDiary-Mac.dmg',
    'latest-mac.yml',
    'latest.yml',
  ]
}

export function platformReleaseAssetNames(platform, version) {
  if (platform === 'windows') {
    return [
      `Baby-Diary-${version}.exe`,
      `Baby-Diary-Setup-${version}.exe`,
      `Baby-Diary-Setup-${version}.exe.blockmap`,
      'latest.yml',
    ]
  }
  if (platform === 'mac') {
    return [
      `Baby-Diary-${version}-arm64-mac.zip`,
      `Baby-Diary-${version}-arm64.dmg`,
      `Baby-Diary-${version}-arm64.dmg.blockmap`,
      `Baby-Diary-${version}-universal-mac.zip`,
      `Baby-Diary-${version}-universal.dmg`,
      `Baby-Diary-${version}-universal.dmg.blockmap`,
      `Baby.Diary-${version}-arm64-mac.zip.blockmap`,
      `Baby.Diary-${version}-universal-mac.zip.blockmap`,
      'INSTALL-ME-BabyDiary-Mac.dmg',
      'latest-mac.yml',
    ]
  }
  throw new Error(`unsupported release platform: ${String(platform)}`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha512(bytes) {
  return createHash('sha512').update(bytes).digest('base64')
}

function sourceRecord(context, fields = SOURCE_FIELDS) {
  return Object.fromEntries(fields.map(field => [field, context?.[field]]))
}

function validateContext(context, { requireRun = true } = {}) {
  const errors = []
  const fields = requireRun ? SOURCE_FIELDS : MARKER_SOURCE_FIELDS
  for (const field of fields) {
    if (typeof context?.[field] !== 'string' || context[field].trim().length === 0) {
      errors.push(`release context ${field} is required`)
    }
  }
  if (typeof context?.sha === 'string' && !/^[a-f0-9]{40}$/i.test(context.sha)) {
    errors.push('release context sha must be a 40-character Git commit SHA')
  }
  if (typeof context?.version === 'string' && context?.tag !== `v${context.version}`) {
    errors.push(`release context tag must equal v${context.version}`)
  }
  for (const field of requireRun ? ['workflowRunId', 'workflowRunAttempt'] : []) {
    if (typeof context?.[field] === 'string' && !/^[1-9][0-9]*$/.test(context[field])) {
      errors.push(`release context ${field} must be a positive integer string`)
    }
  }
  return errors
}

export function createSourceProvenanceMarker(context) {
  const provenance = {
    schemaVersion: SOURCE_PROVENANCE_SCHEMA_VERSION,
    ...sourceRecord(context, MARKER_SOURCE_FIELDS),
  }
  const encoded = Buffer.from(JSON.stringify(provenance), 'utf8').toString('base64url')
  return `<!-- baby-diary-source-provenance:${encoded} -->`
}

export function createReleaseNotes(context) {
  return [
    '## Install Baby Diary',
    '',
    'The universal Mac installer supports both Apple Silicon and Intel Macs.',
    'Download `INSTALL-ME-BabyDiary-Mac.dmg` for the recommended Mac installation.',
    '',
    createSourceProvenanceMarker(context),
    '',
  ].join('\n')
}

function parseSourceProvenance(body) {
  if (typeof body !== 'string') return { errors: ['release source provenance marker is missing'] }
  const matches = [...body.matchAll(SOURCE_MARKER_PATTERN)]
  if (matches.length !== 1) {
    return { errors: [`expected exactly one release source provenance marker, found ${matches.length}`] }
  }
  try {
    const parsed = JSON.parse(Buffer.from(matches[0][1], 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { errors: ['release source provenance marker is invalid'] }
    }
    return { errors: [], provenance: parsed }
  } catch {
    return { errors: ['release source provenance marker is invalid'] }
  }
}

function compareMarkerSource(body, context) {
  const parsed = parseSourceProvenance(body)
  if (parsed.errors.length > 0) return parsed.errors
  const expected = {
    schemaVersion: SOURCE_PROVENANCE_SCHEMA_VERSION,
    ...sourceRecord(context, MARKER_SOURCE_FIELDS),
  }
  const actual = parsed.provenance
  const expectedKeys = Object.keys(expected).sort()
  const actualKeys = Object.keys(actual).sort()
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    return ['release source provenance fields do not match the current source']
  }
  return Object.entries(expected).flatMap(([field, value]) => (
    actual[field] === value
      ? []
      : [`release source provenance ${field} does not match the current source`]
  ))
}

function validatePaginatedReleaseResponse(payload) {
  if (!Array.isArray(payload) || payload.length === 0 || payload.some(page => !Array.isArray(page))) {
    return { errors: ['invalid paginated release response'], releases: [] }
  }
  const releases = payload.flat()
  const malformed = releases.some(release => (
    !release
    || typeof release !== 'object'
    || Array.isArray(release)
    || typeof release.tag_name !== 'string'
    || release.tag_name.length === 0
    || typeof release.draft !== 'boolean'
    || typeof release.prerelease !== 'boolean'
  ))
  return malformed
    ? { errors: ['invalid paginated release response'], releases: [] }
    : { errors: [], releases }
}

function assetNameErrors(assets, expectedNames, { allowMissing = false } = {}) {
  const errors = []
  if (!Array.isArray(assets)) return ['release assets must be an array']
  const names = assets.map(asset => typeof asset?.name === 'string' ? asset.name : '')
  const counts = new Map()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([name]) => name).sort()
  if (duplicates.length > 0) errors.push(`duplicate asset names: ${duplicates.join(', ')}`)
  const expectedSet = new Set(expectedNames)
  const actualSet = new Set(names)
  const unexpected = [...actualSet].filter(name => !expectedSet.has(name)).sort()
  if (unexpected.length > 0) errors.push(`unexpected assets: ${unexpected.join(', ')}`)
  if (!allowMissing) {
    const missing = expectedNames.filter(name => !actualSet.has(name))
    if (missing.length > 0) errors.push(`missing assets: ${missing.join(', ')}`)
    if (assets.length !== expectedNames.length) {
      errors.push(`expected exactly ${expectedNames.length} assets, found ${assets.length}`)
    }
  }
  return errors
}

function remoteAssetShapeErrors(assets) {
  const errors = []
  const validDigest = /^sha256:[a-f0-9]{64}$/i
  for (const asset of Array.isArray(assets) ? assets : []) {
    const name = asset?.name ?? '<unnamed asset>'
    if (asset?.state !== 'uploaded') errors.push(`invalid state for ${name}: ${asset?.state ?? '<missing>'}`)
    if (!Number.isInteger(asset?.size) || asset.size <= 0) {
      errors.push(`invalid size for ${name}: ${asset?.size ?? '<missing>'}`)
    }
    if (!validDigest.test(asset?.digest ?? '')) errors.push(`invalid digest for ${name}`)
  }
  return errors
}

export function validateReleasePreUpload(payload, context) {
  const provenanceMarker = createSourceProvenanceMarker(context)
  const errors = validateContext(context)
  const response = validatePaginatedReleaseResponse(payload)
  errors.push(...response.errors)
  if (errors.length > 0) return { errors, action: 'invalid', releaseCount: 0, provenanceMarker }

  const matching = response.releases.filter(release => release.tag_name === context.tag)
  if (matching.length > 1) {
    errors.push(`expected at most one release for ${context.tag}, found ${matching.length}`)
  }
  if (matching.length === 0) {
    return { errors, action: 'create', releaseCount: 0, provenanceMarker }
  }
  if (matching.length !== 1) return { errors, action: 'invalid', releaseCount: matching.length, provenanceMarker }

  const release = matching[0]
  if (release.draft !== true) errors.push(`release ${context.tag} must be a draft before upload`)
  if (release.prerelease !== false) errors.push(`release ${context.tag} must not be a prerelease`)
  errors.push(...compareMarkerSource(release.body, context))
  const assets = Array.isArray(release.assets) ? release.assets : []
  errors.push(...assetNameErrors(assets, expectedReleaseAssetNames(context.version), { allowMissing: true }))
  errors.push(...remoteAssetShapeErrors(assets))
  return {
    errors,
    action: errors.length === 0 ? 'resume' : 'invalid',
    releaseCount: 1,
    provenanceMarker,
  }
}

export function buildRunManifest({ platform, context, assets }) {
  const contextErrors = validateContext(context)
  if (contextErrors.length > 0) throw new Error(contextErrors.join('\n'))
  const expectedNames = platformReleaseAssetNames(platform, context.version)
  const shapeErrors = assetNameErrors(assets, expectedNames)
  if (shapeErrors.length > 0) throw new Error(shapeErrors.join('\n'))
  const byName = new Map(assets.map(asset => [asset.name, asset]))
  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    platform,
    source: sourceRecord(context),
    assets: expectedNames.map(name => {
      const bytes = byName.get(name)?.bytes
      if (!(bytes instanceof Uint8Array) || bytes.byteLength <= 0) {
        throw new Error(`asset ${name} must contain non-empty bytes`)
      }
      return { name, size: bytes.byteLength, sha256: sha256(bytes) }
    }),
  }
}

function manifestErrors(manifests, context) {
  const errors = []
  if (!Array.isArray(manifests) || manifests.length !== 2) {
    return { errors: [`expected exactly two platform manifests, found ${Array.isArray(manifests) ? manifests.length : 0}`], assets: [] }
  }
  const platforms = manifests.map(manifest => manifest?.platform)
  if (new Set(platforms).size !== platforms.length) errors.push('duplicate platform manifests')
  for (const platform of ['mac', 'windows']) {
    if (!platforms.includes(platform)) errors.push(`missing ${platform} platform manifest`)
  }

  const manifestAssets = []
  for (const manifest of manifests) {
    const platform = manifest?.platform
    if (manifest?.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
      errors.push(`invalid ${String(platform)} manifest schemaVersion`)
    }
    if (!['mac', 'windows'].includes(platform)) {
      errors.push(`invalid manifest platform: ${String(platform)}`)
      continue
    }
    const sourceKeys = Object.keys(manifest?.source ?? {}).sort()
    if (JSON.stringify(sourceKeys) !== JSON.stringify([...SOURCE_FIELDS].sort())) {
      errors.push(`${platform} manifest source fields are invalid`)
    }
    for (const field of SOURCE_FIELDS) {
      if (manifest?.source?.[field] !== context[field]) {
        errors.push(`${platform} manifest ${field} does not match the current run`)
      }
    }
    const expectedNames = platformReleaseAssetNames(platform, context.version)
    errors.push(...assetNameErrors(manifest?.assets, expectedNames).map(error => `${platform} manifest ${error}`))
    for (const asset of Array.isArray(manifest?.assets) ? manifest.assets : []) {
      if (!Number.isInteger(asset?.size) || asset.size <= 0) {
        errors.push(`${platform} manifest invalid size for ${asset?.name ?? '<unnamed asset>'}`)
      }
      if (!/^[a-f0-9]{64}$/i.test(asset?.sha256 ?? '')) {
        errors.push(`${platform} manifest invalid sha256 for ${asset?.name ?? '<unnamed asset>'}`)
      }
      manifestAssets.push(asset)
    }
  }
  errors.push(...assetNameErrors(manifestAssets, expectedReleaseAssetNames(context.version)))
  return { errors, assets: manifestAssets }
}

function isSafeAssetName(value) {
  return typeof value === 'string'
    && value.length > 0
    && !/[\\/:?#%]/.test(value)
    && value !== '.'
    && value !== '..'
}

function isCanonicalSha512(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false
  try {
    const decoded = Buffer.from(value, 'base64')
    return decoded.byteLength === 64 && decoded.toString('base64') === value
  } catch {
    return false
  }
}

function updaterErrors(name, bytes, assetBytes, context) {
  const errors = []
  let document
  try {
    document = yaml.load(Buffer.from(bytes).toString('utf8'))
  } catch (error) {
    return [`${name} is invalid YAML: ${error instanceof Error ? error.message : String(error)}`]
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return [`${name} must be a YAML mapping`]
  if (document.version !== context.version) errors.push(`${name} version must equal ${context.version}`)
  if (!Array.isArray(document.files) || document.files.length === 0) {
    errors.push(`${name} must contain updater primary file entries`)
  }

  const files = Array.isArray(document.files) ? document.files : []
  const allowedReferences = new Set(name === 'latest.yml'
    ? [
        `Baby-Diary-Setup-${context.version}.exe`,
        `Baby-Diary-${context.version}.exe`,
      ]
    : [
        `Baby-Diary-${context.version}-arm64-mac.zip`,
        `Baby-Diary-${context.version}-arm64.dmg`,
        `Baby-Diary-${context.version}-universal-mac.zip`,
        `Baby-Diary-${context.version}-universal.dmg`,
      ])
  const urls = []
  for (const file of files) {
    const url = file?.url
    if (!isSafeAssetName(url)) {
      errors.push(`${name} updater URL must be a safe asset name: ${String(url)}`)
      continue
    }
    urls.push(url)
    if (!allowedReferences.has(url)) {
      errors.push(`${name} references an unexpected updater asset: ${url}`)
      continue
    }
    const referencedBytes = assetBytes.get(url)
    if (!(referencedBytes instanceof Uint8Array)) {
      errors.push(`${name} updater URL does not name an uploaded asset: ${url}`)
      continue
    }
    if (!Number.isInteger(file?.size) || file.size !== referencedBytes.byteLength) {
      errors.push(`${name} updater size does not match ${url}`)
    }
    if (!isCanonicalSha512(file?.sha512) || file.sha512 !== sha512(referencedBytes)) {
      errors.push(`${name} updater sha512 does not match ${url}`)
    }
  }
  const duplicates = [...new Set(urls.filter((url, index) => urls.indexOf(url) !== index))].sort()
  if (duplicates.length > 0) errors.push(`${name} has duplicate updater entries: ${duplicates.join(', ')}`)

  const requiredPrimaries = name === 'latest.yml'
    ? [`Baby-Diary-Setup-${context.version}.exe`]
    : [
        `Baby-Diary-${context.version}-arm64-mac.zip`,
        `Baby-Diary-${context.version}-universal-mac.zip`,
      ]
  for (const primary of requiredPrimaries) {
    if (!urls.includes(primary)) errors.push(`${name} is missing updater primary ${primary}`)
  }

  if (!isSafeAssetName(document.path)) {
    errors.push(`${name} path must be a safe asset name`)
  } else {
    const pathMatches = files.filter(file => file?.url === document.path)
    if (pathMatches.length !== 1) errors.push(`${name} path must reference exactly one updater file entry`)
    if (!requiredPrimaries.includes(document.path)) errors.push(`${name} path must name an updater primary`)
    const pathBytes = assetBytes.get(document.path)
    if (!(pathBytes instanceof Uint8Array)) {
      errors.push(`${name} path does not name an uploaded asset`)
    } else if (!isCanonicalSha512(document.sha512) || document.sha512 !== sha512(pathBytes)) {
      errors.push(`${name} top-level sha512 does not match path ${document.path}`)
    }
  }
  return errors
}

export function validateReleaseBundle({ context, releasePayload, manifests, assetBytes }) {
  const errors = validateContext(context)
  const response = validatePaginatedReleaseResponse(releasePayload)
  errors.push(...response.errors)
  if (response.errors.length > 0) return { errors, assetCount: 0 }
  const matching = response.releases.filter(release => release.tag_name === context.tag)
  if (matching.length !== 1) {
    errors.push(`expected exactly one release for ${context.tag}, found ${matching.length}`)
    return { errors, assetCount: 0 }
  }

  const release = matching[0]
  if (release.draft !== true) errors.push(`release ${context.tag} must still be a draft`)
  if (release.prerelease !== false) errors.push(`release ${context.tag} must not be a prerelease`)
  errors.push(...compareMarkerSource(release.body, context))

  const expectedNames = expectedReleaseAssetNames(context.version)
  const remoteAssets = Array.isArray(release.assets) ? release.assets : []
  errors.push(...assetNameErrors(remoteAssets, expectedNames))
  errors.push(...remoteAssetShapeErrors(remoteAssets))

  const manifestResult = manifestErrors(manifests, context)
  errors.push(...manifestResult.errors)
  const manifestsByName = new Map(manifestResult.assets.map(asset => [asset?.name, asset]))
  const remoteByName = new Map(remoteAssets.map(asset => [asset?.name, asset]))

  if (!(assetBytes instanceof Map)) {
    errors.push('downloaded assets must be provided as a Map')
    return { errors, assetCount: remoteAssets.length }
  }
  const downloadedNames = [...assetBytes.keys()]
  const downloadedAssets = downloadedNames.map(name => ({ name }))
  errors.push(...assetNameErrors(downloadedAssets, expectedNames))

  for (const name of expectedNames) {
    const manifest = manifestsByName.get(name)
    const remote = remoteByName.get(name)
    const bytes = assetBytes.get(name)
    if (!manifest || !remote || !(bytes instanceof Uint8Array)) continue
    if (remote.size !== manifest.size) errors.push(`remote size mismatch for ${name}`)
    if (remote.digest !== `sha256:${manifest.sha256}`) errors.push(`remote digest mismatch for ${name}`)
    if (bytes.byteLength !== manifest.size) errors.push(`downloaded size mismatch for ${name}`)
    if (sha256(bytes) !== manifest.sha256) errors.push(`downloaded digest mismatch for ${name}`)
  }

  const universalName = `Baby-Diary-${context.version}-universal.dmg`
  const aliasName = 'INSTALL-ME-BabyDiary-Mac.dmg'
  const remoteUniversal = remoteByName.get(universalName)
  const remoteAlias = remoteByName.get(aliasName)
  if (remoteUniversal && remoteAlias && remoteUniversal.digest !== remoteAlias.digest) {
    errors.push('alias digest must equal the universal DMG digest')
  }
  const universal = assetBytes.get(universalName)
  const alias = assetBytes.get(aliasName)
  if (universal instanceof Uint8Array && alias instanceof Uint8Array) {
    if (universal.byteLength !== alias.byteLength || sha256(universal) !== sha256(alias)) {
      errors.push('install alias bytes must equal the universal DMG bytes')
    }
  }

  for (const updaterName of ['latest.yml', 'latest-mac.yml']) {
    const updaterBytes = assetBytes.get(updaterName)
    if (updaterBytes instanceof Uint8Array) {
      errors.push(...updaterErrors(updaterName, updaterBytes, assetBytes, context))
    }
  }
  return { errors, assetCount: remoteAssets.length }
}
