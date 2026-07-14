import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { EventLog } from '../electron/store/eventLog'
import {
  canonicalEventJson,
  deriveAuthBoundEvent,
} from '../shared/eventResolver'
import type { DiaryEvent } from '../shared/types'
import {
  buildV038Fixture,
  canonicalJson,
  writeV038Fixture,
} from '../scripts/upgrade-data-contract.mjs'
import {
  INCIDENT_V038_FIXTURE_REPAIR_TOKEN,
  runIncidentV038FixtureRepair,
} from '../scripts/incident-v038-fixture-repair.mjs'

const tempRoots: string[] = []

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function nonceProfile(): { root: string; profile: string; quarantine: string } {
  const root = mkdtempSync(join(tmpdir(), 'baby-diary-v038-repair-test-'))
  tempRoots.push(root)
  const profile = join(root, `profile-${uuidv4()}`)
  const quarantine = join(root, `quarantine-${uuidv4()}`)
  mkdirSync(profile)
  return { root, profile, quarantine }
}

function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>()
  function walk(directory: string, relative = ''): void {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name)
      const childRelative = relative ? `${relative}/${name}` : name
      const stats = statSync(absolute)
      if (stats.isDirectory()) {
        snapshot.set(`${childRelative}/`, 'directory')
        walk(absolute, childRelative)
      } else {
        snapshot.set(childRelative, sha256(readFileSync(absolute)))
      }
    }
  }
  walk(root)
  return snapshot
}

function normalEvent(at: string, overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  return {
    id: uuidv4(),
    mutationId: uuidv4(),
    type: 'formula',
    at,
    data: { ml: 55, note: 'genuine-record' },
    author: { uid: 'nonce-account', name: 'Parent', role: 'dad' },
    createdAt: at,
    updatedAt: at,
    rev: Date.parse(at),
    deleted: false,
    ...overrides,
  }
}

function eventLog(profile: string): EventLog {
  return new EventLog({ dataDir: join(profile, 'data') })
}

function fixtureLogicalIds(): string[] {
  return [...new Set((buildV038Fixture().events as DiaryEvent[]).map(event => event.id))].sort()
}

