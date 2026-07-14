import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { EventLog } from '../electron/store/eventLog'
import { EventFamilyOwnership } from '../electron/store/eventFamilyOwnership'
import { FamilyScopedEventLog } from '../electron/store/familyScopedEventLog'
import type { DiaryEvent } from '../shared/types'
import { buildV038Fixture } from '../scripts/upgrade-data-contract.mjs'

const roots: string[] = []

function scope(): FamilyScopedEventLog {
  const dataDir = mkdtempSync(join(tmpdir(), 'baby-diary-family-scope-test-'))
  roots.push(dataDir)
  return new FamilyScopedEventLog(
    new EventLog({ dataDir }),
    new EventFamilyOwnership({ dataDir }),
  )
}

function event(id: string, minute: number, overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  const at = `2026-07-15T04:${String(minute).padStart(2, '0')}:00.000Z`
  return {
    id,
    mutationId: uuidv4(),
    type: 'formula',
    at,
    data: { ml: 50 },
    author: { uid: 'parent', name: 'Parent', role: 'dad' },
    createdAt: at,
    updatedAt: at,
    rev: Date.parse(at),
    deleted: false,
    ...overrides,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('family-scoped EventLog boundary', () => {
  it('keeps family A mutations out of family B reads and restores them when switching back', () => {
    const scoped = scope()
    const localA = event('local-a', 0)
    const remoteB = event('remote-b', 1)

    expect(scoped.append(localA, 'family-A', 'family-A')).toBe('ok')
    expect(scoped.listMutations('family-B')).toEqual([])
    expect(scoped.listVisible('family-B')).toEqual([])
    expect(scoped.append(remoteB, 'family-B', 'family-B')).toBe('ok')
    expect(scoped.listVisible('family-B')).toEqual([remoteB])
    expect(scoped.listVisible('family-A')).toEqual([localA])
  })

  it('rejects a stale append when the renderer expected a different current family', () => {
    const scoped = scope()
    const staleA = event('stale-a', 2)

    expect(scoped.append(staleA, 'family-B', 'family-A')).toBe('error')
    expect(scoped.allPhysicalMutations()).toEqual([])
  })

  it('hides unbound legacy records from a linked family until membership confirmation adopts them', () => {
    const scoped = scope()
    const legacy = event('legacy', 3, { mutationId: undefined })
    expect(scoped.append(legacy, '', '')).toBe('ok')

    expect(scoped.listVisible('family-A')).toEqual([])
    expect(scoped.confirmFamily('family-A', 'family-A')).toMatchObject({
      status: 'ok',
      adoptionFamilyId: 'family-A',
      adoptedCount: 1,
    })
    expect(scoped.listVisible('family-A')).toEqual([legacy])
  })

  it('does not adopt unbound legacy records when cloud family conflicts with the prior local family', () => {
    const scoped = scope()
    const legacy = event('legacy-from-family-a', 6, { mutationId: undefined })
    expect(scoped.append(legacy, '', '')).toBe('ok')

    expect(scoped.confirmFamily('family-B', 'family-B', false)).toEqual({
      status: 'ok',
      adoptedCount: 0,
    })
    expect(scoped.listVisible('family-B')).toEqual([])
  })

  it('returns every same-family physical mutation to normal reconciliation', () => {
    const scoped = scope()
    const source = event('same-family', 4)
    const edit = event('same-family', 5, { rev: source.rev + 1 })

    expect(scoped.append(source, 'family-A', 'family-A')).toBe('ok')
    expect(scoped.append(edit, 'family-A', 'family-A')).toBe('ok')
    expect(scoped.listMutations('family-A')).toEqual([source, edit])
  })

  it('rejects an exact v0.3.8 fixture even while unlinked', () => {
    const scoped = scope()
    const fixture = (buildV038Fixture().events as DiaryEvent[])[0]

    expect(scoped.append(fixture, '', '')).toBe('error')
    expect(scoped.allPhysicalMutations()).toEqual([])
  })
})
