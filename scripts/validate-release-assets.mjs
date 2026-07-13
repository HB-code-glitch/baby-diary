import { readFile } from 'node:fs/promises'

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

function flattenReleasePages(value) {
  return Array.isArray(value) ? value.flatMap(flattenReleasePages) : [value]
}

function matchingReleasesForTag(payload, tag) {
  return flattenReleasePages(payload)
    .filter(candidate => candidate && typeof candidate === 'object' && candidate.tag_name === tag)
}

function validatePaginatedReleaseResponse(payload) {
  if (!Array.isArray(payload) || payload.length === 0 || payload.some(page => !Array.isArray(page))) {
    return { errors: ['invalid paginated release response'], releases: [] }
  }

  const releases = payload.flat()
  const hasMalformedRelease = releases.some(release => (
    !release
    || typeof release !== 'object'
    || Array.isArray(release)
    || typeof release.tag_name !== 'string'
    || release.tag_name.length === 0
    || typeof release.draft !== 'boolean'
    || typeof release.prerelease !== 'boolean'
  ))
  if (hasMalformedRelease) {
    return { errors: ['invalid paginated release response'], releases: [] }
  }

  return { errors: [], releases }
}

export function validateReleasePreUpload(payload, { tag }) {
  if (typeof tag !== 'string' || tag.trim().length === 0) {
    return { errors: ['target tag is required'], releaseCount: 0 }
  }

  const response = validatePaginatedReleaseResponse(payload)
  if (response.errors.length > 0) {
    return { errors: response.errors, releaseCount: 0 }
  }

  const matchingReleases = response.releases.filter(release => release.tag_name === tag)
  if (matchingReleases.length > 1) {
    return {
      errors: [`expected at most one release for ${tag}, found ${matchingReleases.length}`],
      releaseCount: matchingReleases.length,
    }
  }
  if (matchingReleases.length === 0) return { errors: [], releaseCount: 0 }

  const release = matchingReleases[0]
  const errors = []
  if (release.draft !== true) errors.push(`release ${tag} must be a draft before upload`)
  if (release.prerelease !== false) errors.push(`release ${tag} must not be a prerelease`)
  return { errors, releaseCount: 1 }
}

export function validateReleaseAssets(payload, { tag, version }) {
  const errors = []
  const matchingReleases = matchingReleasesForTag(payload, tag)

  if (matchingReleases.length !== 1) {
    return {
      errors: [`expected exactly one release for ${tag}, found ${matchingReleases.length}`],
      assetCount: 0,
    }
  }

  const release = matchingReleases[0]
  if (release.draft !== true) errors.push(`release ${tag} must still be a draft`)
  if (release.prerelease !== false) errors.push(`release ${tag} must not be a prerelease`)

  const assets = Array.isArray(release.assets) ? release.assets : []
  const names = assets.map(asset => typeof asset?.name === 'string' ? asset.name : '')
  const nameCounts = new Map()
  for (const name of names) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)

  const duplicateNames = [...nameCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort()
  if (duplicateNames.length > 0) errors.push(`duplicate asset names: ${duplicateNames.join(', ')}`)

  const expectedNames = expectedReleaseAssetNames(version)
  const expectedSet = new Set(expectedNames)
  const actualSet = new Set(names)
  const missingNames = expectedNames.filter(name => !actualSet.has(name))
  const unexpectedNames = [...actualSet].filter(name => !expectedSet.has(name)).sort()
  if (missingNames.length > 0) errors.push(`missing assets: ${missingNames.join(', ')}`)
  if (unexpectedNames.length > 0) errors.push(`unexpected assets: ${unexpectedNames.join(', ')}`)
  if (assets.length !== expectedNames.length) {
    errors.push(`expected exactly ${expectedNames.length} assets, found ${assets.length}`)
  }

  const validDigest = /^sha256:[a-f0-9]{64}$/i
  for (const asset of assets) {
    if (asset?.state !== 'uploaded') {
      errors.push(`invalid state for ${asset?.name ?? '<unnamed asset>'}: ${asset?.state ?? '<missing>'}`)
    }
    if (!Number.isInteger(asset?.size) || asset.size <= 0) {
      errors.push(`invalid size for ${asset?.name ?? '<unnamed asset>'}: ${asset?.size ?? '<missing>'}`)
    }
    if (!validDigest.test(asset?.digest ?? '')) {
      errors.push(`invalid digest for ${asset?.name ?? '<unnamed asset>'}`)
    }
  }

  const universalDmg = assets.find(asset => asset?.name === `Baby-Diary-${version}-universal.dmg`)
  const installAlias = assets.find(asset => asset?.name === 'INSTALL-ME-BabyDiary-Mac.dmg')
  if (universalDmg && installAlias && universalDmg.digest !== installAlias.digest) {
    errors.push('alias digest must equal the universal DMG digest')
  }

  return { errors, assetCount: assets.length }
}

function readOption(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined

  const value = process.argv[index + 1]
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) return undefined
  return value
}

async function readStandardInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const tag = readOption('--tag')
const version = readOption('--version')
const inputPath = readOption('--input')
const preUpload = process.argv.includes('--pre-upload')
const source = inputPath ? await readFile(inputPath, 'utf8') : await readStandardInput()

let payload
try {
  payload = JSON.parse(source)
} catch (error) {
  console.error(`[release-assets] invalid GitHub API JSON: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

if (payload !== undefined) {
  const result = preUpload
    ? validateReleasePreUpload(payload, { tag })
    : validateReleaseAssets(payload, { tag, version })
  const { errors } = result
  if (errors.length > 0) {
    for (const error of errors) console.error(`[release-assets] ${error}`)
    process.exitCode = 1
  } else if (preUpload) {
    const message = result.releaseCount === 0
      ? 'safe to upload: no existing release'
      : 'safe to resume private draft'
    console.log(`[release-assets] ${tag} ${message}`)
  } else {
    console.log(`[release-assets] ${tag} (${version}) verified ${result.assetCount} assets`)
  }
}
