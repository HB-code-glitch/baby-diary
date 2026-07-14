import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

import {
  buildRunManifest,
  createSourceProvenanceMarker,
  expectedReleaseAssetNames,
  platformReleaseAssetNames,
  validateReleaseBundle,
  validateReleasePreUpload,
} from '../scripts/release-provenance.mjs'

const yaml = createRequire(import.meta.url)('js-yaml') as {
  dump(value: unknown, options?: Record<string, unknown>): string
  load(source: string): unknown
}

const VERSION = '0.3.9'
const CONTEXT = Object.freeze({
  sourceRepository: 'HB-code-glitch/baby-diary',
  releaseRepository: 'HB-code-glitch/baby-diary-releases',
  tag: `v${VERSION}`,
  sha: 'a'.repeat(40),
  version: VERSION,
  workflowRunId: '24681012',
  workflowRunAttempt: '2',
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha512(bytes: Uint8Array): string {
  return createHash('sha512').update(bytes).digest('base64')
}

function updaterFile(name: string, bytes: Uint8Array) {
  return { url: name, sha512: sha512(bytes), size: bytes.byteLength }
}

function releaseBundleFixture() {
  const assetBytes = new Map<string, Buffer>()
  for (const name of expectedReleaseAssetNames(VERSION)) {
    assetBytes.set(name, Buffer.from(`current-run:${name}`, 'utf8'))
  }

  const universalDmg = `Baby-Diary-${VERSION}-universal.dmg`
  assetBytes.set('INSTALL-ME-BabyDiary-Mac.dmg', Buffer.from(assetBytes.get(universalDmg)!))

  const winPrimary = `Baby-Diary-Setup-${VERSION}.exe`
  const macArmPrimary = `Baby-Diary-${VERSION}-arm64-mac.zip`
  const macUniversalPrimary = `Baby-Diary-${VERSION}-universal-mac.zip`
  const updaterDocuments = {
    'latest.yml': {
      version: VERSION,
      files: [updaterFile(winPrimary, assetBytes.get(winPrimary)!)],
      path: winPrimary,
      sha512: sha512(assetBytes.get(winPrimary)!),
    },
    'latest-mac.yml': {
      version: VERSION,
      files: [
        updaterFile(macArmPrimary, assetBytes.get(macArmPrimary)!),
        updaterFile(macUniversalPrimary, assetBytes.get(macUniversalPrimary)!),
      ],
      path: macUniversalPrimary,
      sha512: sha512(assetBytes.get(macUniversalPrimary)!),
    },
  } as Record<string, Record<string, unknown>>

  for (const [name, document] of Object.entries(updaterDocuments)) {
    assetBytes.set(name, Buffer.from(yaml.dump(document, { noRefs: true, lineWidth: -1 }), 'utf8'))
  }

  const manifests = (['mac', 'windows'] as const).map(platform => buildRunManifest({
    platform,
    context: CONTEXT,
    assets: platformReleaseAssetNames(platform, VERSION).map(name => ({
      name,
      bytes: assetBytes.get(name)!,
    })),
  }))

  const release = {
    tag_name: CONTEXT.tag,
    draft: true,
    prerelease: false,
    body: createSourceProvenanceMarker(CONTEXT),
    assets: expectedReleaseAssetNames(VERSION).map(name => {
      const bytes = assetBytes.get(name)!
      return {
        name,
        state: 'uploaded',
        size: bytes.byteLength,
        digest: `sha256:${sha256(bytes)}`,
      }
    }),
  }

  return {
    context: { ...CONTEXT },
    releasePayload: [[release]],
    manifests,
    assetBytes,
    updaterDocuments,
  }
}

type BundleFixture = ReturnType<typeof releaseBundleFixture>

function releaseOf(bundle: BundleFixture) {
  return bundle.releasePayload[0][0]
}

function manifestAsset(bundle: BundleFixture, name: string) {
  const entry = bundle.manifests.flatMap(manifest => manifest.assets)
    .find(asset => asset.name === name)
  if (!entry) throw new Error(`missing manifest fixture asset ${name}`)
  return entry
}

function remoteAsset(bundle: BundleFixture, name: string) {
  const entry = releaseOf(bundle).assets.find(asset => asset.name === name)
  if (!entry) throw new Error(`missing remote fixture asset ${name}`)
  return entry
}

function rewriteUpdater(
  bundle: BundleFixture,
  name: 'latest.yml' | 'latest-mac.yml',
  mutate: (document: any) => void,
) {
  const document = structuredClone(bundle.updaterDocuments[name])
  mutate(document)
  const bytes = Buffer.from(yaml.dump(document, { noRefs: true, lineWidth: -1 }), 'utf8')
  bundle.assetBytes.set(name, bytes)
  const manifest = manifestAsset(bundle, name)
  manifest.size = bytes.byteLength
  manifest.sha256 = sha256(bytes)
  const remote = remoteAsset(bundle, name)
  remote.size = bytes.byteLength
  remote.digest = `sha256:${sha256(bytes)}`
}

function validate(bundle: BundleFixture) {
  return validateReleaseBundle(bundle)
}

function expectRejected(bundle: BundleFixture, message: string) {
  expect(validate(bundle).errors).toEqual(expect.arrayContaining([expect.stringContaining(message)]))
}

describe('source provenance draft guard', () => {
  it('accepts an absent release and emits the exact marker for one prepare transition', () => {
    const result = validateReleasePreUpload([[]], CONTEXT)

    expect(result.errors).toEqual([])
    expect(result.action).toBe('create')
    expect(result.provenanceMarker).toBe(createSourceProvenanceMarker(CONTEXT))
  })

  it('allows resuming exactly one private draft from the same source tag SHA', () => {
    const bundle = releaseBundleFixture()
    const result = validateReleasePreUpload(bundle.releasePayload, CONTEXT)

    expect(result.errors).toEqual([])
    expect(result.action).toBe('resume')
  })

  it.each([
    ['source repository', 'sourceRepository', 'another/repository'],
    ['release repository', 'releaseRepository', 'another/releases'],
    ['tag', 'tag', 'v0.3.8'],
    ['SHA', 'sha', 'b'.repeat(40)],
    ['version', 'version', '0.3.8'],
  ] as const)('rejects a resumed draft with stale %s provenance', (_label, field, value) => {
    const bundle = releaseBundleFixture()
    releaseOf(bundle).body = createSourceProvenanceMarker({ ...CONTEXT, [field]: value })

    expect(validateReleasePreUpload(bundle.releasePayload, CONTEXT).errors).not.toEqual([])
  })

  it('rejects a resumed draft with missing or duplicated provenance', () => {
    const missing = releaseBundleFixture()
    releaseOf(missing).body = 'ordinary release notes'
    expect(validateReleasePreUpload(missing.releasePayload, CONTEXT).errors.join('\n')).toContain('provenance')

    const duplicate = releaseBundleFixture()
    releaseOf(duplicate).body += `\n${createSourceProvenanceMarker(CONTEXT)}`
    expect(validateReleasePreUpload(duplicate.releasePayload, CONTEXT).errors.join('\n')).toContain('provenance')
  })

  it.each([
    ['public release', (bundle: BundleFixture) => { releaseOf(bundle).draft = false }],
    ['prerelease', (bundle: BundleFixture) => { releaseOf(bundle).prerelease = true }],
    ['duplicate release', (bundle: BundleFixture) => { bundle.releasePayload[0].push(structuredClone(releaseOf(bundle))) }],
    ['unexpected asset', (bundle: BundleFixture) => { releaseOf(bundle).assets.push({ name: 'stale.exe', state: 'uploaded', size: 1, digest: `sha256:${'f'.repeat(64)}` }) }],
    ['duplicate asset', (bundle: BundleFixture) => { releaseOf(bundle).assets.push(structuredClone(releaseOf(bundle).assets[0])) }],
  ] as const)('fails before upload for a %s', (_label, mutate) => {
    const bundle = releaseBundleFixture()
    mutate(bundle)
    expect(validateReleasePreUpload(bundle.releasePayload, CONTEXT).errors).not.toEqual([])
  })
})

describe('current-run release manifest validation', () => {
  it('accepts the exact 14 current-run assets from matching Mac and Windows manifests', () => {
    const result = validate(releaseBundleFixture())

    expect(result.errors).toEqual([])
    expect(result.assetCount).toBe(14)
  })

  it.each([
    ['source repository', 'sourceRepository', 'another/repository'],
    ['release repository', 'releaseRepository', 'another/releases'],
    ['tag', 'tag', 'v0.3.8'],
    ['SHA', 'sha', 'b'.repeat(40)],
    ['version', 'version', '0.3.8'],
    ['workflow run id', 'workflowRunId', '999'],
    ['workflow run attempt', 'workflowRunAttempt', '9'],
  ] as const)('rejects a manifest with the wrong %s', (_label, field, value) => {
    const bundle = releaseBundleFixture()
    bundle.manifests[0].source[field] = value
    expectRejected(bundle, field)
  })

  it('rejects two platform manifests created from different SHAs or workflow runs', () => {
    const differentSha = releaseBundleFixture()
    differentSha.manifests[1].source.sha = 'c'.repeat(40)
    expectRejected(differentSha, 'sha')

    const differentRun = releaseBundleFixture()
    differentRun.manifests[1].source.workflowRunId = '13579'
    expectRejected(differentRun, 'workflowRunId')
  })

  it('rejects a syntactically valid GitHub digest that differs from the current-run manifest', () => {
    const bundle = releaseBundleFixture()
    remoteAsset(bundle, `Baby-Diary-${VERSION}.exe`).digest = `sha256:${'f'.repeat(64)}`
    expectRejected(bundle, 'remote digest')
  })

  it('rejects a GitHub size that differs from the current-run manifest', () => {
    const bundle = releaseBundleFixture()
    remoteAsset(bundle, `Baby-Diary-${VERSION}.exe`).size += 1
    expectRejected(bundle, 'remote size')
  })

  it('rejects stale or mixed bytes even when manifest and remote digest formats are valid', () => {
    const bundle = releaseBundleFixture()
    const name = `Baby-Diary-${VERSION}-arm64.dmg`
    const staleBytes = Buffer.from('earlier-run-bytes')
    manifestAsset(bundle, name).sha256 = sha256(staleBytes)
    remoteAsset(bundle, name).digest = `sha256:${sha256(staleBytes)}`
    expectRejected(bundle, 'downloaded digest')
  })

  it.each([
    ['missing asset', (bundle: BundleFixture) => { releaseOf(bundle).assets.pop() }],
    ['unexpected asset', (bundle: BundleFixture) => { releaseOf(bundle).assets.push({ name: 'mixed-old-run.exe', state: 'uploaded', size: 1, digest: `sha256:${'e'.repeat(64)}` }) }],
    ['duplicate asset', (bundle: BundleFixture) => { releaseOf(bundle).assets.push(structuredClone(releaseOf(bundle).assets[0])) }],
  ] as const)('rejects a %s in the external release', (_label, mutate) => {
    const bundle = releaseBundleFixture()
    mutate(bundle)
    expect(validate(bundle).errors).not.toEqual([])
  })

  it.each([
    ['public release', (bundle: BundleFixture) => { releaseOf(bundle).draft = false }],
    ['prerelease', (bundle: BundleFixture) => { releaseOf(bundle).prerelease = true }],
    ['duplicate matching release', (bundle: BundleFixture) => { bundle.releasePayload.push([structuredClone(releaseOf(bundle))]) }],
  ] as const)('rejects a %s at the final publish gate', (_label, mutate) => {
    const bundle = releaseBundleFixture()
    mutate(bundle)
    expect(validate(bundle).errors).not.toEqual([])
  })
})

describe('structural updater metadata validation', () => {
  it.each([
    ['wrong sha512', (document: any) => { document.files[0].sha512 = sha512(Buffer.from('wrong')) }, 'sha512'],
    ['wrong size', (document: any) => { document.files[0].size += 1 }, 'size'],
    ['stale version', (document: any) => { document.version = '0.3.8' }, 'version'],
    ['wrong top-level path', (document: any) => { document.path = `Baby-Diary-Setup-0.3.8.exe` }, 'path'],
    ['wrong top-level sha512', (document: any) => { document.sha512 = sha512(Buffer.from('wrong')) }, 'sha512'],
  ] as const)('rejects latest.yml with %s', (_label, mutate, message) => {
    const bundle = releaseBundleFixture()
    rewriteUpdater(bundle, 'latest.yml', mutate)
    expectRejected(bundle, message)
  })

  it.each([
    ['path traversal', '../Baby-Diary-Setup-0.3.9.exe'],
    ['absolute path', 'C:\\temp\\Baby-Diary-Setup-0.3.9.exe'],
    ['URL indirection', 'https://example.invalid/Baby-Diary-Setup-0.3.9.exe'],
  ])('rejects updater file %s', (_label, url) => {
    const bundle = releaseBundleFixture()
    rewriteUpdater(bundle, 'latest.yml', document => { document.files[0].url = url })
    expectRejected(bundle, 'safe asset name')
  })

  it('rejects duplicate updater file entries', () => {
    const bundle = releaseBundleFixture()
    rewriteUpdater(bundle, 'latest-mac.yml', document => {
      document.files.push(structuredClone(document.files[0]))
    })
    expectRejected(bundle, 'duplicate updater')
  })

  it('rejects updater entries that point at a different platform asset', () => {
    const bundle = releaseBundleFixture()
    const macZip = `Baby-Diary-${VERSION}-universal-mac.zip`
    rewriteUpdater(bundle, 'latest.yml', document => {
      document.files.push(updaterFile(macZip, bundle.assetBytes.get(macZip)!))
    })
    expectRejected(bundle, 'unexpected updater asset')
  })

  it('rejects a missing Windows updater primary and an unreferenced Mac architecture primary', () => {
    const missingWindows = releaseBundleFixture()
    rewriteUpdater(missingWindows, 'latest.yml', document => { document.files = [] })
    expectRejected(missingWindows, 'updater primary')

    const missingMac = releaseBundleFixture()
    rewriteUpdater(missingMac, 'latest-mac.yml', document => { document.files.shift() })
    expectRejected(missingMac, 'updater primary')
  })

  it('rejects an install alias whose bytes differ from the universal DMG', () => {
    const bundle = releaseBundleFixture()
    const alias = 'INSTALL-ME-BabyDiary-Mac.dmg'
    const different = Buffer.from('different-alias-bytes')
    bundle.assetBytes.set(alias, different)
    manifestAsset(bundle, alias).size = different.byteLength
    manifestAsset(bundle, alias).sha256 = sha256(different)
    remoteAsset(bundle, alias).size = different.byteLength
    remoteAsset(bundle, alias).digest = `sha256:${sha256(different)}`
    expectRejected(bundle, 'alias')
  })
})
