import { createHash } from 'node:crypto'

import {
  buildRunManifest,
  expectedReleaseAssetNames,
  platformReleaseAssetNames,
  validateReleaseBundle,
  validateReleasePreUpload,
} from './release-provenance.mjs'

// GitHub documents that conditional unsafe requests are unsupported unless an
// endpoint explicitly opts in, and "Update a release" documents no If-Match
// support. Keep the verified GET and this one PATCH adjacent, then read back.
// https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
// https://docs.github.com/en/rest/releases/releases#update-a-release
export const RESIDUAL_PUBLICATION_RACE = 'GitHub does not document a conditional release PATCH, so one authenticated GET-to-PATCH boundary remains.'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function releaseAssetContentType(name) {
  if (name.endsWith('.blockmap')) return 'application/octet-stream'
  if (name.endsWith('.yml')) return 'application/yaml'
  if (name.endsWith('.zip')) return 'application/zip'
  if (name.endsWith('.dmg')) return 'application/x-apple-diskimage'
  if (name.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable'
  fail(`unsupported release asset content type: ${name}`)
}

function fail(message) {
  throw new Error(`[release-orchestration] ${message}`)
}

function assertNoErrors(label, errors) {
  if (errors.length > 0) fail(`${label}: ${errors.join('; ')}`)
}

function repositoryPath(repository) {
  if (typeof repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    fail(`invalid GitHub repository: ${String(repository)}`)
  }
  return repository.split('/').map(encodeURIComponent).join('/')
}

function canonicalReleaseApiUrl(context, releaseId) {
  return `https://api.github.com/repos/${repositoryPath(context.releaseRepository)}/releases/${releaseId}`
}

function canonicalReleaseUploadUrl(context, releaseId) {
  return `https://uploads.github.com/repos/${repositoryPath(context.releaseRepository)}/releases/${releaseId}/assets{?name,label}`
}

function canonicalAssetApiUrl(context, assetId) {
  return `https://api.github.com/repos/${repositoryPath(context.releaseRepository)}/releases/assets/${assetId}`
}

function requirePositiveId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive safe integer`)
  return value
}

function releaseBindingFromShape(release, context) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) fail('release response must be an object')
  const id = requirePositiveId(release.id, 'release ID')
  const apiUrl = canonicalReleaseApiUrl(context, id)
  const uploadUrl = canonicalReleaseUploadUrl(context, id)
  if (release.url !== apiUrl) fail(`release API URL does not bind release ID ${id}`)
  if (release.upload_url !== uploadUrl) fail(`release upload URL does not bind release ID ${id}`)
  if (release.tag_name !== context.tag) fail(`release tag does not equal ${context.tag}`)
  if (typeof release.body !== 'string') fail('release body must be a string')
  return {
    id,
    apiUrl,
    uploadUrl,
    tag: context.tag,
    bodySha256: sha256(Buffer.from(release.body, 'utf8')),
  }
}

function matchingRelease(payload, context) {
  const validation = validateReleasePreUpload(payload, context)
  assertNoErrors('draft release validation failed', validation.errors)
  if (validation.action !== 'resume' || validation.releaseCount !== 1) {
    fail(`expected exactly one existing private draft for ${context.tag}`)
  }
  return payload.flat().find(release => release.tag_name === context.tag)
}

function sameBinding(actual, expected) {
  return actual.id === expected.id
    && actual.apiUrl === expected.apiUrl
    && actual.uploadUrl === expected.uploadUrl
    && actual.tag === expected.tag
    && actual.bodySha256 === expected.bodySha256
}

function assertDraftReleaseById(release, context, expectedBinding) {
  const validation = validateReleasePreUpload([[release]], context)
  assertNoErrors('immutable draft release revalidation failed', validation.errors)
  if (validation.action !== 'resume' || validation.releaseCount !== 1) {
    fail(`release ${context.tag} is no longer the single resumable draft`)
  }
  const actualBinding = releaseBindingFromShape(release, context)
  if (!sameBinding(actualBinding, expectedBinding)) {
    fail('immutable release identity or body changed')
  }
  return actualBinding
}

function assertPublishedReleaseById(release, context, expectedBinding, label) {
  if (!release || typeof release !== 'object' || Array.isArray(release)) fail(`${label} must be an object`)
  if (release.draft !== false) fail(`${label} must be public`)
  if (release.prerelease !== false) fail(`${label} must not be a prerelease`)
  const shapeForMarkerValidation = { ...release, draft: true }
  const validation = validateReleasePreUpload([[shapeForMarkerValidation]], context)
  assertNoErrors(`${label} provenance validation failed`, validation.errors)
  const actualBinding = releaseBindingFromShape(release, context)
  if (!sameBinding(actualBinding, expectedBinding)) fail(`${label} identity or body changed`)
  return actualBinding
}

async function assertSourceTag(resolveSourceTagSha, context, label) {
  const resolved = await resolveSourceTagSha(context)
  if (resolved !== context.sha) fail(`${label}: source tag ${context.tag} resolved to ${String(resolved)}, expected ${context.sha}`)
}

function assertPlatformInputs({ platform, context, manifest, assetBytes }) {
  const names = platformReleaseAssetNames(platform, context.version)
  if (!(assetBytes instanceof Map)) fail('platform asset bytes must be a Map')
  const actualNames = [...assetBytes.keys()]
  if (JSON.stringify(actualNames.sort()) !== JSON.stringify([...names].sort())) {
    fail(`platform byte set must contain exactly ${names.length} expected assets`)
  }
  const assets = names.map(name => {
    const bytes = assetBytes.get(name)
    if (!(bytes instanceof Uint8Array) || bytes.byteLength <= 0) fail(`asset ${name} must contain non-empty bytes`)
    return { name, bytes }
  })
  const expectedManifest = buildRunManifest({ platform, context, assets })
  const comparableManifest = {
    schemaVersion: manifest?.schemaVersion,
    platform: manifest?.platform,
    source: manifest?.source,
    assets: manifest?.assets,
  }
  if (JSON.stringify(comparableManifest) !== JSON.stringify(expectedManifest)) {
    fail(`${platform} manifest does not match the current run bytes`)
  }
  return names
}

function assetByName(release, name) {
  return Array.isArray(release.assets) ? release.assets.find(asset => asset?.name === name) : undefined
}

function assertUploadedPlatformAssets(release, manifest, names, context) {
  const manifestByName = new Map(manifest.assets.map(asset => [asset.name, asset]))
  for (const name of names) {
    const remote = assetByName(release, name)
    const local = manifestByName.get(name)
    if (!remote || !local) fail(`post-upload release is missing ${name}`)
    const assetId = requirePositiveId(remote.id, `post-upload asset ID for ${name}`)
    if (remote.url !== canonicalAssetApiUrl(context, assetId)) {
      fail(`post-upload asset URL does not bind ${name} to ID ${assetId}`)
    }
    if (remote.state !== 'uploaded') fail(`post-upload state is invalid for ${name}`)
    if (remote.size !== local.size) fail(`post-upload size mismatch for ${name}`)
    if (remote.digest !== `sha256:${local.sha256}`) fail(`post-upload digest mismatch for ${name}`)
  }
}

export async function orchestratePlatformUpload({
  platform,
  context,
  manifest,
  assetBytes,
  resolveSourceTagSha,
  listReleases,
  getReleaseById,
  deleteAsset,
  uploadAsset,
}) {
  for (const [name, operation] of Object.entries({ resolveSourceTagSha, listReleases, getReleaseById, deleteAsset, uploadAsset })) {
    if (typeof operation !== 'function') fail(`${name} operation is required`)
  }
  const names = assertPlatformInputs({ platform, context, manifest, assetBytes })

  await assertSourceTag(resolveSourceTagSha, context, 'pre-upload validation')
  const release = matchingRelease(await listReleases(context), context)
  const binding = releaseBindingFromShape(release, context)
  assertDraftReleaseById(await getReleaseById(binding.id), context, binding)

  for (const name of names) {
    await assertSourceTag(resolveSourceTagSha, context, `immediately before ${name} upload`)
    let current = await getReleaseById(binding.id)
    assertDraftReleaseById(current, context, binding)
    const existing = assetByName(current, name)
    if (existing) {
      const assetId = requirePositiveId(existing.id, `asset ID for ${name}`)
      if (existing.url !== canonicalAssetApiUrl(context, assetId)) fail(`asset URL does not bind ${name} to ID ${assetId}`)
      await deleteAsset({ releaseId: binding.id, assetId, assetUrl: existing.url, name })
      await assertSourceTag(resolveSourceTagSha, context, `after deleting ${name}`)
      current = await getReleaseById(binding.id)
      assertDraftReleaseById(current, context, binding)
      if (assetByName(current, name)) fail(`asset ${name} still exists after deletion`)
    }

    await uploadAsset({
      releaseId: binding.id,
      uploadUrl: binding.uploadUrl,
      name,
      bytes: assetBytes.get(name),
      contentType: releaseAssetContentType(name),
    })
  }

  await assertSourceTag(resolveSourceTagSha, context, 'post-upload validation')
  const postUpload = await getReleaseById(binding.id)
  assertDraftReleaseById(postUpload, context, binding)
  assertUploadedPlatformAssets(postUpload, manifest, names, context)
  return {
    releaseId: binding.id,
    manifest: { ...manifest, release: binding },
  }
}

function canonicalAssetSnapshot(release, context) {
  if (!Array.isArray(release?.assets)) fail('release assets must be an array')
  const expectedNames = expectedReleaseAssetNames(context.version)
  const counts = new Map()
  for (const asset of release.assets) counts.set(asset?.name, (counts.get(asset?.name) ?? 0) + 1)
  const unexpected = [...counts.keys()].filter(name => !expectedNames.includes(name))
  const missing = expectedNames.filter(name => !counts.has(name))
  const duplicates = [...counts].filter(([, count]) => count !== 1).map(([name]) => name)
  if (release.assets.length !== expectedNames.length || unexpected.length || missing.length || duplicates.length) {
    fail(`release must contain the exact ordered snapshot source set (${expectedNames.length} unique assets)`)
  }
  const byName = new Map(release.assets.map(asset => [asset.name, asset]))
  return expectedNames.map(name => {
    const asset = byName.get(name)
    const id = requirePositiveId(asset?.id, `asset ID for ${name}`)
    if (asset.url !== canonicalAssetApiUrl(context, id)) fail(`asset URL does not bind ${name} to ID ${id}`)
    if (asset.state !== 'uploaded') fail(`asset ${name} is not uploaded`)
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) fail(`asset ${name} has an invalid size`)
    if (!/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '')) fail(`asset ${name} has an invalid digest`)
    return { name, size: asset.size, digest: asset.digest }
  })
}

function assertManifestBindings(manifests, binding) {
  if (!Array.isArray(manifests) || manifests.length !== 2) fail('exactly two post-upload manifests are required')
  for (const manifest of manifests) {
    const release = manifest?.release
    const keys = Object.keys(release ?? {}).sort()
    const expectedKeys = ['apiUrl', 'bodySha256', 'id', 'tag', 'uploadUrl']
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      fail(`${String(manifest?.platform)} manifest release binding fields are invalid`)
    }
    if (!sameBinding(release, binding)) fail(`${String(manifest?.platform)} manifest release binding does not match the immutable release`)
  }
}

function assertSnapshotEqual(expected, release, context, label) {
  const actual = canonicalAssetSnapshot(release, context)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} snapshot changed`)
  return actual
}

