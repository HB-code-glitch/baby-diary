import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  createReleaseNotes,
  expectedReleaseAssetNames,
  validateReleaseBundle,
  validateReleasePreUpload,
} from './release-provenance.mjs'

export {
  expectedReleaseAssetNames,
  validateReleaseBundle,
  validateReleasePreUpload,
}

function readOption(name, message = `${name} is required`) {
  const index = process.argv.indexOf(name)
  if (index < 0) throw new Error(message)
  const value = process.argv[index + 1]
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error(message)
  return value
}

function contextFromArguments() {
  const tag = readOption('--tag', 'target tag is required')
  return {
    sourceRepository: readOption('--source-repository'),
    releaseRepository: readOption('--release-repository'),
    tag,
    sha: readOption('--sha'),
    version: readOption('--version'),
    workflowRunId: readOption('--run-id'),
    workflowRunAttempt: readOption('--run-attempt'),
  }
}

async function readStandardInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function readPayload() {
  const inputIndex = process.argv.indexOf('--input')
  const source = inputIndex >= 0
    ? await readFile(readOption('--input'), 'utf8')
    : await readStandardInput()
  try {
    return JSON.parse(source)
  } catch (error) {
    throw new Error(`invalid GitHub API JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readManifests(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const invalid = entries.filter(entry => !entry.isFile() || !entry.name.endsWith('.json'))
  if (invalid.length > 0) throw new Error(`manifest directory contains unexpected entries: ${invalid.map(entry => entry.name).join(', ')}`)
  if (entries.length !== 2) throw new Error(`expected exactly two manifest files, found ${entries.length}`)
  return Promise.all(entries.map(async entry => {
    try {
      return JSON.parse(await readFile(join(directory, entry.name), 'utf8'))
    } catch (error) {
      throw new Error(`invalid manifest ${entry.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }))
}

async function readAssetBytes(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const invalid = entries.filter(entry => !entry.isFile())
  if (invalid.length > 0) throw new Error(`asset directory contains non-files: ${invalid.map(entry => entry.name).join(', ')}`)
  return new Map(await Promise.all(entries.map(async entry => [
    entry.name,
    await readFile(join(directory, entry.name)),
  ])))
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value, 'utf8')
}

async function runPreUpload(payload, context) {
  const result = validateReleasePreUpload(payload, context)
  if (result.errors.length > 0) return result
  const planPath = readOption('--plan')
  const notesPath = readOption('--notes')
  await writeText(planPath, `${JSON.stringify({
    schemaVersion: 1,
    action: result.action,
    tag: context.tag,
  }, null, 2)}\n`)
  await writeText(notesPath, createReleaseNotes(context))
  return result
}

async function runFinal(payload, context) {
  const manifests = await readManifests(readOption('--manifests-dir'))
  const assetBytes = await readAssetBytes(readOption('--assets-dir'))
  return validateReleaseBundle({ context, releasePayload: payload, manifests, assetBytes })
}

async function main() {
  const context = contextFromArguments()
  const payload = await readPayload()
  const preUpload = process.argv.includes('--pre-upload')
  const result = preUpload
    ? await runPreUpload(payload, context)
    : await runFinal(payload, context)
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`[release-assets] ${error}`)
    process.exitCode = 1
  } else if (preUpload) {
    const message = result.action === 'create'
      ? 'safe to upload: no existing release'
      : 'safe to resume private draft'
    console.log(`[release-assets] ${context.tag} ${message}`)
  } else {
    console.log(`[release-assets] ${context.tag} (${context.version}) verified ${result.assetCount} assets from the current run`)
  }
}

try {
  await main()
} catch (error) {
  console.error(`[release-assets] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
