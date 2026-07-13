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

export function validateReleaseAssets(payload, { tag, version }) {
  const errors = []
  const matchingReleases = flattenReleasePages(payload)
    .filter(candidate => candidate && typeof candidate === 'object' && candidate.tag_name === tag)

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
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function readStandardInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const tag = readOption('--tag')
const version = readOption('--version')
const inputPath = readOption('--input')
const source = inputPath ? await readFile(inputPath, 'utf8') : await readStandardInput()

let payload
try {
  payload = JSON.parse(source)
} catch (error) {
  console.error(`[release-assets] invalid GitHub API JSON: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}

if (payload !== undefined) {
  const { errors, assetCount } = validateReleaseAssets(payload, { tag, version })
  if (errors.length > 0) {
    for (const error of errors) console.error(`[release-assets] ${error}`)
    process.exitCode = 1
  } else {
    console.log(`[release-assets] ${tag} (${version}) verified ${assetCount} assets`)
  }
}