export async function orchestrateFinalPublication({
  context,
  manifests,
  resolveSourceTagSha,
  listReleases,
  downloadAsset,
  getReleaseById,
  publishRelease,
  getLatestRelease,
}) {
  for (const [name, operation] of Object.entries({ resolveSourceTagSha, listReleases, downloadAsset, getReleaseById, publishRelease, getLatestRelease })) {
    if (typeof operation !== 'function') fail(`${name} operation is required`)
  }

  await assertSourceTag(resolveSourceTagSha, context, 'initial final validation')
  const release = matchingRelease(await listReleases(context), context)
  const binding = releaseBindingFromShape(release, context)
  assertManifestBindings(manifests, binding)
  const snapshot = canonicalAssetSnapshot(release, context)
  const remoteByName = new Map(release.assets.map(asset => [asset.name, asset]))
  const assetBytes = new Map()
  for (const { name } of snapshot) {
    const asset = remoteByName.get(name)
    const bytes = await downloadAsset({
      releaseId: binding.id,
      assetId: asset.id,
      assetUrl: asset.url,
      name,
    })
    if (!(bytes instanceof Uint8Array)) fail(`downloaded asset ${name} is not bytes`)
    assetBytes.set(name, bytes)
  }
  const validation = validateReleaseBundle({
    context,
    releasePayload: [[release]],
    manifests,
    assetBytes,
  })
  assertNoErrors('complete release validation failed', validation.errors)
  if (validation.assetCount !== expectedReleaseAssetNames(context.version).length) {
    fail(`complete release validation found ${validation.assetCount} assets`)
  }

  await assertSourceTag(resolveSourceTagSha, context, 'immediately before publication')
  const prePatch = await getReleaseById(binding.id)
  assertDraftReleaseById(prePatch, context, binding)
  assertSnapshotEqual(snapshot, prePatch, context, 'pre-PATCH')

  await publishRelease({ releaseId: binding.id, draft: false, makeLatest: true })

  const readback = await getReleaseById(binding.id)
  assertPublishedReleaseById(readback, context, binding, 'post-PATCH readback')
  assertSnapshotEqual(snapshot, readback, context, 'post-PATCH readback')
  const latest = await getLatestRelease(context)
  assertPublishedReleaseById(latest, context, binding, 'latest release readback')
  assertSnapshotEqual(snapshot, latest, context, 'latest release readback')
  return { releaseId: binding.id, assetSnapshot: snapshot }
}

