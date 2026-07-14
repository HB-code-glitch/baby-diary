import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { EventLog } from '../electron/store/eventLog'
import { EventFamilyOwnership } from '../electron/store/eventFamilyOwnership'
import { getEventStorageKey } from '../shared/eventResolver'
import type { DiaryEvent } from '../shared/types'
import { buildV038Fixture } from '../scripts/upgrade-data-contract.mjs'
import type { DurableFileOps } from '../electron/store/durableFs'

const INITIALIZATION_MARKER_FILE = 'event-family-ownership-initialized-v1.jsonl'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'baby-diary-event-family-test-'))
  roots.push(root)
  return root
}

function event(id: string, at: string, overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  return {
    id,
    mutationId: uuidv4(),
    type: 'formula',
    at,
    data: { ml: 55 },
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

describe('durable event family ownership', () => {
  it('persists immutable mutation ownership and isolates family switches after restart', () => {
    const root = tempRoot()
    const familyAEvent = event('family-a-event', '2026-07-15T00:00:00.000Z')
    const familyBEvent = event('family-b-event', '2026-07-15T00:01:00.000Z')
    const first = new EventFamilyOwnership({ dataDir: root })

    expect(first.bind(familyAEvent, 'family-A')).toBe('ok')
    expect(first.bind(familyBEvent, 'family-B')).toBe('ok')

    const restarted = new EventFamilyOwnership({ dataDir: root })
    expect(restarted.filterMutations([familyAEvent, familyBEvent], 'family-A'))
      .toEqual([familyAEvent])
    expect(restarted.filterMutations([familyAEvent, familyBEvent], 'family-B'))
      .toEqual([familyBEvent])
    expect(restarted.bind(familyAEvent, 'family-B')).toBe('conflict')
  })

  it('adopts eligible unbound legacy events exactly once to the first confirmed family', () => {
    const root = tempRoot()
    const legacy = event('legacy-user-event', '2026-07-14T00:00:00.000Z', {
      mutationId: undefined,
    })
    const first = new EventFamilyOwnership({ dataDir: root })

    expect(first.confirmAndAdopt('family-A', [legacy])).toEqual({
      status: 'ok',
      adoptionFamilyId: 'family-A',
      adoptedCount: 1,
    })

    const restarted = new EventFamilyOwnership({ dataDir: root })
    expect(restarted.confirmAndAdopt('family-B', [legacy])).toEqual({
      status: 'different-family',
      adoptionFamilyId: 'family-A',
      adoptedCount: 0,
    })
    expect(restarted.filterMutations([legacy], 'family-A')).toEqual([legacy])
    expect(restarted.filterMutations([legacy], 'family-B')).toEqual([])
  })

  it('never adopts exact v0.3.8 synthetic fixture records', () => {
    const root = tempRoot()
    const fixture = (buildV038Fixture().events as DiaryEvent[])[0]
    const genuine = event('genuine-event', '2026-07-15T01:00:00.000Z', {
      mutationId: undefined,
    })
    const ownership = new EventFamilyOwnership({ dataDir: root })

    expect(ownership.confirmAndAdopt('family-A', [fixture, genuine]).adoptedCount).toBe(1)
    expect(ownership.familyOf(fixture)).toBeUndefined()
    expect(ownership.filterMutations([fixture, genuine], 'family-A')).toEqual([genuine])
  })

  it('fails closed on a torn sidecar without changing the append-only event log', () => {
    const root = tempRoot()
    const dataDir = join(root, 'data')
    const bound = event('bound', '2026-07-15T02:00:00.000Z')
    const ambiguous = event('ambiguous', '2026-07-15T02:01:00.000Z')
    const log = new EventLog({ dataDir })
    expect(log.append(bound)).toBe('ok')
    expect(log.append(ambiguous)).toBe('ok')
    const ownership = new EventFamilyOwnership({ dataDir })
    expect(ownership.bind(bound, 'family-A')).toBe('ok')

    const sidecar = ownership.filePath
    const beforeEventBytes = readFileSync(join(dataDir, 'events-2026-07.jsonl'))
    writeFileSync(sidecar, `${readFileSync(sidecar, 'utf8')}{\"version\":1,\"type\":\"bind\"`)

    const restarted = new EventFamilyOwnership({ dataDir })
    expect(restarted.integrity).toBe('uncertain')
    expect(restarted.filterMutations([bound, ambiguous], 'family-A')).toEqual([bound])
    expect(restarted.filterUnboundMutations([bound, ambiguous])).toEqual([])
    expect(restarted.bind(ambiguous, 'family-B')).toBe('error')
    expect(restarted.confirmAndAdopt('family-B', [ambiguous]).status).toBe('uncertain')
    expect(readFileSync(join(dataDir, 'events-2026-07.jsonl'))).toEqual(beforeEventBytes)
    expect(new EventLog({ dataDir }).loadAll()).toHaveLength(2)
  })

  it('stores bindings by exact immutable storage key rather than logical id', () => {
    const root = tempRoot()
    const original = event('same-logical-id', '2026-07-15T03:00:00.000Z')
    const edit = event('same-logical-id', '2026-07-15T03:01:00.000Z', { rev: original.rev + 1 })
    const ownership = new EventFamilyOwnership({ dataDir: root })

    expect(getEventStorageKey(original)).not.toBe(getEventStorageKey(edit))
    expect(ownership.bind(original, 'family-A')).toBe('ok')
    expect(ownership.familyOf(edit)).toBeUndefined()
  })

  it.each([
    ['missing', (sidecar: string) => unlinkSync(sidecar)],
    ['empty', (sidecar: string) => writeFileSync(sidecar, '')],
    ['invalid', (sidecar: string) => writeFileSync(sidecar, '{"version":1,"type":"bind"}\n')],
  ])('fails closed when the initialization marker remains but the sidecar is %s', (_name, damage) => {
    const root = tempRoot()
    const bound = event('bound-before-sidecar-loss', '2026-07-15T04:00:00.000Z')
    const candidate = event('must-not-rebind', '2026-07-15T04:01:00.000Z', { mutationId: undefined })
    const first = new EventFamilyOwnership({ dataDir: root })
    expect(first.bind(bound, 'family-A')).toBe('ok')
    expect(existsSync(join(root, INITIALIZATION_MARKER_FILE))).toBe(true)

    damage(first.filePath)
    const restarted = new EventFamilyOwnership({ dataDir: root })

    expect(restarted.integrity).toBe('uncertain')
    expect(restarted.bind(candidate, 'family-B')).toBe('error')
    expect(restarted.confirmAndAdopt('family-B', [candidate])).toMatchObject({
      status: 'uncertain',
      adoptedCount: 0,
    })
  })

  it('exposes no binding and blocks every new bind when the sidecar exists without its marker', () => {
    const root = tempRoot()
    const bound = event('bound-before-marker-loss', '2026-07-15T04:02:00.000Z')
    const candidate = event('new-after-marker-loss', '2026-07-15T04:03:00.000Z')
    const first = new EventFamilyOwnership({ dataDir: root })
    expect(first.bind(bound, 'family-A')).toBe('ok')
    unlinkSync(join(root, INITIALIZATION_MARKER_FILE))

    const restarted = new EventFamilyOwnership({ dataDir: root })
    expect(restarted.integrity).toBe('uncertain')
    expect(restarted.familyOf(bound)).toBeUndefined()
    expect(restarted.bind(candidate, 'family-A')).toBe('error')
  })

  it('rejects a marker unless its nonempty bytes have the exact canonical schema', () => {
    const root = tempRoot()
    const bound = event('bound-before-marker-corruption', '2026-07-15T04:04:00.000Z')
    const first = new EventFamilyOwnership({ dataDir: root })
    expect(first.bind(bound, 'family-A')).toBe('ok')
    writeFileSync(
      join(root, INITIALIZATION_MARKER_FILE),
      '{"version":1,"type":"event-family-ownership-initialized","extra":true}\n',
    )

    const restarted = new EventFamilyOwnership({ dataDir: root })
    expect(restarted.integrity).toBe('uncertain')
    expect(restarted.familyOf(bound)).toBeUndefined()
  })

  it('detects a newline-aligned valid-prefix truncation through the durable sidecar checkpoint', () => {
    const root = tempRoot()
    const firstEvent = event('checkpoint-first', '2026-07-15T04:04:10.000Z')
    const removedEvent = event('checkpoint-removed', '2026-07-15T04:04:20.000Z')
    const first = new EventFamilyOwnership({ dataDir: root })
    expect(first.bind(firstEvent, 'family-A')).toBe('ok')
    const validPrefix = readFileSync(first.filePath, 'utf8')
    expect(first.bind(removedEvent, 'family-B')).toBe('ok')

    writeFileSync(first.filePath, validPrefix)
    const restarted = new EventFamilyOwnership({ dataDir: root })

    expect(restarted.integrity).toBe('uncertain')
    expect(restarted.familyOf(firstEvent)).toBe('family-A')
    expect(restarted.familyOf(removedEvent)).toBeUndefined()
    expect(restarted.filterUnboundMutations([removedEvent])).toEqual([])
    expect(restarted.confirmAndAdopt('family-A', [removedEvent]).status).toBe('uncertain')
  })

  it('detects a same-length valid ownership rewrite through the cumulative hash chain', () => {
    const root = tempRoot()
    const bound = event('same-length-rewrite', '2026-07-15T04:04:30.000Z')
    const candidate = event('blocked-after-rewrite', '2026-07-15T04:04:40.000Z')
    const first = new EventFamilyOwnership({ dataDir: root })
    expect(first.bind(bound, 'family-A')).toBe('ok')
    const original = readFileSync(first.filePath, 'utf8')
    const rewritten = original.replace('family-A', 'family-B')
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original))
    writeFileSync(first.filePath, rewritten)

    const restarted = new EventFamilyOwnership({ dataDir: root })
    expect(restarted.integrity).toBe('uncertain')
    expect(restarted.familyOf(bound)).toBeUndefined()
    expect(restarted.bind(candidate, 'family-B')).toBe('error')
    expect(restarted.confirmAndAdopt('family-B', [candidate]).status).toBe('uncertain')
  })

  it('fsyncs the initialization marker before opening the first ownership sidecar', () => {
    const root = tempRoot()
    const actions: string[] = []
    const fdNames = new Map<number, string>()
    const ops = Object.create(fs) as DurableFileOps
    ops.openSync = (target, flags, mode) => {
      const fd = fs.openSync(target, flags, mode)
      const name = String(target)
      fdNames.set(fd, name)
      actions.push(`open:${name}`)
      return fd
    }
    ops.fsyncSync = fd => {
      actions.push(`fsync:${fdNames.get(fd) ?? fd}`)
      fs.fsyncSync(fd)
    }
    ops.closeSync = fd => {
      fs.closeSync(fd)
      fdNames.delete(fd)
    }
    const ownership = new EventFamilyOwnership({ dataDir: root, fileOps: ops, platform: 'linux' })

    expect(ownership.bind(event('ordered-bind', '2026-07-15T04:05:00.000Z'), 'family-A')).toBe('ok')

    const markerFsync = actions.findIndex(action => action.startsWith(`fsync:${join(root, INITIALIZATION_MARKER_FILE)}`))
    const sidecarOpen = actions.findIndex(action => action.startsWith(`open:${ownership.filePath}`))
    expect(markerFsync).toBeGreaterThanOrEqual(0)
    expect(sidecarOpen).toBeGreaterThan(markerFsync)
  })

  it('never opens the ownership sidecar when initialization marker durability fails', () => {
    const root = tempRoot()
    const marker = join(root, INITIALIZATION_MARKER_FILE)
    const opened: string[] = []
    const fdNames = new Map<number, string>()
    let failMarkerSync = true
    const ops = Object.create(fs) as DurableFileOps
    ops.openSync = (target, flags, mode) => {
      const fd = fs.openSync(target, flags, mode)
      const name = String(target)
      fdNames.set(fd, name)
      opened.push(name)
      return fd
    }
    ops.fsyncSync = fd => {
      if (fdNames.get(fd) === marker && failMarkerSync) {
        failMarkerSync = false
        throw new Error('simulated marker fsync failure')
      }
      fs.fsyncSync(fd)
    }
    ops.closeSync = fd => {
      fs.closeSync(fd)
      fdNames.delete(fd)
    }
    const ownership = new EventFamilyOwnership({ dataDir: root, fileOps: ops, platform: 'linux' })

    expect(ownership.bind(event('blocked-bind', '2026-07-15T04:06:00.000Z'), 'family-A')).toBe('error')
    expect(opened).not.toContain(ownership.filePath)
    expect(ownership.integrity).toBe('uncertain')
  })
})
