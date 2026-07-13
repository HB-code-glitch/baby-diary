import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as contract from '../scripts/upgrade-data-contract.mjs'
import { V038_DEFAULT_FIREBASE_EVIDENCE } from '../scripts/upgrade-firebase-continuity.mjs'

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
  it('preseeds only the exact v0.3.8 settings schema with emulator config before first launch', async () => {
    const root = tempRoot('firebase-bootstrap')
    await contract.writeV038FirebaseBootstrap(root)
    const settings = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))
    expect(settings.familyId).toBe('')
    expect(settings.profile.uid).toBe('')
    const stableJson = (value: any): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value)
      if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
    }
    expect(createHash('sha256').update(settings.firebase.apiKey).digest('hex'))
      .toBe(V038_DEFAULT_FIREBASE_EVIDENCE.apiKeySha256)
    expect(createHash('sha256').update(stableJson(settings.firebase)).digest('hex'))
      .toBe(V038_DEFAULT_FIREBASE_EVIDENCE.configSha256)
    expect(settings).not.toHaveProperty('babyInfoSync')
    expect(settings).not.toHaveProperty('upgradeOpaque')
    expect(settings.profile).not.toHaveProperty('legacyContact')
    expect(Object.keys(settings).sort()).toEqual([
      'baby', 'familyId', 'firebase', 'language', 'profile', 'theme',
    ])
    expect(existsSync(join(root, 'data'))).toBe(false)
    expect(existsSync(join(root, 'Local Storage', 'upgrade-auth-sentinel.json'))).toBe(false)
  })

  it('binds the historical fixture to the real authenticated uid and created family', () => {
    const fixture = contract.buildV038Fixture({
      profileUid: 'firebase-auth-uid',
      familyId: 'firestore-family-id',
    })
    expect(fixture.settings.profile.uid).toBe('firebase-auth-uid')
    expect(fixture.settings.familyId).toBe('firestore-family-id')
    expect(fixture.settings.babyInfoSync.mutations.every(
      (mutation: any) => mutation.familyId === 'firestore-family-id',
    )).toBe(true)
    expect(fixture.settings.babyInfoSync.mutations[0].authorId).toBe('firebase-auth-uid')
    expect(fixture.settings.babyInfoSync.pendingMutationKeys).toHaveLength(1)
    expect(fixture.settings.babyInfoSync.pendingMutationKeys[0]).toBe(
      contract.getBabyInfoMutationKey(fixture.settings.babyInfoSync.mutations[1]),
    )
  })

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
    expect(fixture.settings.upgradeOpaque.deep.nested).toEqual({
      ko: '보존',
      ja: '保持',
      values: [0, false, null, { marker: 'v0.3.8' }],
    })

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

  it('binds an exact CI provenance document to the complete candidate package digest', async () => {
    const root = tempRoot('candidate-provenance')
    const packagePath = join(root, 'Baby-Diary-Setup-0.3.9.exe')
    const provenancePath = join(root, 'candidate-provenance.json')
    const outputPath = join(root, 'verified-provenance.json')
    writeFileSync(packagePath, 'complete candidate package bytes')
    const artifactSha256 = createHash('sha256')
      .update(readFileSync(packagePath))
      .digest('hex')
    const provenance = {
      schemaVersion: 1,
      repository: 'HB-code-glitch/BABY-DIARY',
      workflowRunId: '1234567890',
      sourceSha: 'a'.repeat(40),
      releaseTag: 'v0.3.9',
      appVersion: '0.3.9',
      platform: 'windows-x64',
      artifactName: 'Baby-Diary-Setup-0.3.9.exe',
      artifactSha256,
    }
    writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`)

    await expect(contract.runDataContractCli([
      'verify-provenance',
      '--package', packagePath,
      '--provenance', provenancePath,
      '--output', outputPath,
      '--expected-repository', provenance.repository,
      '--expected-workflow-run-id', provenance.workflowRunId,
      '--expected-source-sha', provenance.sourceSha,
      '--expected-release-tag', provenance.releaseTag,
      '--expected-app-version', provenance.appVersion,
      '--expected-platform', provenance.platform,
      '--expected-artifact-name', provenance.artifactName,
      '--expected-artifact-sha256', artifactSha256,
    ])).resolves.toEqual(provenance)
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(provenance)

    appendFileSync(packagePath, '-tampered')
    await expect(contract.verifyCandidateProvenance({
      packagePath,
      provenancePath,
      expected: {
        repository: provenance.repository,
        workflowRunId: provenance.workflowRunId,
        sourceSha: provenance.sourceSha,
        releaseTag: provenance.releaseTag,
        appVersion: provenance.appVersion,
        platform: provenance.platform,
        artifactName: provenance.artifactName,
        artifactSha256,
      },
    })).rejects.toThrow(/package SHA-256 mismatch/i)

    writeFileSync(packagePath, 'complete candidate package bytes')
    writeFileSync(provenancePath, JSON.stringify({ ...provenance, unexpected: true }))
    await expect(contract.verifyCandidateProvenance({
      packagePath,
      provenancePath,
      expected: {
        repository: provenance.repository,
        workflowRunId: provenance.workflowRunId,
        sourceSha: provenance.sourceSha,
        releaseTag: provenance.releaseTag,
        appVersion: provenance.appVersion,
        platform: provenance.platform,
        artifactName: provenance.artifactName,
        artifactSha256,
      },
    })).rejects.toThrow(/exact fields/i)
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

  it('rejects a manifest file path swapped after its descriptor is opened', async () => {
    const root = tempRoot('descriptor-swap')
    const file = join(root, 'settings.json')
    writeFileSync(file, '{"original":true}\n')
    let swapped = false

    await expect(contract.createRawManifest(root, {
      afterFileOpen: async ({ relativePath }: { relativePath: string }) => {
        if (relativePath !== 'settings.json' || swapped) return
        swapped = true
        renameSync(file, join(root, 'settings.original.json'))
        writeFileSync(file, '{"replacement":true}\n')
      },
    })).rejects.toThrow(/changed|identity|TOCTOU/i)
    expect(swapped).toBe(true)
  })

  it('rejects semantic projection through an external data junction or symlink', async () => {
    const root = tempRoot('semantic-data-link')
    const externalData = tempRoot('semantic-external-data')
    await contract.writeV038Fixture(root)
    copyTree(join(root, 'data'), externalData)
    rmSync(join(root, 'data'), { recursive: true, force: true })
    symlinkSync(externalData, join(root, 'data'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(contract.projectUpgradeSemantics(root)).rejects.toThrow(/data|link|reparse|canonical/i)
  })

  it('accepts only a real canonical profile root, not a linked alias', async () => {
    const canonicalRoot = tempRoot('semantic-canonical-root')
    const aliasContainer = tempRoot('semantic-profile-alias')
    const linkedRoot = join(aliasContainer, 'profile')
    await contract.writeV038Fixture(canonicalRoot)
    symlinkSync(canonicalRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(contract.projectUpgradeSemantics(linkedRoot)).rejects.toThrow(/canonical|profile|link|reparse/i)
  })

  it('rejects settings, journal, event, and auxiliary path swaps after descriptor open', async () => {
    const cases = [
      { label: 'settings', relativePath: 'settings.json' },
      { label: 'journal', relativePath: 'baby-info-journal-v1.jsonl', journal: true },
      { label: 'event', relativePath: 'data/events-2026-07.jsonl' },
      { label: 'auxiliary', relativePath: 'auxiliary/legacy-attachment.bin' },
    ]

    for (const testCase of cases) {
      const root = tempRoot(`semantic-${testCase.label}-swap`)
      await contract.writeV038Fixture(root)
      if (testCase.journal) await contract.materializeMigratedBabyInfoJournal(root)
      const absolute = join(root, ...testCase.relativePath.split('/'))
      const originalBytes = readFileSync(absolute)
      let swapped = false

      await expect(contract.projectUpgradeSemantics(root, {
        afterFileOpen: async ({ relativePath }: { relativePath: string }) => {
          if (relativePath !== testCase.relativePath || swapped) return
          swapped = true
          renameSync(absolute, `${absolute}.original`)
          writeFileSync(absolute, originalBytes)
        },
      })).rejects.toThrow(/changed|identity|link|reparse|TOCTOU/i)
      expect(swapped, `${testCase.label} hook was not reached`).toBe(true)
    }
  })

  it('rejects a data directory replaced by an external junction after an event descriptor opens', async () => {
    const root = tempRoot('semantic-dynamic-data-link')
    const externalData = tempRoot('semantic-dynamic-external')
    await contract.writeV038Fixture(root)
    const dataRoot = join(root, 'data')
    copyTree(dataRoot, externalData)
    let swapped = false

    await expect(contract.projectUpgradeSemantics(root, {
      afterFileOpen: async ({ relativePath }: { relativePath: string }) => {
        if (!relativePath.startsWith('data/events-') || swapped) return
        swapped = true
        renameSync(dataRoot, join(root, 'data.original'))
        symlinkSync(externalData, dataRoot, process.platform === 'win32' ? 'junction' : 'dir')
      },
    })).rejects.toThrow(/data|changed|identity|link|reparse|TOCTOU/i)
    expect(swapped).toBe(true)
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
    expect(migrated.babyInfoJournal.records).toEqual(baseline.babyInfoJournal.expectedRecords)
    expect(migrated.babyInfoJournal.importSourceIds).toEqual([
      baseline.babyInfoJournal.expectedImportSourceId,
    ])
  })

  it('rejects duplicate/wrong-family journal evidence and more than one derivative per event source', async () => {
    const baselineRoot = tempRoot('strict-journal')
    await contract.writeV038Fixture(baselineRoot)
    await contract.materializeMigratedBabyInfoJournal(baselineRoot)
    const journalPath = join(baselineRoot, 'baby-info-journal-v1.jsonl')
    const records = readFileSync(journalPath, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
    const acknowledgement = records.find(record => record.type === 'ack')
    const imported = records.find(record => record.type === 'import')

    const duplicateAckRoot = cloneRoot(baselineRoot, 'duplicate-ack')
    appendFileSync(join(duplicateAckRoot, 'baby-info-journal-v1.jsonl'), `${JSON.stringify(acknowledgement)}\n`)
    await expect(contract.projectUpgradeSemantics(duplicateAckRoot)).rejects.toThrow(/duplicate acknowledgement/i)

    const wrongFamilyRoot = cloneRoot(baselineRoot, 'wrong-family-ack')
    appendFileSync(join(wrongFamilyRoot, 'baby-info-journal-v1.jsonl'), `${JSON.stringify({
      ...acknowledgement,
      familyId: 'wrong-family',
    })}\n`)
    await expect(contract.projectUpgradeSemantics(wrongFamilyRoot)).rejects.toThrow(/family mismatch/i)

    const duplicateImportRoot = cloneRoot(baselineRoot, 'duplicate-import')
    appendFileSync(join(duplicateImportRoot, 'baby-info-journal-v1.jsonl'), `${JSON.stringify(imported)}\n`)
    await expect(contract.projectUpgradeSemantics(duplicateImportRoot)).rejects.toThrow(/duplicate import/i)

    const derivativeRoot = cloneRoot(baselineRoot, 'same-source-derivative')
    const first = contract.buildFixtureEventDerivative()
    const second = contract.buildFixtureEventDerivative({
      mutationId: '33333333-3333-4333-8333-333333333333',
    })
    appendFileSync(
      join(derivativeRoot, 'data', 'events-2026-07.jsonl'),
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
    )
    await expect(contract.projectUpgradeSemantics(derivativeRoot)).rejects.toThrow(/multiple.*source|source.*derivative/i)
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

  it('preserves unknown/deep settings and exact non-auth auxiliary files', async () => {
    const baselineRoot = tempRoot('opaque-before')
    await contract.writeV038Fixture(baselineRoot)
    const baseline = await contract.projectUpgradeSemantics(baselineRoot)
    expect(baseline.auxiliaryFiles.map((item: any) => item.path)).toEqual([
      'auxiliary/legacy-attachment.bin',
    ])

    const migratedRoot = cloneRoot(baselineRoot, 'opaque-after')
    await contract.materializeMigratedBabyInfoJournal(migratedRoot)
    const migrated = await contract.projectUpgradeSemantics(migratedRoot)
    expect(() => contract.assertSemanticPreservation(baseline, migrated)).not.toThrow()
    expect(migrated.settingsOpaqueHash).toBe(baseline.settingsOpaqueHash)
    expect(migrated.auxiliaryFiles).toEqual(baseline.auxiliaryFiles)

    const auxiliaryRoot = cloneRoot(migratedRoot, 'auxiliary-substitution')
    const settingsPath = join(migratedRoot, 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    settings.upgradeOpaque.deep.nested.ja = '置換'
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    const substituted = await contract.projectUpgradeSemantics(migratedRoot)
    expect(() => contract.assertSemanticPreservation(baseline, substituted)).toThrow(/unknown|settings|opaque/i)

    writeFileSync(join(auxiliaryRoot, 'auxiliary', 'legacy-attachment.bin'), 'substituted')
    const auxiliaryChanged = await contract.projectUpgradeSemantics(auxiliaryRoot)
    expect(() => contract.assertSemanticPreservation(baseline, auxiliaryChanged)).toThrow(/auxiliary|auth/i)
  })

  it('normalizes reordered domain values but retains byte-order-sensitive import provenance', async () => {
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
    expect(reorderedProjection.eventSources).toEqual(beforeProjection.eventSources)
    expect(reorderedProjection.babyInfo).toEqual(beforeProjection.babyInfo)
    expect(reorderedProjection.babyInfoJournal.expectedImportSourceId)
      .not.toBe(beforeProjection.babyInfoJournal.expectedImportSourceId)
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
    await expect(contract.projectUpgradeSemantics(changedRoot)).rejects.toThrow(/multiple.*source|source.*derivative/i)
  })
})
