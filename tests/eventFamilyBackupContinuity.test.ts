import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { EventFamilyOwnership } from '../electron/store/eventFamilyOwnership'
import { EventLog } from '../electron/store/eventLog'
import { FamilyScopedEventLog } from '../electron/store/familyScopedEventLog'
import type { DiaryEvent } from '../shared/types'

const roots: string[] = []

function root(prefix: string): string {
  const result = mkdtempSync(join(tmpdir(), prefix))
  roots.push(result)
  return result
}

function event(id: string, minute: number): DiaryEvent {
  const at = `2026-07-15T05:${String(minute).padStart(2, '0')}:00.000Z`
  return {
    id,
    mutationId: uuidv4(),
    type: 'formula',
    at,
    data: { ml: 60 },
    author: { uid: 'parent', name: 'Parent', role: 'dad' },
    createdAt: at,
    updatedAt: at,
    rev: Date.parse(at),
    deleted: false,
  }
}

function scoped(dataDir: string): FamilyScopedEventLog {
  return new FamilyScopedEventLog(
    new EventLog({ dataDir }),
    new EventFamilyOwnership({ dataDir }),
  )
}

afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('event-family sidecar backup continuity', () => {
  it('fails closed if a cross-file snapshot contains a newer event than its sidecar', () => {
    const dataDir = root('baby-diary-event-family-torn-snapshot-')
    const first = scoped(dataDir)
    const eventA = event('event-A', 2)
    const eventB = event('event-B-unbound-in-snapshot', 3)
    expect(first.append(eventA, 'family-A', 'family-A')).toBe('ok')
    const olderSidecar = readFileSync(join(dataDir, 'event-family-ownership-v1.jsonl'))
    expect(first.append(eventB, 'family-B', 'family-B')).toBe('ok')

    // Models backup interleaving: sidecar was read before B's bind, event file
    // after B's append. B remains recoverable but cannot render or upload.
    writeFileSync(join(dataDir, 'event-family-ownership-v1.jsonl'), olderSidecar)
    const restarted = scoped(dataDir)
    expect(restarted.listVisible('family-A')).toEqual([eventA])
    expect(restarted.listVisible('family-B')).toEqual([])
    expect(restarted.allPhysicalMutations()).toEqual(expect.arrayContaining([eventA, eventB]))
    expect(new EventLog({ dataDir }).loadAll()).toHaveLength(2)
  })
})
