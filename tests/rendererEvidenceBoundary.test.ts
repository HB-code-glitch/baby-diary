import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { HEALTH_EVIDENCE_URLS } from '../electron/healthEvidenceUrlRegistry'

describe('renderer evidence boundary', () => {
  it('checks every registry URL and fails when any renderer text asset leaks one', () => {
    const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'baby-diary-evidence-boundary-'))
    const assets = resolve(fixtureRoot, 'assets')
    const registry = resolve(fixtureRoot, 'registry.cjs')
    mkdirSync(assets)
    writeFileSync(registry, "exports.HEALTH_EVIDENCE_URLS = { one: 'https://official.example/one', two: 'https://official.example/two' }\n")
    writeFileSync(resolve(assets, 'safe.js'), "console.log('safe renderer')\n")

    try {
      const safe = spawnSync(process.execPath, [
        'scripts/verify-renderer-evidence-boundary.mjs',
        '--assets-dir', assets,
        '--registry-module', registry,
      ], { cwd: process.cwd(), encoding: 'utf8' })
      expect(safe.status, safe.stderr).toBe(0)

      writeFileSync(resolve(assets, 'nested.css'), "body{background:url('https://official.example/two')}\n")
      const leaky = spawnSync(process.execPath, [
        'scripts/verify-renderer-evidence-boundary.mjs',
        '--assets-dir', assets,
        '--registry-module', registry,
      ], { cwd: process.cwd(), encoding: 'utf8' })
      expect(leaky.status).toBe(1)
      expect(leaky.stderr).toContain('https://official.example/two')
      expect(leaky.stderr).toContain('nested.css')
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('contains no official registry URL in built renderer JavaScript when dist exists', () => {
    const assetsDir = resolve(process.cwd(), 'dist/assets')
    if (!existsSync(assetsDir)) return

    const javascript = readdirSync(assetsDir)
      .filter(file => file.endsWith('.js'))
      .map(file => readFileSync(resolve(assetsDir, file), 'utf8'))
      .join('\n')

    for (const url of Object.values(HEALTH_EVIDENCE_URLS)) {
      expect(javascript, `renderer bundle leaks ${url}`).not.toContain(url)
    }
  })
})
