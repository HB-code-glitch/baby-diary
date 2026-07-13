import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const VERSION = '0.3.9'
const TAG = `v${VERSION}`

const EXPECTED_ASSET_NAMES = [
  `Baby-Diary-${VERSION}-arm64-mac.zip`,
  `Baby-Diary-${VERSION}-arm64.dmg`,
  `Baby-Diary-${VERSION}-arm64.dmg.blockmap`,
  `Baby-Diary-${VERSION}-universal-mac.zip`,
  `Baby-Diary-${VERSION}-universal.dmg`,
  `Baby-Diary-${VERSION}-universal.dmg.blockmap`,
  `Baby-Diary-${VERSION}.exe`,
  `Baby-Diary-Setup-${VERSION}.exe`,
  `Baby-Diary-Setup-${VERSION}.exe.blockmap`,
  `Baby.Diary-${VERSION}-arm64-mac.zip.blockmap`,
  `Baby.Diary-${VERSION}-universal-mac.zip.blockmap`,
  'INSTALL-ME-BabyDiary-Mac.dmg',
  'latest-mac.yml',
  'latest.yml',
] as const

interface ReleaseFixture {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: Array<{
    name: string
    state: string
    size: number
    digest: string
  }>
}

function releaseFixture(): ReleaseFixture {
  const universalDigest = `sha256:${String(5).padStart(64, '0')}`
  return {
    tag_name: TAG,
    draft: true,
    prerelease: false,
    assets: EXPECTED_ASSET_NAMES.map((name, index) => ({
      name,
      state: 'uploaded',
      size: 100 + index,
      digest: name === 'INSTALL-ME-BabyDiary-Mac.dmg'
        ? universalDigest
        : `sha256:${String(index + 1).padStart(64, '0')}`,
    })),
  }
}

function runValidator(payload: unknown) {
  return spawnSync(process.execPath, [
    'scripts/validate-release-assets.mjs',
    '--tag', TAG,
    '--version', VERSION,
  ], {
    cwd: process.cwd(),
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
}

describe('release asset validator', () => {
  it('accepts the exact 14-asset v0.3.9 draft fixture', () => {
    const result = runValidator([[releaseFixture()]])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('verified 14 assets')
  })

  it('rejects a draft fixture with one required asset missing', () => {
    const fixture = releaseFixture()
    fixture.assets.pop()

    const result = runValidator([[fixture]])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('missing assets')
  })

  it('rejects duplicate asset names even when the total remains 14', () => {
    const fixture = releaseFixture()
    fixture.assets[fixture.assets.length - 1].name = fixture.assets[0].name

    const result = runValidator([[fixture]])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('duplicate asset names')
  })

  it('rejects an asset carrying a different release version', () => {
    const fixture = releaseFixture()
    fixture.assets[0].name = fixture.assets[0].name.replace(VERSION, '0.3.8')

    const result = runValidator([[fixture]])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unexpected assets')
    expect(result.stderr).toContain('0.3.8')
  })

  it('rejects an asset whose GitHub digest is empty', () => {
    const fixture = releaseFixture()
    fixture.assets[0].digest = ''

    const result = runValidator([[fixture]])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('invalid digest')
    expect(result.stderr).toContain(fixture.assets[0].name)
  })

  it('rejects a release that is already public', () => {
    const fixture = releaseFixture()
    fixture.draft = false

    const result = runValidator([[fixture]])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('must still be a draft')
  })

  it('rejects an alias that is not the verified universal DMG bytes', () => {
    const fixture = releaseFixture()
    const alias = fixture.assets.find(asset => asset.name === 'INSTALL-ME-BabyDiary-Mac.dmg')!
    alias.digest = `sha256:${'f'.repeat(64)}`

    const result = runValidator([[fixture]])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('alias digest')
  })

  it('rejects a GitHub asset that is still in the starter state', () => {
    const fixture = releaseFixture()
    fixture.assets[0].state = 'starter'

    const result = runValidator([[fixture]])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('invalid state')
    expect(result.stderr).toContain(fixture.assets[0].name)
  })

  it('rejects a zero-byte GitHub asset even when its digest is present', () => {
    const fixture = releaseFixture()
    fixture.assets[0].size = 0

    const result = runValidator([[fixture]])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('invalid size')
    expect(result.stderr).toContain(fixture.assets[0].name)
  })

  it('rejects a prerelease draft', () => {
    const fixture = releaseFixture()
    fixture.prerelease = true

    const result = runValidator([[fixture]])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('must not be a prerelease')
  })
})
