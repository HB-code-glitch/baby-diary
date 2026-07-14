import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import { platformReleaseAssetNames } from '../scripts/release-provenance.mjs'

const roots: string[] = []
const VERSION = '0.3.9'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(platform: 'mac' | 'windows') {
  const root = mkdtempSync(join(tmpdir(), 'baby-diary-release-manifest-'))
  roots.push(root)
  const source = join(root, 'source')
  const staging = join(root, 'staging')
  const manifest = join(root, 'internal', `${platform}.json`)
  mkdirSync(source)
  const publicNames = platformReleaseAssetNames(platform, VERSION)
    .filter(name => name !== 'INSTALL-ME-BabyDiary-Mac.dmg')
  const sourceNames = publicNames.map(name => {
    if (name === 'latest.yml' || name === 'latest-mac.yml') return name
    if (platform === 'windows') return name.replaceAll('-', ' ')
      .replace(` ${VERSION}.exe`, ` ${VERSION}.exe`)
      .replace(` ${VERSION}.exe.blockmap`, ` ${VERSION}.exe.blockmap`)
    return name
      .replace(/^Baby-Diary-/, 'Baby Diary-')
      .replace(/^Baby\.Diary-/, 'Baby Diary-')
  })
  for (const [index, name] of sourceNames.entries()) {
    writeFileSync(join(source, name), `packaged:${publicNames[index]}`)
  }
  return { root, source, staging, manifest, sourceNames }
}

function run(platform: 'mac' | 'windows', paths: ReturnType<typeof fixture>) {
  return spawnSync(process.execPath, [
    'scripts/create-release-manifest.mjs',
    '--platform', platform,
    '--source-dir', paths.source,
    '--staging-dir', paths.staging,
    '--manifest', paths.manifest,
    '--source-repository', 'HB-code-glitch/baby-diary',
    '--release-repository', 'HB-code-glitch/baby-diary-releases',
    '--tag', `v${VERSION}`,
    '--sha', 'a'.repeat(40),
    '--version', VERSION,
    '--run-id', '24681012',
    '--run-attempt', '2',
  ], { cwd: process.cwd(), encoding: 'utf8' })
}

describe('platform release manifest CLI', () => {
  it.each(['mac', 'windows'] as const)('stages and hashes the exact %s upload bytes', platform => {
    const paths = fixture(platform)
    const result = run(platform, paths)

    expect(result.status, result.stderr).toBe(0)
    const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8')) as {
      platform: string
      source: Record<string, string>
      assets: Array<{ name: string; size: number; sha256: string }>
    }
    expect(manifest.platform).toBe(platform)
    expect(manifest.source.workflowRunId).toBe('24681012')
    expect(manifest.assets.map(asset => asset.name)).toEqual(platformReleaseAssetNames(platform, VERSION))
    for (const asset of manifest.assets) {
      expect(readFileSync(join(paths.staging, asset.name)).byteLength).toBe(asset.size)
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
    if (platform === 'mac') {
      expect(readFileSync(join(paths.staging, 'INSTALL-ME-BabyDiary-Mac.dmg'))).toEqual(
        readFileSync(join(paths.staging, `Baby-Diary-${VERSION}-universal.dmg`)),
      )
    }
  })

  it('fails closed before writing a manifest when a packaged asset is missing', () => {
    const paths = fixture('windows')
    rmSync(join(paths.source, paths.sourceNames[0]))

    const result = run('windows', paths)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('missing packaged asset')
  })
})