export function createGitHubReleaseApi({ token, context, fetchImpl = globalThis.fetch }) {
  if (typeof token !== 'string' || token.trim().length === 0) fail('GH_TOKEN is required')
  if (typeof fetchImpl !== 'function') fail('fetch implementation is required')
  const sourceRepository = repositoryPath(context.sourceRepository)
  const releaseRepository = repositoryPath(context.releaseRepository)
  const apiBase = 'https://api.github.com'
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'baby-diary-release-orchestrator',
  }

  async function request(url, options = {}) {
    const response = await fetchImpl(url, {
      ...options,
      headers: { ...headers, ...options.headers },
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000)
      fail(`GitHub API ${options.method ?? 'GET'} ${url} failed (${response.status}): ${detail}`)
    }
    return response
  }

  return {
    async resolveSourceTagSha() {
      const response = await request(`${apiBase}/repos/${sourceRepository}/commits/${encodeURIComponent(context.tag)}`)
      return (await response.json()).sha
    },
    async listReleases() {
      const pages = []
      for (let page = 1; page <= 100; page += 1) {
        const response = await request(`${apiBase}/repos/${releaseRepository}/releases?per_page=100&page=${page}`)
        const releases = await response.json()
        if (!Array.isArray(releases)) fail('GitHub releases response must be an array')
        pages.push(releases)
        if (releases.length < 100) return pages
      }
      fail('GitHub releases pagination exceeded 100 pages')
    },
    async getReleaseById(releaseId) {
      requirePositiveId(releaseId, 'release ID')
      return (await request(`${apiBase}/repos/${releaseRepository}/releases/${releaseId}`)).json()
    },
    async deleteAsset({ releaseId, assetId }) {
      requirePositiveId(releaseId, 'release ID')
      requirePositiveId(assetId, 'asset ID')
      await request(`${apiBase}/repos/${releaseRepository}/releases/assets/${assetId}`, { method: 'DELETE' })
    },
    async uploadAsset({ releaseId, uploadUrl, name, bytes, contentType }) {
      requirePositiveId(releaseId, 'release ID')
      if (uploadUrl !== canonicalReleaseUploadUrl(context, releaseId)) fail('upload URL does not match immutable release ID')
      const endpoint = new URL(uploadUrl.replace(/\{[^}]+\}$/, ''))
      endpoint.searchParams.set('name', name)
      return (await request(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'Content-Type': contentType,
          'Content-Length': String(bytes.byteLength),
        },
        body: bytes,
      })).json()
    },
    async downloadAsset({ assetId, assetUrl }) {
      requirePositiveId(assetId, 'asset ID')
      if (assetUrl !== canonicalAssetApiUrl(context, assetId)) fail('asset download URL does not match immutable asset ID')
      const response = await request(assetUrl, { headers: { Accept: 'application/octet-stream' } })
      return new Uint8Array(await response.arrayBuffer())
    },
    async publishRelease({ releaseId, draft, makeLatest }) {
      requirePositiveId(releaseId, 'release ID')
      if (draft !== false || makeLatest !== true) fail('publication must make the validated release public and latest')
      return (await request(`${apiBase}/repos/${releaseRepository}/releases/${releaseId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: false, make_latest: 'true' }),
      })).json()
    },
    async getLatestRelease() {
      return (await request(`${apiBase}/repos/${releaseRepository}/releases/latest`)).json()
    },
  }
}