function fixtureLiveLogicalIds(): string[] {
  const winners = new Map<string, DiaryEvent>()
  const logRoot = nonceProfile()
  try {
    mkdirSync(join(logRoot.profile, 'data'))
    const log = eventLog(logRoot.profile)
    for (const event of buildV038Fixture().events as DiaryEvent[]) expect(log.append(event)).toBe('ok')
    for (const event of log.loadAll()) winners.set(event.id, event)
    return [...winners.values()].filter(event => !event.deleted).map(event => event.id).sort()
  } finally {
    rmSync(logRoot.root, { recursive: true, force: true })
    tempRoots.splice(tempRoots.indexOf(logRoot.root), 1)
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('exact v0.3.8 fixture incident repair', () => {
  it('defaults to a read-only audit and recognizes raw plus arbitrary auth-bound fixture variants', async () => {
    const { profile, quarantine } = nonceProfile()
    await writeV038Fixture(profile)
    const log = eventLog(profile)
    log.loadAll()
    const fixtures = buildV038Fixture().events as DiaryEvent[]
    for (const fixture of fixtures) {
      expect(log.append(deriveAuthBoundEvent(fixture, `nonce-writer-${uuidv4()}`))).toBe('ok')
    }
    const before = snapshotTree(profile)

    const result = await runIncidentV038FixtureRepair({ profilePath: profile })

    expect(result.mode).toBe('audit')
    expect(result.matchedMutationCount).toBe(fixtures.length * 2)
    expect(result.fixtureLogicalIdCount).toBe(fixtureLogicalIds().length)
    expect(result.appendedTombstoneCount).toBe(0)
    expect(snapshotTree(profile)).toEqual(before)
    expect(existsSync(quarantine)).toBe(false)
    expect(JSON.stringify(result)).not.toContain('nonce-writer')
    expect(JSON.stringify(result)).not.toContain(basename(profile))
  })

  it('refuses missing or incorrect authorization before creating evidence or changing a byte', async () => {
    const { profile, quarantine } = nonceProfile()
    await writeV038Fixture(profile)
    const before = snapshotTree(profile)

    await expect(runIncidentV038FixtureRepair({
      profilePath: profile,
      quarantinePath: quarantine,
      apply: true,
    })).rejects.toThrow(/authorization/i)
    await expect(runIncidentV038FixtureRepair({
      profilePath: profile,
      quarantinePath: quarantine,
      apply: true,
      authorizationToken: 'RESTORE_BABY_DIARY_WRONG',
    })).rejects.toThrow(/authorization/i)

    expect(snapshotTree(profile)).toEqual(before)
    expect(existsSync(quarantine)).toBe(false)
  })

  it('rejects relative, root, and overlapping paths without writes', async () => {
    const { profile } = nonceProfile()
    await writeV038Fixture(profile)
    const before = snapshotTree(profile)

    await expect(runIncidentV038FixtureRepair({ profilePath: '.' })).rejects.toThrow(/absolute/i)
    await expect(runIncidentV038FixtureRepair({ profilePath: parse(profile).root })).rejects.toThrow(/unsafe/i)
    await expect(runIncidentV038FixtureRepair({
      profilePath: profile,
      quarantinePath: join(profile, 'forensics'),
      apply: true,
      authorizationToken: INCIDENT_V038_FIXTURE_REPAIR_TOKEN,
    })).rejects.toThrow(/overlap/i)

    expect(snapshotTree(profile)).toEqual(before)
    expect(existsSync(join(profile, 'forensics'))).toBe(false)
  })

  it('appends only exact live fixture tombstones and preserves genuine before/after records byte-for-byte', async () => {
    const { profile, quarantine } = nonceProfile()
    await writeV038Fixture(profile)
    const beforeRecord = normalEvent('2026-06-01T00:00:00.000Z')
    const afterRecord = normalEvent('2026-08-01T00:00:00.000Z')
    const sameDayNearMiss = normalEvent('2026-07-01T04:00:00.000Z', {
      data: { ml: 80, note: 'real feeding' },
    })
    const log = eventLog(profile)
    log.loadAll()
    for (const event of [beforeRecord, afterRecord, sameDayNearMiss]) expect(log.append(event)).toBe('ok')
    const fixtureTemp = (buildV038Fixture().events as DiaryEvent[])
      .find(event => event.id === 'legacy-temp')!
    expect(log.append(deriveAuthBoundEvent(fixtureTemp, 'nonce-current-account'))).toBe('ok')

    const originalFiles = new Map<string, Buffer>()
    for (const name of readdirSync(join(profile, 'data')).sort()) {
      originalFiles.set(name, readFileSync(join(profile, 'data', name)))
    }
    const expectedNormalCanonical = [beforeRecord, afterRecord, sameDayNearMiss]
      .map(canonicalEventJson)
      .sort()

    const result = await runIncidentV038FixtureRepair({
      profilePath: profile,
      quarantinePath: quarantine,
      apply: true,
      authorizationToken: INCIDENT_V038_FIXTURE_REPAIR_TOKEN,
    })

    expect(result.mode).toBe('apply')
    expect(result.appendedTombstoneCount).toBe(fixtureLiveLogicalIds().length)
    expect(result.alreadyDeletedFixtureCount).toBe(1)
    const reloaded = eventLog(profile)
    const visible = reloaded.loadAll()
    for (const id of fixtureLogicalIds()) {
      expect(visible.find(event => event.id === id)?.deleted).toBe(true)
    }
    const retainedNormal = reloaded.getAllMutations()
      .filter(event => [beforeRecord.id, afterRecord.id, sameDayNearMiss.id].includes(event.id))
      .map(canonicalEventJson)
      .sort()
    expect(retainedNormal).toEqual(expectedNormalCanonical)
    for (const [name, beforeBytes] of originalFiles) {
      const afterBytes = readFileSync(join(profile, 'data', name))
      expect(afterBytes.subarray(0, beforeBytes.length)).toEqual(beforeBytes)
    }
    expect(readFileSync(join(profile, 'data', 'events-2026-08.jsonl')))
      .toEqual(originalFiles.get('events-2026-08.jsonl'))

    const manifestBytes = readFileSync(join(quarantine, 'manifest.json'))
    expect(readFileSync(join(quarantine, 'manifest.sha256'), 'utf8').trim()).toBe(sha256(manifestBytes))
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    expect(manifest.profileBindingSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(manifest)).not.toContain(basename(profile))
    for (const entry of manifest.files) {
      const copied = readFileSync(join(quarantine, 'files', ...entry.path.split('/')))
      expect(copied.length).toBe(entry.size)
      expect(sha256(copied)).toBe(entry.sha256)
      expect(copied).toEqual(originalFiles.get(basename(entry.path)))
    }
  })

  it('never date-matches near misses and leaves a genuine higher winner on a fixture logical id visible', async () => {
    const { profile, quarantine } = nonceProfile()
    await writeV038Fixture(profile)
    const fixtureTemp = (buildV038Fixture().events as DiaryEvent[])
      .find(event => event.id === 'legacy-temp')!
    const derivative = deriveAuthBoundEvent(fixtureTemp, 'nonce-current-account')
    const genuineWinner: DiaryEvent = {
      ...fixtureTemp,
      mutationId: uuidv4(),
      data: { celsius: 37.3, note: 'genuine measurement' },
      author: { uid: 'nonce-current-account', name: 'Parent', role: 'dad' },
      rev: derivative.rev + 1,
      updatedAt: '2026-07-01T02:01:00.000Z',
    }
    const sameTimestampDifferentId: DiaryEvent = {
      ...fixtureTemp,
      id: uuidv4(),
      mutationId: uuidv4(),
      author: { uid: 'nonce-current-account', name: 'Parent', role: 'dad' },
    }
    const log = eventLog(profile)
    log.loadAll()
    expect(log.append(derivative)).toBe('ok')
    expect(log.append(genuineWinner)).toBe('ok')
    expect(log.append(sameTimestampDifferentId)).toBe('ok')

    await runIncidentV038FixtureRepair({
      profilePath: profile,
      quarantinePath: quarantine,
      apply: true,
      authorizationToken: INCIDENT_V038_FIXTURE_REPAIR_TOKEN,
    })

    const visible = eventLog(profile).loadAll()
    expect(visible.find(event => event.id === genuineWinner.id)).toEqual(genuineWinner)
    expect(visible.find(event => event.id === sameTimestampDifferentId.id)).toEqual(sameTimestampDifferentId)
  })

  it('is byte-idempotent and appends no second tombstones on rerun', async () => {
    const { profile, quarantine } = nonceProfile()
    await writeV038Fixture(profile)
    const first = await runIncidentV038FixtureRepair({
      profilePath: profile,
      quarantinePath: quarantine,
      apply: true,
      authorizationToken: INCIDENT_V038_FIXTURE_REPAIR_TOKEN,
    })
    const afterFirstProfile = snapshotTree(profile)
    const afterFirstEvidence = snapshotTree(quarantine)

    const second = await runIncidentV038FixtureRepair({
      profilePath: profile,
      quarantinePath: quarantine,
      apply: true,
      authorizationToken: INCIDENT_V038_FIXTURE_REPAIR_TOKEN,
    })

    expect(first.appendedTombstoneCount).toBeGreaterThan(0)
    expect(second.appendedTombstoneCount).toBe(0)
    expect(second.alreadyRepairedFixtureCount).toBe(first.appendedTombstoneCount)
    expect(snapshotTree(profile)).toEqual(afterFirstProfile)
    expect(snapshotTree(quarantine)).toEqual(afterFirstEvidence)
  })

  it('publishes and verifies durable forensic evidence before any append, so a crashed apply is resumable', async () => {
    const { profile, quarantine } = nonceProfile()
    await writeV038Fixture(profile)
    const before = snapshotTree(profile)

    await expect(runIncidentV038FixtureRepair({
      profilePath: profile,
      quarantinePath: quarantine,
      apply: true,
      authorizationToken: INCIDENT_V038_FIXTURE_REPAIR_TOKEN,
    }, {
      afterForensicEvidenceDurable() {
        throw new Error('simulated-process-stop')
      },
    })).rejects.toThrow('simulated-process-stop')

    expect(snapshotTree(profile)).toEqual(before)
    expect(existsSync(join(quarantine, 'manifest.json'))).toBe(true)
    expect(existsSync(join(quarantine, 'manifest.sha256'))).toBe(true)
    const resumed = await runIncidentV038FixtureRepair({
      profilePath: profile,
      quarantinePath: quarantine,
      apply: true,
      authorizationToken: INCIDENT_V038_FIXTURE_REPAIR_TOKEN,
    })
    expect(resumed.appendedTombstoneCount).toBeGreaterThan(0)
    expect(eventLog(profile).loadAll().filter(event => event.id.startsWith('legacy-')))
      .toSatisfy((events: DiaryEvent[]) => events.every(event => event.deleted))
  })

  it('refuses to append if raw profile bytes change after forensic capture even when semantics are identical', async () => {
    const { profile, quarantine } = nonceProfile()
    await writeV038Fixture(profile)
    const target = join(profile, 'data', 'events-2026-07.jsonl')

    await expect(runIncidentV038FixtureRepair({
      profilePath: profile,
      quarantinePath: quarantine,
      apply: true,
      authorizationToken: INCIDENT_V038_FIXTURE_REPAIR_TOKEN,
    }, {
      afterForensicEvidenceDurable() {
        const reordered = readFileSync(target, 'utf8')
          .split('\n')
          .map(line => {
            if (!line) return line
            return JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(line)).reverse()))
          })
          .join('\n')
        writeFileSync(target, reordered)
      },
    })).rejects.toThrow(/changed after forensic capture/i)

    const visible = eventLog(profile).loadAll()
    expect(visible.some(event => event.id === 'legacy-temp' && !event.deleted)).toBe(true)
    expect(existsSync(join(quarantine, 'manifest.json'))).toBe(true)
  })

  it.each(['normal event', 'settings update'] as const)(
    'fails closed when %s is added after a crashed evidence-only apply',
    async change => {
      const { profile, quarantine } = nonceProfile()
      await writeV038Fixture(profile)
      await expect(runIncidentV038FixtureRepair({
        profilePath: profile,
        quarantinePath: quarantine,
        apply: true,
        authorizationToken: INCIDENT_V038_FIXTURE_REPAIR_TOKEN,
      }, {
        afterForensicEvidenceDurable() {
          throw new Error('simulated-process-stop')
        },
      })).rejects.toThrow('simulated-process-stop')

      if (change === 'normal event') {
        const log = eventLog(profile)
        log.loadAll()
        expect(log.append(normalEvent('2026-08-02T00:00:00.000Z'))).toBe('ok')
      } else {
        const settingsPath = join(profile, 'settings.json')
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
        settings.theme = settings.theme === 'dark' ? 'light' : 'dark'
        writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
      }
      const changedProfile = snapshotTree(profile)

      await expect(runIncidentV038FixtureRepair({
        profilePath: profile,
        quarantinePath: quarantine,
        apply: true,
        authorizationToken: INCIDENT_V038_FIXTURE_REPAIR_TOKEN,
      })).rejects.toThrow(/does not match.*forensic evidence/i)

      expect(snapshotTree(profile)).toEqual(changedProfile)
      expect(eventLog(profile).loadAll().some(event => event.id === 'legacy-temp' && !event.deleted)).toBe(true)
    },
  )

  it('returns only aggregate counts and cryptographic hashes', async () => {
    const { profile } = nonceProfile()
    await writeV038Fixture(profile)
    const result = await runIncidentV038FixtureRepair({ profilePath: profile })
    const json = JSON.stringify(result)

    expect(Object.keys(result).sort()).toEqual([
      'afterProjectionSha256',
      'alreadyDeletedFixtureCount',
      'alreadyRepairedFixtureCount',
      'appendedTombstoneCount',
      'beforeProjectionSha256',
      'evidenceManifestSha256',
      'fixtureLogicalIdCount',
      'matchedMutationCount',
      'mode',
      'unaffectedMutationCount',
    ])
    expect(json).not.toContain('legacy-')
    expect(json).not.toContain('37.2')
    expect(json).not.toContain(basename(profile))
    expect(canonicalJson(result)).toContain('beforeProjectionSha256')
  })
})
