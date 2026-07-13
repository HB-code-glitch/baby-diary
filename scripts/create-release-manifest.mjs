import { readFile, readdir, mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  buildRunManifest,
  platformReleaseAssetNames,
} from './release-provenance.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
    throw new Error(`${name} is required`)
  }
  return value
}

async function directoryMustBeEmpty(path) {
  try {
    const entries = await readdir(path)
    if (entries.length > 0) throw new Error(`staging directory must be empty: ${path}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function readPackagedAssets(platform, version, sourceDir) {
  const expected = platformReleaseAssetNames(platform, version)
  const packagedNames = expected.filter(name => name !== 'INSTALL-ME-BabyDiary-Mac.dmg')
  const sourceEntries = (await readdir(sourceDir, { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
  const assets = []
  for (const name of packagedNames) {
    const matches = sourceEntries.filter(sourceName => {
      const publicVariants = new Set([
        sourceName,
        sourceName.replaceAll(' ', '-'),
      ])
      if (sourceName.endsWith('.zip.blockmap')) {
        publicVariants.add(sourceName.replace(/^Baby Diary(?:-| )/, 'Baby.Diary-'))
      }
      return publicVariants.has(name)
    })
    if (matches.length === 0) throw new Error(`missing packaged asset ${name}`)
    if (matches.length > 1) throw new Error(`ambiguous packaged asset ${name}: ${matches.join(', ')}`)
    const path = join(sourceDir, matches[0])
    try {
      const metadata = await stat(path)
      if (!metadata.isFile() || metadata.size <= 0) throw new Error('not a non-empty regular file')
      assets.push({ name, bytes: await readFile(path) })
    } catch (error) {
      throw new Error(`missing packaged asset ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (platform === 'mac') {
    const universalName = `Baby-Diary-${version}-universal.dmg`
    const universal = assets.find(asset => asset.name === universalName)
    if (!universal) throw new Error(`missing packaged asset ${universalName}`)
    assets.push({ name: 'INSTALL-ME-BabyDiary-Mac.dmg', bytes: Buffer.from(universal.bytes) })
  }
  return assets
}

async function main() {
  const platform = option('--platform')
  if (platform !== 'mac' && platform !== 'windows') throw new Error(`unsupported platform: ${platform}`)
  const sourceDir = option('--source-dir')
  const stagingDir = option('--staging-dir')
  const manifestPath = option('--manifest')
  const context = {
    sourceRepository: option('--source-repository'),
    releaseRepository: option('--release-repository'),
    tag: option('--tag'),
    sha: option('--sha'),
    version: option('--version'),
    workflowRunId: option('--run-id'),
    workflowRunAttempt: option('--run-attempt'),
  }

  const assets = await readPackagedAssets(platform, context.version, sourceDir)
  const manifest = buildRunManifest({ platform, context, assets })
  await directoryMustBeEmpty(stagingDir)
  await mkdir(stagingDir, { recursive: true })
  for (const asset of assets) await writeFile(join(stagingDir, asset.name), asset.bytes)
  await mkdir(dirname(manifestPath), { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`[release-manifest] staged ${manifest.assets.length} ${platform} assets for run ${context.workflowRunId}/${context.workflowRunAttempt}`)
}

try {
  await main()
} catch (error) {
  console.error(`[release-manifest] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
