import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, DataInfo, DiaryEvent } from '../shared/types'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

const harness = vi.hoisted(() => ({
  listEvents: vi.fn<() => Promise<DiaryEvent[]>>(),
  getSettings: vi.fn<() => Promise<AppSettings>>(),
  getDataInfo: vi.fn<() => Promise<DataInfo>>(),
  eventListeners: new Set<(event: DiaryEvent) => void>(),
  settingsListeners: new Set<(payload: { sequence: number; settings: AppSettings }) => void>(),
}))

vi.mock('../src/lib/ipc', () => ({
  ipc: {
    listEvents: () => harness.listEvents(),
    appendEvent: vi.fn(async () => 'ok'),
    getSettings: () => harness.getSettings(),
    getDataInfo: () => harness.getDataInfo(),
    saveSettings: vi.fn(async (settings: AppSettings) => settings),
    onEventAppended: vi.fn((callback: (event: DiaryEvent) => void) => {
      harness.eventListeners.add(callback)
      return () => harness.eventListeners.delete(callback)
    }),
    onSettingsChanged: vi.fn((callback: (payload: { sequence: number; settings: AppSettings }) => void) => {
      harness.settingsListeners.add(callback)
      return () => harness.settingsListeners.delete(callback)
    }),
  },
}))

vi.mock('../src/sync/syncEngine', () => ({
  enqueue: vi.fn(),
  persistSettingsWithBabyInfoMutation: vi.fn(),
}))

vi.mock('../src/i18n', () => ({
  default: { t: (key: string) => key, language: 'ko' },
  setLanguage: vi.fn(),
}))

const settings: AppSettings = {
  baby: { name: 'Baby', birthdate: '2026-01-01' },
  profile: { uid: 'parent-1', name: 'Parent', role: 'mom' },
  familyId: 'family-1',
  firebase: null,
}

const dataInfo: DataInfo = {
  dataDir: '',
  backupDir: '',
  documentsBackupDir: '',
  eventCount: 0,
  lastBackupTime: null,
}

function event(id: string, rev = 1, note = id): DiaryEvent {
  const timestamp = `2026-07-13T00:00:0${Math.min(rev, 9)}.000Z`
  return {
    id,
    mutationId: `50000000-0000-4000-8000-${rev.toString().padStart(12, '0')}`,
    type: 'pee',
    at: timestamp,
    data: { note },
    author: { uid: 'parent-1', name: 'Parent', role: 'mom' },
    createdAt: timestamp,
    updatedAt: timestamp,
    rev,
    deleted: false,
  }
}

function emitEvent(value: DiaryEvent): void {
  for (const listener of [...harness.eventListeners]) listener(value)
}

describe('lossless event store initialization', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    harness.eventListeners.clear()
    harness.settingsListeners.clear()
    harness.getSettings.mockResolvedValue(structuredClone(settings))
    harness.getDataInfo.mockResolvedValue(structuredClone(dataInfo))
  })

  it('subscribes before listEvents and keeps a broadcast received before the list result', async () => {
    const pendingList = deferred<DiaryEvent[]>()
    harness.listEvents.mockReturnValueOnce(pendingList.promise)
    const { useAppStore } = await import('../src/store/useAppStore')

    const init = useAppStore.getState().init()
    expect(harness.eventListeners.size).toBe(1)
    emitEvent(event('during-list'))
    pendingList.resolve([])
    await init

    expect(useAppStore.getState().events.map(item => item.id)).toEqual(['during-list'])
  })

  it('buffers a broadcast after list resolution but before the atomic init commit', async () => {
    const pendingInfo = deferred<DataInfo>()
    harness.listEvents.mockResolvedValueOnce([event('from-list')])
    harness.getDataInfo.mockReturnValueOnce(pendingInfo.promise)
    const { useAppStore } = await import('../src/store/useAppStore')

    const init = useAppStore.getState().init()
    await Promise.resolve()
    emitEvent(event('after-list'))
    pendingInfo.resolve(dataInfo)
    await init

    expect(new Set(useAppStore.getState().events.map(item => item.id))).toEqual(
      new Set(['from-list', 'after-list']),
    )
  })

  it('resolves a list/broadcast duplicate through the real immutable resolver', async () => {
    const pendingList = deferred<DiaryEvent[]>()
    const older = event('same', 1, 'old')
    const newer = event('same', 2, 'new')
    harness.listEvents.mockReturnValueOnce(pendingList.promise)
    const { useAppStore } = await import('../src/store/useAppStore')

    const init = useAppStore.getState().init()
    emitEvent(newer)
    pendingList.resolve([older, newer])
    await init

    expect(useAppStore.getState().events).toEqual([newer])
  })

  it('lets only the newest concurrent init commit and leaves exactly one listener', async () => {
    const firstList = deferred<DiaryEvent[]>()
    const secondList = deferred<DiaryEvent[]>()
    harness.listEvents.mockReturnValueOnce(firstList.promise).mockReturnValueOnce(secondList.promise)
    const { useAppStore } = await import('../src/store/useAppStore')

    const firstInit = useAppStore.getState().init()
    const secondInit = useAppStore.getState().init()
    expect(harness.eventListeners.size).toBe(1)

    secondList.resolve([event('new-init')])
    await secondInit
    firstList.resolve([event('stale-init')])
    await firstInit

    expect(useAppStore.getState().events.map(item => item.id)).toEqual(['new-init'])
    expect(harness.eventListeners.size).toBe(1)
  })

  it('dispose invalidates a captured late callback and unsubscribes it', async () => {
    harness.listEvents.mockResolvedValueOnce([])
    const {
      disposeAppStoreEventBridge,
      useAppStore,
    } = await import('../src/store/useAppStore')
    await useAppStore.getState().init()
    const lateCallback = [...harness.eventListeners][0]

    disposeAppStoreEventBridge()
    lateCallback(event('late'))

    expect(harness.eventListeners.size).toBe(0)
    expect(useAppStore.getState().events).toEqual([])
  })

  it('re-init unsubscribes the old callback so it cannot merge after replacement', async () => {
    harness.listEvents.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    const { useAppStore } = await import('../src/store/useAppStore')
    await useAppStore.getState().init()
    const oldCallback = [...harness.eventListeners][0]
    await useAppStore.getState().init()

    oldCallback(event('old-listener'))
    emitEvent(event('current-listener'))

    expect(useAppStore.getState().events.map(item => item.id)).toEqual(['current-listener'])
    expect(harness.eventListeners.size).toBe(1)
  })
})
