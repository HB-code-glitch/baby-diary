import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TEXT_ASSET_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.map'])

function readOption(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]) : fallback
}

function collectTextAssets(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const itemPath = resolve(directory, entry.name)
    if (entry.isDirectory()) return collectTextAssets(itemPath)
    return entry.isFile() && TEXT_ASSET_EXTENSIONS.has(extname(entry.name)) ? [itemPath] : []
  })
}

const assetsDir = readOption('--assets-dir', resolve(ROOT, 'dist', 'assets'))
const registryModule = readOption(
  '--registry-module',
  resolve(ROOT, 'dist-electron', 'electron', 'healthEvidenceUrlRegistry.js'),
)

if (!existsSync(assetsDir)) {
  console.error(`[evidence-boundary] renderer assets directory is missing: ${assetsDir}`)
  process.exit(1)
}
if (!existsSync(registryModule)) {
  console.error(`[evidence-boundary] compiled main-only registry is missing: ${registryModule}`)
  process.exit(1)
}

const require = createRequire(import.meta.url)
const registry = require(registryModule)
const urls = Object.values(registry.HEALTH_EVIDENCE_URLS ?? {})
if (urls.length === 0 || urls.some(url => typeof url !== 'string')) {
  console.error('[evidence-boundary] main-only URL registry is empty or invalid')
  process.exit(1)
}

const leaks = []
for (const assetPath of collectTextAssets(assetsDir)) {
  const content = readFileSync(assetPath, 'utf8')
  for (const url of urls) {
    if (content.includes(url) || content.includes(encodeURI(url))) {
      leaks.push({ assetPath, url })
    }
  }
}

if (leaks.length > 0) {
  for (const leak of leaks) {
    console.error(`[evidence-boundary] ${relative(ROOT, leak.assetPath)} leaks ${leak.url}`)
  }
  process.exit(1)
}

console.log(`[evidence-boundary] ${urls.length} official URLs absent from renderer text assets`)
