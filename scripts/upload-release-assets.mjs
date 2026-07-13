import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createGitHubReleaseApi,
  orchestratePlatformUpload,
} from './release-orchestration.mjs'
import { platformReleaseAssetNames } from './release-provenance.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

async function main() {
  const platform = option('--platform')
  if (platform !== 'mac' && platform !== 'windows') throw new Error(`unsupported platform: ${platform}`)
  const manifestPath = option('--manifest')
  const stagingDir = option('--staging-dir')
  const context = {
    sourceRepository: option('--source-repository'),
    releaseRepository: option('--release-repository'),
    tag: option('--tag'),
    sha: option('--sha'),
    version: option('--version'),
    workflowRunId: option('--run-id'),
    workflowRunAttempt: option('--run-attempt'),
  }
  const entries = await readdir(stagingDir, { withFileTypes: true })
  const names = platformReleaseAssetNames(platform, context.version)
  const actualNames = entries.filter(entry => entry.isFile()).map(entry => entry.name).sort()
  if (entries.some(entry => !entry.isFile()) || JSON.stringify(actualNames) !== JSON.stringify([...names].sort())) {
    throw new Error(`staging directory must contain exactly ${names.length} ${platform} assets`)
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const assetBytes = new Map(await Promise.all(names.map(async name => [name, await readFile(join(stagingDir, name))])))
  const api = createGitHubReleaseApi({ token: process.env.GH_TOKEN, context })
  const result = await orchestratePlatformUpload({ platform, context, manifest, assetBytes, ...api })
  await writeFile(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`, 'utf8')
  console.log(`[release-upload] uploaded and rebound ${names.length} ${platform} assets to release ID ${result.releaseId}`)
}

try {
  await main()
} catch (error) {
  console.error(`[release-upload] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
