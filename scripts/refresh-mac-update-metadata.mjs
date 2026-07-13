import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const require = createRequire(import.meta.url)
const { buildBlockMap: electronBuilderBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap')

function sha512(bytes) {
  return createHash('sha512').update(bytes).digest('base64')
}

function updaterEntries(document, url) {
  return Array.isArray(document.files) ? document.files.filter(file => file?.url === url) : []
}

export async function refreshMacUpdateMetadata(options, dependencies = {}) {
  const buildBlockMap = dependencies.buildBlockMap ?? electronBuilderBlockMap
  const descriptors = [
    {
      sourceName: `Baby Diary-${options.version}-arm64.dmg`,
      updaterName: `Baby-Diary-${options.version}-arm64.dmg`,
    },
    {
      sourceName: `Baby Diary-${options.version}-universal.dmg`,
      updaterName: `Baby-Diary-${options.version}-universal.dmg`,
    },
  ]
  const latestPath = join(options.releaseDir, 'latest-mac.yml')
  const latestSource = await readFile(latestPath, 'utf8')
  const latest = yaml.load(latestSource)
  if (!latest || typeof latest !== 'object' || Array.isArray(latest)) {
    throw new Error('latest-mac.yml must be a YAML mapping')
  }
  if (latest.version !== options.version) {
    throw new Error(`latest-mac.yml version must equal ${options.version}`)
  }
  if (!Array.isArray(latest.files)) {
    throw new Error('latest-mac.yml files must be an array')
  }

  for (const descriptor of descriptors) {
    const matches = updaterEntries(latest, descriptor.updaterName)
    if (matches.length !== 1) {
      throw new Error(`latest-mac.yml must contain exactly one ${descriptor.updaterName} entry`)
    }
  }

  const suffix = `.tmp-${process.pid}-${randomUUID()}`
  const stagedPaths = []
  const generated = []
  try {
    for (const descriptor of descriptors) {
      const sourcePath = join(options.releaseDir, descriptor.sourceName)
      const finalBlockmapPath = `${sourcePath}.blockmap`
      const stagedBlockmapPath = `${finalBlockmapPath}${suffix}`
      stagedPaths.push(stagedBlockmapPath)

      const before = await readFile(sourcePath)
      const blockmapInfo = await buildBlockMap(sourcePath, 'gzip', stagedBlockmapPath)
      const after = await readFile(sourcePath)
      const expected = { size: after.length, sha512: sha512(after) }
      if (!before.equals(after)
        || blockmapInfo?.size !== expected.size
        || blockmapInfo?.sha512 !== expected.sha512) {
        throw new Error(`${descriptor.sourceName} changed while regenerating its blockmap`)
      }
      const blockmapStat = await stat(stagedBlockmapPath)
      if (!blockmapStat.isFile() || blockmapStat.size <= 0) {
        throw new Error(`generated blockmap is empty for ${descriptor.sourceName}`)
      }

      const [entry] = updaterEntries(latest, descriptor.updaterName)
      entry.size = expected.size
      entry.sha512 = expected.sha512
      if (latest.path === descriptor.updaterName) latest.sha512 = expected.sha512
      generated.push({ stagedBlockmapPath, finalBlockmapPath })
    }

    const stagedLatestPath = `${latestPath}${suffix}`
    stagedPaths.push(stagedLatestPath)
    await writeFile(stagedLatestPath, yaml.dump(latest, { lineWidth: -1, noRefs: true }), 'utf8')

    for (const item of generated) await rename(item.stagedBlockmapPath, item.finalBlockmapPath)
    await rename(stagedLatestPath, latestPath)
    return { dmgCount: descriptors.length }
  } finally {
    await Promise.all(stagedPaths.map(path => rm(path, { force: true }).catch(() => {})))
  }
}

function option(argv, name) {
  const index = argv.indexOf(name)
  const value = index < 0 ? undefined : argv[index + 1]
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
    throw new Error(`${name} is required`)
  }
  return value
}

async function main(argv) {
  const result = await refreshMacUpdateMetadata({
    releaseDir: option(argv, '--release-dir'),
    version: option(argv, '--version'),
  })
  console.log(`refreshed Mac update metadata for ${result.dmgCount} final DMGs`)
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Mac update metadata refresh failed: ${error.message}`)
    process.exitCode = 1
  })
}
