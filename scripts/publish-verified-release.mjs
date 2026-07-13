import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createGitHubReleaseApi,
  orchestrateFinalPublication,
  RESIDUAL_PUBLICATION_RACE,
} from './release-orchestration.mjs'

function option(name) {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error(`${name} is required`)
  return value
}

async function readManifests(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.length !== 2 || entries.some(entry => !entry.isFile() || !entry.name.endsWith('.json'))) {
    throw new Error('manifest directory must contain exactly two JSON files')
  }
  return Promise.all(entries.map(async entry => JSON.parse(await readFile(join(directory, entry.name), 'utf8'))))
}

async function main() {
  const context = {
    sourceRepository: option('--source-repository'),
    releaseRepository: option('--release-repository'),
    tag: option('--tag'),
    sha: option('--sha'),
    version: option('--version'),
    workflowRunId: option('--run-id'),
    workflowRunAttempt: option('--run-attempt'),
  }
  const manifests = await readManifests(option('--manifests-dir'))
  const api = createGitHubReleaseApi({ token: process.env.GH_TOKEN, context })
  const result = await orchestrateFinalPublication({ context, manifests, ...api })
  console.log(`[release-publish] published verified release ID ${result.releaseId} with ${result.assetSnapshot.length} assets`)
  console.log(`[release-publish] residual boundary: ${RESIDUAL_PUBLICATION_RACE}`)
}

try {
  await main()
} catch (error) {
  console.error(`[release-publish] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
