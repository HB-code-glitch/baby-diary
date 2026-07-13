import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

import {
  buildRunManifest,
  createSourceProvenanceMarker,
  expectedReleaseAssetNames,
  platformReleaseAssetNames,
} from '../scripts/release-provenance.mjs'

const orchestration = await import('../scripts/release-orchestration.mjs').catch(() => ({})) as Record<string, unknown>
const yaml = createRequire(import.meta.url)('js-yaml') as {
  dump(value: unknown, options?: Record<string, unknown>): string
}

const VERSION = '0.3.9'
const RELEASE_ID = 424242
const CONTEXT = Object.freeze({
  sourceRepository: 'HB-code-glitch/baby-diary',
  releaseRepository: 'HB-code-glitch/baby-diary-releases',
  tag: `v${VERSION}`,
  sha: 'a'.repeat(40),
  version: VERSION,
  workflowRunId: '24681012',
  workflowRunAttempt: '3',
})

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha512(bytes: Uint8Array) {
  return createHash('sha512').update(bytes).digest('base64')
}

function bodySha256(body: string) {
  return sha256(Buffer.from(body, 'utf8'))
}

function expectedContentType(name: string) {
  if (name.endsWith('.blockmap')) return 'application/octet-stream'
  if (name.endsWith('.yml')) return 'application/yaml'
  if (name.endsWith('.zip')) return 'application/zip'
  if (name.endsWith('.dmg')) return 'application/x-apple-diskimage'
  if (name.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable'
  throw new Error(`missing test content type for ${name}`)
}

function requiredExport<T extends (...args: any[]) => any>(name: string): T {
  expect(orchestration[name], `${name} must be exported`).toBeTypeOf('function')
  return orchestration[name] as T
}

function bundleFixture() {
  const assetBytes = new Map<string, Buffer>()
  for (const name of expectedReleaseAssetNames(VERSION)) {
    assetBytes.set(name, Buffer.from(`current-run:${name}`, 'utf8'))
  }
  const universalDmg = `Baby-Diary-${VERSION}-universal.dmg`
  assetBytes.set('INSTALL-ME-BabyDiary-Mac.dmg', Buffer.from(assetBytes.get(universalDmg)!))

  const winPrimary = `Baby-Diary-Setup-${VERSION}.exe`
  const macArmPrimary = `Baby-Diary-${VERSION}-arm64-mac.zip`
  const macUniversalPrimary = `Baby-Diary-${VERSION}-universal-mac.zip`
  const windowsUpdater = {
    version: VERSION,
    files: [{
      url: winPrimary,
      size: assetBytes.get(winPrimary)!.byteLength,
      sha512: sha512(assetBytes.get(winPrimary)!),
    }],
    path: winPrimary,
    sha512: sha512(assetBytes.get(winPrimary)!),
  }
  const macUpdater = {
    version: VERSION,
    files: [macArmPrimary, macUniversalPrimary].map(name => ({
      url: name,
      size: assetBytes.get(name)!.byteLength,
      sha512: sha512(assetBytes.get(name)!),
    })),
    path: macUniversalPrimary,
    sha512: sha512(assetBytes.get(macUniversalPrimary)!),
  }
  assetBytes.set('latest.yml', Buffer.from(yaml.dump(windowsUpdater, { noRefs: true }), 'utf8'))
  assetBytes.set('latest-mac.yml', Buffer.from(yaml.dump(macUpdater, { noRefs: true }), 'utf8'))

  const body = createSourceProvenanceMarker(CONTEXT)
  const release = {
    id: RELEASE_ID,
    url: `https://api.github.com/repos/${CONTEXT.releaseRepository}/releases/${RELEASE_ID}`,
    upload_url: `https://uploads.github.com/repos/${CONTEXT.releaseRepository}/releases/${RELEASE_ID}/assets{?name,label}`,
    tag_name: CONTEXT.tag,
    draft: true,
    prerelease: false,
    body,
    assets: expectedReleaseAssetNames(VERSION).map((name, index) => {
      const bytes = assetBytes.get(name)!
      return {
        id: 5000 + index,
        url: `https://api.github.com/repos/${CONTEXT.releaseRepository}/releases/assets/${5000 + index}`,
        name,
        state: 'uploaded',
        size: bytes.byteLength,
        digest: `sha256:${sha256(bytes)}`,
      }
    }),
  }
  const releaseBinding = {
    id: RELEASE_ID,
    apiUrl: release.url,
    uploadUrl: release.upload_url,
    tag: CONTEXT.tag,
    bodySha256: bodySha256(body),
  }
  const manifests = (['mac', 'windows'] as const).map(platform => ({
    ...buildRunManifest({
      platform,
      context: CONTEXT,
      assets: platformReleaseAssetNames(platform, VERSION).map(name => ({ name, bytes: assetBytes.get(name)! })),
    }),
    release: { ...releaseBinding },
  }))
  return { assetBytes, release, manifests }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function platformApiFixture(platform: 'mac' | 'windows') {
  const fixture = bundleFixture()
  const platformNames = new Set(platformReleaseAssetNames(platform, VERSION))
  const current = clone(fixture.release)
  current.assets = current.assets.filter(asset => !platformNames.has(asset.name))

  const resolveSourceTagSha = vi.fn(async () => CONTEXT.sha)
  const listReleases = vi.fn(async () => [[clone(current)]])
  const getReleaseById = vi.fn(async () => clone(current))
  const deleteAsset = vi.fn(async ({ assetId }: { assetId: number }) => {
    current.assets = current.assets.filter(asset => asset.id !== assetId)
  })
  const uploadAsset = vi.fn(async ({ releaseId, name, bytes }: {
    releaseId: number
    name: string
    bytes: Uint8Array
  }) => {
    expect(releaseId).toBe(RELEASE_ID)
    current.assets.push({
      id: 9000 + current.assets.length,
      url: `https://api.github.com/repos/${CONTEXT.releaseRepository}/releases/assets/${9000 + current.assets.length}`,
      name,
      state: 'uploaded',
      size: bytes.byteLength,
      digest: `sha256:${sha256(bytes)}`,
    })
  })
  const manifest = buildRunManifest({
    platform,
    context: CONTEXT,
    assets: platformReleaseAssetNames(platform, VERSION).map(name => ({
      name,
      bytes: fixture.assetBytes.get(name)!,
    })),
  })
  return {
    fixture,
    current,
    manifest,
    assetBytes: new Map(platformReleaseAssetNames(platform, VERSION).map(name => [name, fixture.assetBytes.get(name)!])),
    api: { resolveSourceTagSha, listReleases, getReleaseById, deleteAsset, uploadAsset },
  }
}

describe('immutable release-ID platform upload orchestration', () => {
  it.each(['mac', 'windows'] as const)('uploads %s bytes by validated release ID and returns a post-upload-bound manifest', async platform => {
    const state = platformApiFixture(platform)
    const orchestrate = requiredExport<any>('orchestratePlatformUpload')

    const result = await orchestrate({
      platform,
      context: CONTEXT,
      manifest: state.manifest,
      assetBytes: state.assetBytes,
      ...state.api,
    })

    expect(state.api.uploadAsset).toHaveBeenCalledTimes(platformReleaseAssetNames(platform, VERSION).length)
    expect(state.api.uploadAsset.mock.calls.every(([call]) => call.releaseId === RELEASE_ID)).toBe(true)
    expect(state.api.uploadAsset.mock.calls.every(([call]) => call.uploadUrl === state.current.upload_url)).toBe(true)
    expect(state.api.uploadAsset.mock.calls.every(([call]) => call.contentType === expectedContentType(call.name))).toBe(true)
    expect(result.manifest.release).toMatchObject({
      id: RELEASE_ID,
      apiUrl: state.current.url,
      uploadUrl: state.current.upload_url,
      tag: CONTEXT.tag,
      bodySha256: bodySha256(state.current.body),
    })
  })

  it('clobbers only the expected platform names by numeric asset and release IDs', async () => {
    const state = platformApiFixture('windows')
    state.current.assets = clone(state.fixture.release.assets)
    const windowsNames = platformReleaseAssetNames('windows', VERSION)
    const expectedAssetIds = state.current.assets
      .filter(asset => windowsNames.includes(asset.name))
      .map(asset => asset.id)
      .sort((left, right) => left - right)
    const orchestrate = requiredExport<any>('orchestratePlatformUpload')

    await orchestrate({
      platform: 'windows', context: CONTEXT, manifest: state.manifest, assetBytes: state.assetBytes, ...state.api,
    })

    expect(state.api.deleteAsset).toHaveBeenCalledTimes(windowsNames.length)
    expect(state.api.deleteAsset.mock.calls.map(([call]) => call.assetId).sort((left, right) => left - right)).toEqual(expectedAssetIds)
    expect(state.api.deleteAsset.mock.calls.every(([call]) => call.releaseId === RELEASE_ID)).toBe(true)
    expect(state.api.deleteAsset.mock.calls.map(([call]) => call.name).sort()).toEqual([...windowsNames].sort())
  })

  it.each([
    ['public state', (release: any) => { release.draft = false }],
    ['prerelease state', (release: any) => { release.prerelease = true }],
    ['source marker/body', (release: any) => { release.body = createSourceProvenanceMarker({ ...CONTEXT, sha: 'b'.repeat(40) }) }],
    ['body bytes with the same source marker', (release: any) => { release.body += '\nchanged release notes' }],
    ['release ID', (release: any) => { release.id += 1 }],
    ['unexpected asset', (release: any) => { release.assets.push({ id: 999, name: 'stale.bin', state: 'uploaded', size: 1, digest: `sha256:${'f'.repeat(64)}` }) }],
  ] as const)('blocks upload when %s mutates immediately after list validation', async (_label, mutate) => {
    for (const platform of ['mac', 'windows'] as const) {
      const state = platformApiFixture(platform)
      state.api.getReleaseById
        .mockResolvedValueOnce(clone(state.current))
        .mockImplementation(async () => {
          const changed = clone(state.current)
          mutate(changed)
          return changed
        })
      const orchestrate = requiredExport<any>('orchestratePlatformUpload')

      await expect(orchestrate({
        platform,
        context: CONTEXT,
        manifest: state.manifest,
        assetBytes: state.assetBytes,
        ...state.api,
      })).rejects.toThrow()

      expect(state.api.uploadAsset).not.toHaveBeenCalled()
    }
  })

  it('blocks both platform uploads when the source tag moves immediately before upload', async () => {
    for (const platform of ['mac', 'windows'] as const) {
      const state = platformApiFixture(platform)
      state.api.resolveSourceTagSha
        .mockResolvedValueOnce(CONTEXT.sha)
        .mockResolvedValueOnce('b'.repeat(40))
      const orchestrate = requiredExport<any>('orchestratePlatformUpload')
      await expect(orchestrate({
        platform,
        context: CONTEXT,
        manifest: state.manifest,
        assetBytes: state.assetBytes,
        ...state.api,
      })).rejects.toThrow()
      expect(state.api.uploadAsset).not.toHaveBeenCalled()
    }
  })

  it('blocks upload when duplicate matching releases exist', async () => {
    const state = platformApiFixture('windows')
    state.api.listReleases.mockResolvedValue([[clone(state.current), clone(state.current)]])
    const orchestrate = requiredExport<any>('orchestratePlatformUpload')
    await expect(orchestrate({
      platform: 'windows', context: CONTEXT, manifest: state.manifest, assetBytes: state.assetBytes, ...state.api,
    })).rejects.toThrow()
    expect(state.api.uploadAsset).not.toHaveBeenCalled()
  })

  it('fails loudly when draft state or body drifts in the post-upload manifest check', async () => {
    for (const mutation of [
      (release: any) => { release.draft = false },
      (release: any) => { release.body += '\nchanged after upload' },
    ]) {
      const state = platformApiFixture('windows')
      state.api.getReleaseById.mockImplementation(async () => {
        const release = clone(state.current)
        if (state.api.uploadAsset.mock.calls.length === platformReleaseAssetNames('windows', VERSION).length) mutation(release)
        return release
      })
      const orchestrate = requiredExport<any>('orchestratePlatformUpload')
      await expect(orchestrate({
        platform: 'windows', context: CONTEXT, manifest: state.manifest, assetBytes: state.assetBytes, ...state.api,
      })).rejects.toThrow()
    }
  })
})

function finalApiFixture() {
  const fixture = bundleFixture()
  const current = clone(fixture.release)
  const resolveSourceTagSha = vi.fn(async () => CONTEXT.sha)
  const listReleases = vi.fn(async () => [[clone(current)]])
  const downloadAsset = vi.fn(async ({ name }: { name: string }) => Buffer.from(fixture.assetBytes.get(name)!))
  const getReleaseById = vi.fn(async () => clone(current))
  const publishRelease = vi.fn(async ({ releaseId }: { releaseId: number }) => {
    expect(releaseId).toBe(RELEASE_ID)
    current.draft = false
  })
  const getLatestRelease = vi.fn(async () => clone(current))
  return {
    fixture,
    current,
    api: { resolveSourceTagSha, listReleases, downloadAsset, getReleaseById, publishRelease, getLatestRelease },
  }
}

describe('single final validation and publication orchestration', () => {
  it('publishes exactly once by immutable release ID after a matching immediate re-fetch', async () => {
    const state = finalApiFixture()
    const orchestrate = requiredExport<any>('orchestrateFinalPublication')
    const result = await orchestrate({ context: CONTEXT, manifests: state.fixture.manifests, ...state.api })

    expect(state.api.publishRelease).toHaveBeenCalledTimes(1)
    expect(state.api.publishRelease).toHaveBeenCalledWith(expect.objectContaining({
      releaseId: RELEASE_ID,
      draft: false,
      makeLatest: true,
    }))
    expect(result.releaseId).toBe(RELEASE_ID)
    expect(result.assetSnapshot).toHaveLength(14)
    expect(state.api.getLatestRelease).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['source tag SHA', null, (state: ReturnType<typeof finalApiFixture>) => {
      state.api.resolveSourceTagSha
        .mockResolvedValueOnce(CONTEXT.sha)
        .mockResolvedValueOnce('b'.repeat(40))
    }],
    ['body/source marker', (release: any) => { release.body += '\nchanged body' }, null],
    ['release ID', (release: any) => { release.id += 1 }, null],
    ['draft state', (release: any) => { release.draft = false }, null],
    ['prerelease state', (release: any) => { release.prerelease = true }, null],
    ['asset name', (release: any) => { release.assets[0].name = 'stale-name.zip' }, null],
    ['asset size', (release: any) => { release.assets[0].size += 1 }, null],
    ['asset digest', (release: any) => { release.assets[0].digest = `sha256:${'f'.repeat(64)}` }, null],
  ] as const)('does not publish when %s changes between validation and PATCH', async (_label, mutateRelease, mutateApi) => {
    const state = finalApiFixture()
    if (mutateApi) mutateApi(state)
    if (mutateRelease) {
      state.api.getReleaseById.mockImplementation(async () => {
        const changed = clone(state.current)
        mutateRelease(changed)
        return changed
      })
    }
    const orchestrate = requiredExport<any>('orchestrateFinalPublication')

    await expect(orchestrate({ context: CONTEXT, manifests: state.fixture.manifests, ...state.api })).rejects.toThrow()
    expect(state.api.publishRelease).not.toHaveBeenCalled()
  })

  it.each([
    ['release ID', (manifest: any) => { manifest.release.id += 1 }],
    ['release body digest', (manifest: any) => { manifest.release.bodySha256 = 'f'.repeat(64) }],
  ] as const)('does not publish when a platform manifest binds a different %s', async (_label, mutateManifest) => {
    const state = finalApiFixture()
    const manifests = clone(state.fixture.manifests)
    mutateManifest(manifests[0])
    const orchestrate = requiredExport<any>('orchestrateFinalPublication')

    await expect(orchestrate({ context: CONTEXT, manifests, ...state.api })).rejects.toThrow()
    expect(state.api.publishRelease).not.toHaveBeenCalled()
  })

  it('fails loudly when the same release ID readback differs after PATCH', async () => {
    const state = finalApiFixture()
    state.api.getReleaseById.mockImplementation(async () => {
      const release = clone(state.current)
      if (state.api.publishRelease.mock.calls.length > 0) release.assets[0].size += 1
      return release
    })
    const orchestrate = requiredExport<any>('orchestrateFinalPublication')

    await expect(orchestrate({ context: CONTEXT, manifests: state.fixture.manifests, ...state.api })).rejects.toThrow(/readback|snapshot/i)
    expect(state.api.publishRelease).toHaveBeenCalledTimes(1)
  })
})

describe('immutable GitHub release API adapter', () => {
  it('uploads and publishes only through numeric-ID API endpoints with authenticated requests', async () => {
    const fixture = bundleFixture()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: RELEASE_ID }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const createApi = requiredExport<any>('createGitHubReleaseApi')
    const api = createApi({ token: 'release-token', context: CONTEXT, fetchImpl })

    await api.uploadAsset({
      releaseId: RELEASE_ID,
      uploadUrl: fixture.release.upload_url,
      name: 'latest.yml',
      bytes: Buffer.from('release bytes'),
      contentType: 'application/yaml',
    })
    await api.publishRelease({ releaseId: RELEASE_ID, draft: false, makeLatest: true })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [uploadUrl, uploadOptions] = fetchImpl.mock.calls[0]
    expect(String(uploadUrl)).toBe(`https://uploads.github.com/repos/${CONTEXT.releaseRepository}/releases/${RELEASE_ID}/assets?name=latest.yml`)
    expect(uploadOptions.method).toBe('POST')
    expect(uploadOptions.headers.Authorization).toBe('Bearer release-token')
    expect(uploadOptions.headers['Content-Type']).toBe('application/yaml')
    const [publishUrl, publishOptions] = fetchImpl.mock.calls[1]
    expect(String(publishUrl)).toBe(`https://api.github.com/repos/${CONTEXT.releaseRepository}/releases/${RELEASE_ID}`)
    expect(publishOptions.method).toBe('PATCH')
    expect(JSON.parse(String(publishOptions.body))).toEqual({ draft: false, make_latest: 'true' })
  })
})
