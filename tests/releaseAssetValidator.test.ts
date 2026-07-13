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

function runValidator(payload: unknown, {
  preUpload = false,
  includeTag = true,
} = {}) {
  const args = [
    'scripts/validate-release-assets.mjs',
  ]
  if (includeTag) args.push('--tag', TAG)
  if (preUpload) args.push('--pre-upload')
  else args.push('--version', VERSION)

  return runValidatorWithArgs(payload, args)
}

function runValidatorWithArgs(payload: unknown, args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    input: JSON.stringify(payload),
    encoding: 'utf8',
  })
}

describe('pre-upload release guard', () => {
  it('allows an empty, valid paginated release response', () => {
    const result = runValidator([[]], { preUpload: true })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('safe to upload: no existing release')
  })

  it('allows a normal first upload when the target tag does not exist', () => {
    const unrelatedRelease = { ...releaseFixture(), tag_name: 'v0.3.8', draft: false }

    const result = runValidator([[unrelatedRelease]], { preUpload: true })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('safe to upload: no existing release')
  })

  it('allows a failed draft upload to be resumed', () => {
    const result = runValidator([[releaseFixture()]], { preUpload: true })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('safe to resume private draft')
  })

  it('rejects rerunning an already-public tag before any upload can mutate it', () => {
    const fixture = releaseFixture()
    fixture.draft = false

    const result = runValidator([[fixture]], { preUpload: true })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('must be a draft before upload')
  })

  it('rejects a prerelease target before any upload can mutate it', () => {
    const fixture = releaseFixture()
    fixture.prerelease = true

    const result = runValidator([[fixture]], { preUpload: true })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('must not be a prerelease')
    expect(result.stderr).not.toContain('missing assets')
  })

  it('rejects duplicate matching releases across paginated API results', () => {
    const result = runValidator([[releaseFixture()], [releaseFixture()]], { preUpload: true })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`expected at most one release for ${TAG}, found 2`)
  })

  it.each([
    { label: 'an API error object', payload: { message: 'Bad credentials' } },
    { label: 'a non-paginated release array', payload: [releaseFixture()] },
    { label: 'an empty outer page list', payload: [] },
    { label: 'a malformed release object', payload: [[{ draft: true, prerelease: false }]] },
  ])('fails closed for $label', ({ payload }) => {
    const result = runValidator(payload, { preUpload: true })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('invalid paginated release response')
    expect(result.stdout).not.toContain('safe to upload')
  })

  it('fails closed when the target tag argument is missing', () => {
    const result = runValidator([[]], { preUpload: true, includeTag: false })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('target tag is required')
    expect(result.stdout).not.toContain('safe to upload')
  })

  it.each([
    { label: 'has no following token', args: ['scripts/validate-release-assets.mjs', '--pre-upload', '--tag'] },
    { label: 'has an empty value', args: ['scripts/validate-release-assets.mjs', '--tag', '', '--pre-upload'] },
    { label: 'is followed by another option', args: ['scripts/validate-release-assets.mjs', '--tag', '--pre-upload'] },
  ])('fails closed when --tag $label', ({ args }) => {
    const result = runValidatorWithArgs([[]], args)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('target tag is required')
    expect(result.stdout).not.toContain('safe to upload')
  })
})

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
