/**
 * tests/softDeleteAllEvents.test.ts
 * useAppStore.softDeleteAllEvents() 단위 테스트
 *
 * 검증 항목:
 * - 비삭제 이벤트 전부에 tombstone rev 생성
 * - 이미 삭제된 이벤트는 건너뜀
 * - 반환 count = 실제 삭제 처리한 개수
 * - ipc.appendEvent가 'error'를 반환하면 즉시 중단, 부분 count 반환
 * - tombstone은 enqueue (sync) 호출됨
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DiaryEvent } from '../shared/types'
import { v4 as uuidv4 } from 'uuid'

// ── Mocks must be declared before dynamic imports ──

const mockAppendEvent = vi.fn()
const mockEnqueue = vi.fn()

vi.mock('../src/lib/ipc', () => ({
  ipc: {
    listEvents:       vi.fn(async () => []),
    appendEvent:      (...args: unknown[]) => mockAppendEvent(...args),
    getSettings:      vi.fn(async () => ({
      baby: { name: '', birthdate: '' },
      profile: { uid: 'test', name: '', role: 'mom' as const },
      familyId: '',
      firebase: null,
    })),
    saveSettings:     vi.fn(async () => {}),
    exportData:       vi.fn(async () => {}),
    openBackupFolder: vi.fn(async () => {}),
    getDataInfo:      vi.fn(async () => ({ dataDir: '', backupDir: '', documentsBackupDir: '', eventCount: 0, lastBackupTime: null })),
    onEventAppended:  vi.fn(() => () => {}),
  },
}))

vi.mock('../src/sync/syncEngine', () => ({
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
  makeDocId: (e: DiaryEvent) => `${e.id}_${e.rev}`,
  parseDocId: (s: string) => {
    const idx = s.lastIndexOf('_')
    return { id: s.slice(0, idx), rev: Number(s.slice(idx + 1)) }
  },
}))

// i18n mock
vi.mock('../src/i18n', () => ({
  default: { t: (k: string) => k, language: 'ko' },
  setLanguage: vi.fn(),
}))

// ── Helpers ──

function makeEvent(overrides: Partial<DiaryEvent> = {}): DiaryEvent {
  const t = new Date().toISOString()
  return {
    id: uuidv4(),
    type: 'pee',
    at: t,
    data: {},
    author: { uid: 'test', name: '아빠', role: 'dad' },
    createdAt: t,
    updatedAt: t,
    rev: 1,
    deleted: false,
    ...overrides,
  }
}

// ── Tests ──

describe('softDeleteAllEvents', () => {
  beforeEach(() => {
    mockAppendEvent.mockReset()
    mockEnqueue.mockReset()
    mockAppendEvent.mockResolvedValue('ok')
  })

  it('비삭제 이벤트 전부를 tombstone 처리하고 { count, partial } 를 반환한다', async () => {
    const { useAppStore } = await import('../src/store/useAppStore')

    const events: DiaryEvent[] = [
      makeEvent({ id: 'e1', rev: 1 }),
      makeEvent({ id: 'e2', rev: 2 }),
      makeEvent({ id: 'e3', rev: 1 }),
    ]

    // Pre-seed store state directly
    useAppStore.setState({ events })

    const result = await useAppStore.getState().softDeleteAllEvents()

    // MF-12: now returns { count, partial }
    expect(result.count).toBe(3)
    expect(result.partial).toBe(false)
    // ipc.appendEvent called once per event with deleted: true and rev bumped
    expect(mockAppendEvent).toHaveBeenCalledTimes(3)
    const calls = mockAppendEvent.mock.calls
    expect(calls[0][0]).toMatchObject({ id: 'e1', deleted: true })
    expect(calls[1][0]).toMatchObject({ id: 'e2', deleted: true })
    expect(calls[2][0]).toMatchObject({ id: 'e3', deleted: true })
    for (const [persisted] of calls as Array<[DiaryEvent]>) {
      expect(persisted.rev).toBe(Date.parse(persisted.updatedAt))
      expect(persisted.sync?.updatedAtMs).toBe(Date.parse(persisted.updatedAt))
    }
    // enqueue called for each tombstone
    expect(mockEnqueue).toHaveBeenCalledTimes(3)
  })

  it('이미 삭제된 이벤트(deleted: true)는 건너뛴다', async () => {
    const { useAppStore } = await import('../src/store/useAppStore')

    const events: DiaryEvent[] = [
      makeEvent({ id: 'alive', rev: 1, deleted: false }),
      makeEvent({ id: 'dead1', rev: 2, deleted: true }),
      makeEvent({ id: 'dead2', rev: 3, deleted: true }),
    ]

    useAppStore.setState({ events })

    const result = await useAppStore.getState().softDeleteAllEvents()

    expect(result.count).toBe(1)
    expect(result.partial).toBe(false)
    expect(mockAppendEvent).toHaveBeenCalledTimes(1)
    expect(mockAppendEvent.mock.calls[0][0]).toMatchObject({ id: 'alive', deleted: true })
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })

  it('이벤트가 없으면 { count: 0, partial: false } 를 반환한다', async () => {
    const { useAppStore } = await import('../src/store/useAppStore')

    useAppStore.setState({ events: [] })

    const result = await useAppStore.getState().softDeleteAllEvents()

    expect(result.count).toBe(0)
    expect(result.partial).toBe(false)
    expect(mockAppendEvent).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('MF-12: ipc.appendEvent가 error를 반환하면 즉시 중단하고 { count, partial: true } 를 반환한다', async () => {
    const { useAppStore } = await import('../src/store/useAppStore')

    const events: DiaryEvent[] = [
      makeEvent({ id: 'a1', rev: 1 }),
      makeEvent({ id: 'a2', rev: 1 }),
      makeEvent({ id: 'a3', rev: 1 }),
    ]

    useAppStore.setState({ events })

    // First call ok, second call errors → abort
    mockAppendEvent
      .mockResolvedValueOnce('ok')
      .mockResolvedValueOnce('error')
      .mockResolvedValueOnce('ok') // should never be reached

    const result = await useAppStore.getState().softDeleteAllEvents()

    // MF-12: partial=true signals caller to show partial toast (not success)
    expect(result.count).toBe(1)
    expect(result.partial).toBe(true)
    expect(mockAppendEvent).toHaveBeenCalledTimes(2)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })

  it('tombstone の rev は元の rev + 1 である', async () => {
    const { useAppStore } = await import('../src/store/useAppStore')

    const event = makeEvent({ id: 'rev-check', rev: 5 })
    useAppStore.setState({ events: [event] })

    await useAppStore.getState().softDeleteAllEvents()

    const tombstone = mockAppendEvent.mock.calls[0][0] as DiaryEvent
    expect(tombstone.rev).toBe(Date.parse(tombstone.updatedAt))
    expect(tombstone.rev).toBeGreaterThan(event.rev)
    expect(tombstone.sync?.updatedAtMs).toBe(Date.parse(tombstone.updatedAt))
    expect(tombstone.deleted).toBe(true)
    // enqueue receives the same tombstone object
    const enqueued = mockEnqueue.mock.calls[0][0] as DiaryEvent
    expect(enqueued.rev).toBe(tombstone.rev)
    expect(enqueued.deleted).toBe(true)
  })

  it('creates one immutable mutation identity and enqueues the exact persisted tombstone', async () => {
    const { useAppStore } = await import('../src/store/useAppStore')
    const event = makeEvent({
      id: 'mutation-check',
      mutationId: '11111111-1111-4111-8111-111111111111',
      migration: {
        version: 1,
        kind: 'legacy-author-v1',
        sourceContentId: '22222222-2222-5222-8222-222222222222',
      },
    })
    useAppStore.setState({ events: [event] })

    await useAppStore.getState().softDeleteAllEvents()

    const persisted = mockAppendEvent.mock.calls[0][0] as DiaryEvent
    const enqueued = mockEnqueue.mock.calls[0][0] as DiaryEvent
    expect(persisted.mutationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(persisted.mutationId).not.toBe(event.mutationId)
    expect(persisted.migration).toBeUndefined()
    expect(enqueued).toBe(persisted)
  })

  it('assigns a mutation identity to every newly added event path', async () => {
    const { useAppStore } = await import('../src/store/useAppStore')
    const legacyShapedNewEvent = makeEvent({ mutationId: undefined })

    const added = await useAppStore.getState().addEvent(legacyShapedNewEvent)

    expect(added.mutationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(added.rev).toBe(Date.parse(added.updatedAt))
    expect(added.sync?.updatedAtMs).toBe(Date.parse(added.updatedAt))
    expect(mockAppendEvent.mock.calls[0][0]).toBe(added)
    expect(mockEnqueue.mock.calls[0][0]).toBe(added)
  })

  it('gives every edit a fresh mutation identity', async () => {
    const { useAppStore } = await import('../src/store/useAppStore')
    const original = makeEvent({ mutationId: '11111111-1111-4111-8111-111111111111' })
    useAppStore.setState({ events: [original] })

    const edited = await useAppStore.getState().editEvent(original, { at: '2026-07-13T09:00:00.000Z' })

    expect(edited.rev).toBe(Date.parse(edited.updatedAt))
    expect(edited.rev).toBeGreaterThan(original.rev)
    expect(edited.sync?.updatedAtMs).toBe(Date.parse(edited.updatedAt))
    expect(edited.mutationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(edited.mutationId).not.toBe(original.mutationId)
    expect(mockAppendEvent.mock.calls[0][0]).toBe(edited)
    expect(mockEnqueue.mock.calls[0][0]).toBe(edited)
  })

  it('starts an edited derivative as a fresh local source without rebinding provenance', async () => {
    const { useAppStore } = await import('../src/store/useAppStore')
    const original = makeEvent({
      mutationId: '11111111-1111-5111-8111-111111111111',
      migration: {
        version: 1,
        kind: 'legacy-author-v1',
        sourceContentId: '22222222-2222-5222-8222-222222222222',
      },
    })
    useAppStore.setState({ events: [original] })

    const edited = await useAppStore.getState().editEvent(original, { at: '2026-07-13T09:00:00.000Z' })

    expect(edited.migration).toBeUndefined()
    expect(original.migration).toBeDefined()
    expect(mockAppendEvent.mock.calls[0][0]).toBe(edited)
    expect(mockEnqueue.mock.calls[0][0]).toBe(edited)
  })
})
