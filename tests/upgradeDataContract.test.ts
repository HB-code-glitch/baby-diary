import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as contract from '../scripts/upgrade-data-contract.mjs'

const roots: string[] = []

function tempRoot(label = 'profile') {
  const root = mkdtempSync(join(tmpdir(), `baby-diary-upgrade-${label}-`))
  roots.push(root)
  return root
}

function cloneRoot(source: string, label: string) {
  const destination = join(tempRoot(`${label}-container`), 'profile')
  copyTree(source, destination)
  return destination
}

function copyTree(source: string, destination: string) {
  mkdirSync(destination, { recursive: true })
  for (const name of readdirSync(source)) {
    const sourcePath = join(source, name)
    const destinationPath = join(destination, name)
    if (lstatSync(sourcePath).isDirectory()) copyTree(sourcePath, destinationPath)
    else copyFileSync(sourcePath, destinationPath)
  }
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  )
}

function rewriteJsonWithReorderedKeys(root: string) {
  const settingsPath = join(root, 'settings.json')
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
  writeFileSync(settingsPath, `${JSON.stringify(reverseObjectKeys(settings), null, 2)}\n`)

  const dataRoot = join(root, 'data')
  for (const file of contract.listFixtureEventFiles(root)) {
    const absolute = join(dataRoot, file)
    const reordered = readFileSync(absolute, 'utf8')
      .trimEnd()
      .split('\n')
      .map(line => JSON.stringify(reverseObjectKeys(JSON.parse(line))))
      .join('\n')
    writeFileSync(absolute, `${reordered}\n`)
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('v0.3.8 upgrade data contract', () => {
  it('pins the immutable source and exact public release assets', () => {
    expect(existsSync(resolve(import.meta.dirname, '../scripts/upgrade-data-contract.mjs'))).toBe(true)
    expect(contract.V038_SOURCE).toEqual({
      tag: 'v0.3.8',
      commit: '4ad44829c0de56da33d9123c16f92e6090f0df4a',
      releaseId: 352876543,
      publishedAt: '2026-07-13T00:17:33Z',
    })
    expect(contract.V038_RELEASE_ASSETS.windows).toEqual({
      id: 474870034,
      name: 'Baby-Diary-Setup-0.3.8.exe',
      size: 233249330,
      sha256: 'edb3a3e2d036f0d16dc8d75948c3f160c35adc9d1277a3dedc41d8671bd6a6de',
    })
    expect(contract.V038_RELEASE_ASSETS.mac).toEqual({
      id: 474869787,
      name: 'Baby-Diary-0.3.8-universal.dmg',
      size: 351533375,
      sha256: '2793e91c0dc49b436451f150ba0c8dc625cfd1a988841823a114d597e2f60974',
    })
  })

  it('builds and validates an explicit v0.3.8-compatible multilingual fixture', async () => {
    const root = tempRoot()
    const fixture = contract.buildV038Fixture()
    expect(fixture.events.map(event => event.type)).toEqual(expect.arrayContaining([
      'pee', 'poop', 'temp', 'breast', 'formula', 'diary', 'message', 'sleep', 'growth',
    ]))
    expect(JSON.stringify(fixture)).toMatch(/하루|기저귀|ハル|ミルク/)
    expect(fixture.events.some(event => event.rev > 1)).toBe(true)
    expect(fixture.events.some(event => event.deleted)).toBe(true)
    expect(fixture.events.some(event => event.mutationId === undefined)).toBe(true)
    expect(fixture.settings.babyInfoSync.mutations).toHaveLength(2)
    expect(fixture.settings.babyInfoSync.pendingMutationKeys).toHaveLength(1)

    await contract.writeV038Fixture(root)
    const projection = await contract.validateV038Fixture(root)
    expect(projection.eventSources).toHaveLength(fixture.events.length)
    expect(projection.babyInfo.pendingKeys).toHaveLength(1)
    expect(projection.babyInfo.acknowledgedKeys).toHaveLength(1)
  })

  it('streams a canonically sorted full manifest and catches a missing byte or extra file', async () => {
    const beforeRoot = tempRoot('raw-before')
    mkdirSync(join(beforeRoot, 'data'), { recursive: true })
    writeFileSync(join(beforeRoot, 'settings.json'), '{"ok":true}\n')
    writeFileSync(join(beforeRoot, 'data', 'events.jsonl'), '{"id":1}\n')
    const before = await contract.createRawManifest(beforeRoot)
    expect(before.entries.map(entry => entry.path)).toEqual(['data', 'data/events.jsonl', 'settings.json'])

    const missingByteRoot = cloneRoot(beforeRoot, 'raw-byte')
    writeFileSync(join(missingByteRoot, 'settings.json'), '{"ok":true}')
    const missingByte = await contract.createRawManifest(missingByteRoot)
    expect(contract.compareRawManifests(before, missingByte)).toMatchObject({ equal: false })
    expect(() => contract.assertRawManifestsEqual(before, missingByte)).toThrow(/changed.*settings\.json/i)

    const extraRoot = cloneRoot(beforeRoot, 'raw-extra')
    writeFileSync(join(extraRoot, 'unexpected.txt'), 'extra')
    const extra = await contract.createRawManifest(extraRoot)
    expect(() => contract.assertRawManifestsEqual(before, extra)).toThrow(/added.*unexpected\.txt/i)
  })

  it('exposes a narrow manifest CLI seam for platform wrappers', async () => {
    const root = tempRoot('manifest-cli')
    writeFileSync(join(root, 'settings.json'), '{"ok":true}\n')
    const manifestPath = join(tempRoot('manifest-output'), 'raw.json')
    await contract.runDataContractCli([
      'manifest', '--root', root, '--output', manifestPath,
    ])
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({ version: 1 })
    await expect(contract.runDataContractCli([
      'compare-manifest', '--root', root, '--before', manifestPath,
    ])).resolves.toMatchObject({ equal: true })
    writeFileSync(join(root, 'extra'), 'x')
    await expect(contract.runDataContractCli([
      'compare-manifest', '--root', root, '--before', manifestPath,
    ])).rejects.toThrow(/added.*extra/i)
  })

  it('rejects case collisions, traversal, links/reparse points, and file/tree cap breaches', async () => {
    expect(() => contract.validateRawManifestEntries([
      { path: 'Data/value', type: 'file', size: 0, sha256: '0'.repeat(64) },
      { path: 'data/value', type: 'file', size: 0, sha256: '0'.repeat(64) },
    ])).toThrow(/case collision/i)
    expect(() => contract.validateRawManifestEntries([
      { path: '../escape', type: 'file', size: 0, sha256: '0'.repeat(64) },
    ])).toThrow(/traversal/i)

    const linkedRoot = tempRoot('link')
    const target = join(linkedRoot, 'target')
    mkdirSync(target)
    symlinkSync(target, join(linkedRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(contract.createRawManifest(linkedRoot)).rejects.toThrow(/link|reparse/i)

    const cappedRoot = tempRoot('caps')
    writeFileSync(join(cappedRoot, 'large-a'), '12345')
    await expect(contract.createRawManifest(cappedRoot, { maxFileBytes: 4 })).rejects.toThrow(/file.*cap/i)
    writeFileSync(join(cappedRoot, 'large-b'), '12345')
    await expect(contract.createRawManifest(cappedRoot, { maxFileBytes: 8, maxTreeBytes: 8 })).rejects.toThrow(/tree.*cap/i)
  })

  it('normalizes the legacy settings sync state and the migrated journal to the same semantics', async () => {
    const baselineRoot = tempRoot('legacy-sync')
    await contract.writeV038Fixture(baselineRoot)
    const migratedRoot = cloneRoot(baselineRoot, 'journal')
    await contract.materializeMigratedBabyInfoJournal(migratedRoot)

    const baseline = await contract.projectUpgradeSemantics(baselineRoot)
    const migrated = await contract.projectUpgradeSemantics(migratedRoot)
    expect(() => contract.assertSemanticPreservation(baseline, migrated)).not.toThrow()
    expect(migrated.babyInfo).toEqual(baseline.babyInfo)
  })

  it('rejects a duplicate migration derivative and a tombstone resurrection', async () => {
    const baselineRoot = tempRoot('baseline')
    await contract.writeV038Fixture(baselineRoot)
    const baseline = await contract.projectUpgradeSemantics(baselineRoot)

    const duplicateRoot = cloneRoot(baselineRoot, 'duplicate')
    const derivative = contract.buildFixtureEventDerivative()
    const derivativePath = join(duplicateRoot, 'data', 'events-2026-07.jsonl')
    appendFileSync(derivativePath, `${JSON.stringify(derivative)}\n${JSON.stringify(derivative)}\n`)
    await expect(contract.projectUpgradeSemantics(duplicateRoot)).rejects.toThrow(/duplicate mutation derivative/i)

    const resurrectedRoot = cloneRoot(baselineRoot, 'resurrected')
    const resurrection = contract.buildFixtureTombstoneResurrection()
    appendFileSync(join(resurrectedRoot, 'data', 'events-2026-07.jsonl'), `${JSON.stringify(resurrection)}\n`)
    const resurrected = await contract.projectUpgradeSemantics(resurrectedRoot)
    expect(() => contract.assertSemanticPreservation(baseline, resurrected)).toThrow(/event|tombstone/i)
  })

  it('rejects pending-work loss and account/family substitution', async () => {
    const baselineRoot = tempRoot('identity-before')
    await contract.writeV038Fixture(baselineRoot)
    const baseline = await contract.projectUpgradeSemantics(baselineRoot)

    const missingPendingRoot = cloneRoot(baselineRoot, 'pending-missing')
    const pendingSettingsPath = join(missingPendingRoot, 'settings.json')
    const pendingSettings = JSON.parse(readFileSync(pendingSettingsPath, 'utf8'))
    pendingSettings.babyInfoSync.pendingMutationKeys = []
    writeFileSync(pendingSettingsPath, JSON.stringify(pendingSettings, null, 2))
    const missingPending = await contract.projectUpgradeSemantics(missingPendingRoot)
    expect(() => contract.assertSemanticPreservation(baseline, missingPending)).toThrow(/pending/i)

    const substitutedRoot = cloneRoot(baselineRoot, 'identity-after')
    const identitySettingsPath = join(substitutedRoot, 'settings.json')
    const identitySettings = JSON.parse(readFileSync(identitySettingsPath, 'utf8'))
    identitySettings.profile.uid = 'substituted-account'
    identitySettings.familyId = 'substituted-family'
    writeFileSync(identitySettingsPath, JSON.stringify(identitySettings, null, 2))
    const substituted = await contract.projectUpgradeSemantics(substitutedRoot)
    expect(() => contract.assertSemanticPreservation(baseline, substituted)).toThrow(/account|family|identity/i)
  })

  it('allows reordered JSON keys only in the semantic projection, not the raw manifest', async () => {
    const beforeRoot = tempRoot('keys-before')
    await contract.writeV038Fixture(beforeRoot)
    const reorderedRoot = cloneRoot(beforeRoot, 'keys-after')
    rewriteJsonWithReorderedKeys(reorderedRoot)

    const beforeManifest = await contract.createRawManifest(beforeRoot)
    const reorderedManifest = await contract.createRawManifest(reorderedRoot)
    expect(contract.compareRawManifests(beforeManifest, reorderedManifest).equal).toBe(false)

    const beforeProjection = await contract.projectUpgradeSemantics(beforeRoot)
    const reorderedProjection = await contract.projectUpgradeSemantics(reorderedRoot)
    expect(() => contract.assertSemanticPreservation(beforeProjection, reorderedProjection)).not.toThrow()
    expect(contract.semanticProjectionHash(beforeProjection)).toBe(contract.semanticProjectionHash(reorderedProjection))
  })

  it('requires second-run semantic idempotence, including derivative multiplicity', async () => {
    const firstRoot = tempRoot('first-run')
    await contract.writeV038Fixture(firstRoot)
    const derivative = contract.buildFixtureEventDerivative()
    appendFileSync(join(firstRoot, 'data', 'events-2026-07.jsonl'), `${JSON.stringify(derivative)}\n`)
    const first = await contract.projectUpgradeSemantics(firstRoot)

    const secondRoot = cloneRoot(firstRoot, 'second-run')
    const second = await contract.projectUpgradeSemantics(secondRoot)
    expect(() => contract.assertSemanticIdempotence(first, second)).not.toThrow()

    const changedRoot = cloneRoot(firstRoot, 'second-changed')
    const changed = contract.buildFixtureEventDerivative({
      mutationId: '33333333-3333-4333-8333-333333333333',
    })
    appendFileSync(join(changedRoot, 'data', 'events-2026-07.jsonl'), `${JSON.stringify(changed)}\n`)
    const changedProjection = await contract.projectUpgradeSemantics(changedRoot)
    expect(() => contract.assertSemanticIdempotence(first, changedProjection)).toThrow(/idempotent|derivative/i)
  })
})
