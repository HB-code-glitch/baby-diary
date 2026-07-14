import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, DataInfo, DiaryEvent } from '../shared/types'
import * as upgradeContract from '../scripts/upgrade-data-contract.mjs'
import { deriveAuthBoundEvent } from '../shared/eventResolver'

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
  listEvents: vi.fn<(expectedFamilyId?: string) => Promise<DiaryEvent[]>>(),
  appendEvent: vi.fn<(_event: DiaryEvent, _expectedFamilyId?: string) => Promise<'ok' | 'duplicate' | 'error'>>(),
  enqueue: vi.fn(),
  getSettings: vi.fn<() => Promise<AppSettings>>(),
  getDataInfo: vi.fn<() => Promise<DataInfo>>(),
  eventListeners: new Set<(event: DiaryEvent, familyId: string) => void>(),
  settingsListeners: new Set<(payload: { sequence: number; settings: AppSettings }) => void>(),
}))

vi.mock('../src/lib/ipc', () => ({
  ipc: {
    listEvents: (expectedFamilyId?: string) => harness.listEvents(expectedFamilyId),
    appendEvent: (value: DiaryEvent, expectedFamilyId?: string) => harness.appendEvent(value, expectedFamilyId),
    getSettings: () => harness.getSettings(),
    getDataInfo: () => harness.getDataInfo(),
    saveSettings: vi.fn(async (settings: AppSettings) => settings),
    onEventAppended: vi.fn((callback: (event: DiaryEvent, familyId: string) => void) => {
      harness.eventListeners.add(callback)
      return () => harness.eventListeners.delete(callback)
    }),
    onEventScopeChanged: vi.fn(() => () => undefined),
    onSettingsChanged: vi.fn((callback: (payload: { sequence: number; settings: AppSettings }) => void) => {
      harness.settingsListeners.add(callback)
      return () => harness.settingsListeners.delete(callback)
    }),
  },
}))

vi.mock('../src/sync/syncEngine', () => ({
  enqueue: (...args: unknown[]) => harness.enqueue(...args),
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

function emitEvent(value: DiaryEvent, familyId = settings.familyId): void {
  for (const listener of [...harness.eventListeners]) listener(value, familyId)
}

describe('lossless event store initialization', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    harness.eventListeners.clear()
    harness.settingsListeners.clear()
    harness.listEvents.mockReset()
    harness.appendEvent.mockReset()
    harness.appendEvent.mockResolvedValue('ok')
    harness.enqueue.mockReset()
    harness.getSettings.mockReset()
    harness.getSettings.mockResolvedValue(structuredClone(settings))
    harness.getDataInfo.mockReset()
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

  it('couples the initial event list to the hydrated settings family', async () => {
    harness.listEvents.mockResolvedValueOnce([])
    const { useAppStore } = await import('../src/store/useAppStore')

    await useAppStore.getState().init()

    expect(harness.listEvents).toHaveBeenCalledWith('family-1')
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
    await vi.waitFor(() => expect(harness.listEvents).toHaveBeenCalledTimes(1))
    const secondInit = useAppStore.getState().init()
    await vi.waitFor(() => expect(harness.listEvents).toHaveBeenCalledTimes(2))
    expect(harness.eventListeners.size).toBe(1)

    secondList.resolve([event('new-init')])
    await secondInit
    firstList.resolve([event('stale-init')])
    await firstInit

    expect(useAppStore.getState().events.map(item => item.id)).toEqual(['new-init'])
    expect(harness.eventListeners.size).toBe(1)
  })

  it('never lets a late family-A startup list overwrite a completed family-B reload', async () => {
    const lateFamilyAList = deferred<DiaryEvent[]>()
    const familyAEvent = event('family-a-startup')
    const familyBEvent = event('family-b-reload')
    harness.listEvents
      .mockReturnValueOnce(lateFamilyAList.promise)
      .mockResolvedValueOnce([familyBEvent])
    const { useAppStore } = await import('../src/store/useAppStore')

    const init = useAppStore.getState().init()
    await vi.waitFor(() => expect(harness.listEvents).toHaveBeenCalledTimes(1))
    for (const listener of [...harness.settingsListeners]) {
      listener({
        sequence: 1,
        settings: { ...settings, familyId: 'family-2' },
      })
    }
    await vi.waitFor(() => expect(harness.listEvents).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(useAppStore.getState().events).toEqual([familyBEvent]))

    lateFamilyAList.resolve([familyAEvent])
    await init

    expect(useAppStore.getState().settings?.familyId).toBe('family-2')
    expect(useAppStore.getState().events).toEqual([familyBEvent])
    expect(harness.listEvents.mock.calls).toEqual([['family-1'], ['family-2']])
  })

  it('does not merge a family-A add that resolves after a family-B settings broadcast', async () => {
    const pendingAppend = deferred<'ok' | 'duplicate' | 'error'>()
    harness.listEvents.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    harness.appendEvent.mockReturnValueOnce(pendingAppend.promise)
    const { useAppStore } = await import('../src/store/useAppStore')
    await useAppStore.getState().init()

    const add = useAppStore.getState().addEvent(event('family-a-pending-add'))
    await vi.waitFor(() => expect(harness.appendEvent).toHaveBeenCalled())
    for (const listener of [...harness.settingsListeners]) {
      listener({ sequence: 1, settings: { ...settings, familyId: 'family-2' } })
    }
    await vi.waitFor(() => expect(harness.listEvents).toHaveBeenCalledTimes(2))
    pendingAppend.resolve('ok')
    const persisted = await add

    expect(harness.appendEvent).toHaveBeenCalledWith(expect.anything(), 'family-1')
    expect(harness.enqueue).toHaveBeenCalledWith(persisted, 'family-1')
    expect(useAppStore.getState().settings?.familyId).toBe('family-2')
    expect(useAppStore.getState().events).toEqual([])
  })

  it('does not merge a family-A edit that resolves after a family-B settings broadcast', async () => {
    const original = event('family-a-original')
    const pendingAppend = deferred<'ok' | 'duplicate' | 'error'>()
    harness.listEvents.mockResolvedValueOnce([original]).mockResolvedValueOnce([])
    harness.appendEvent.mockReturnValueOnce(pendingAppend.promise)
    const { useAppStore } = await import('../src/store/useAppStore')
    await useAppStore.getState().init()

    const edit = useAppStore.getState().editEvent(original, { data: { note: 'edited in A' } })
    await vi.waitFor(() => expect(harness.appendEvent).toHaveBeenCalled())
    for (const listener of [...harness.settingsListeners]) {
      listener({ sequence: 1, settings: { ...settings, familyId: 'family-2' } })
    }
    await vi.waitFor(() => expect(harness.listEvents).toHaveBeenCalledTimes(2))
    pendingAppend.resolve('ok')
    const persisted = await edit

    expect(harness.enqueue).toHaveBeenCalledWith(persisted, 'family-1')
    expect(useAppStore.getState().events).toEqual([])
  })

  it('rejects a family-A modal edit invoked after the view switched to family B', async () => {
    const original = event('family-a-stale-edit')
    harness.listEvents.mockResolvedValueOnce([original]).mockResolvedValueOnce([])
    const { useAppStore } = await import('../src/store/useAppStore')
    await useAppStore.getState().init()
    const modalOriginal = useAppStore.getState().events[0]

    for (const listener of [...harness.settingsListeners]) {
      listener({ sequence: 1, settings: { ...settings, familyId: 'family-2' } })
    }
    await vi.waitFor(() => expect(harness.listEvents).toHaveBeenCalledTimes(2))

    await expect(useAppStore.getState().editEvent(modalOriginal, {
      data: { note: 'must not cross families' },
    })).rejects.toThrow('stale_family_view')
    expect(harness.appendEvent).not.toHaveBeenCalled()
    expect(harness.enqueue).not.toHaveBeenCalled()
  })

  it('rejects a family-A modal delete invoked after the view switched to family B', async () => {
    const original = event('family-a-stale-delete')
    harness.listEvents.mockResolvedValueOnce([original]).mockResolvedValueOnce([])
    const { useAppStore } = await import('../src/store/useAppStore')
    await useAppStore.getState().init()
    const modalOriginal = useAppStore.getState().events[0]

    for (const listener of [...harness.settingsListeners]) {
      listener({ sequence: 1, settings: { ...settings, familyId: 'family-2' } })
    }
    await vi.waitFor(() => expect(harness.listEvents).toHaveBeenCalledTimes(2))

    await expect(useAppStore.getState().softDeleteEvent(modalOriginal))
      .rejects.toThrow('stale_family_view')
    expect(harness.appendEvent).not.toHaveBeenCalled()
    expect(harness.enqueue).not.toHaveBeenCalled()
  })

  it('preserves a modal edit when a same-family remote revision becomes the live winner', async () => {
    const original = event('same-family-edit', 1, 'modal source')
    const remoteWinner = event('same-family-edit', 2, 'remote winner')
    harness.listEvents.mockResolvedValueOnce([original])
    const { useAppStore } = await import('../src/store/useAppStore')
    await useAppStore.getState().init()
    const modalOriginal = useAppStore.getState().events[0]
    emitEvent(remoteWinner, 'family-1')

    const edited = await useAppStore.getState().editEvent(modalOriginal, {
      data: { note: 'local edit' },
    })

    expect(edited.rev).toBeGreaterThan(remoteWinner.rev)
    expect(harness.appendEvent).toHaveBeenCalledWith(edited, 'family-1')
    expect(harness.enqueue).toHaveBeenCalledWith(edited, 'family-1')
  })

  it('ignores a late family-A bridge append after switching to family B', async () => {
    harness.listEvents.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    const { useAppStore } = await import('../src/store/useAppStore')
    await useAppStore.getState().init()
    for (const listener of [...harness.settingsListeners]) {
      listener({ sequence: 1, settings: { ...settings, familyId: 'family-2' } })
    }
    await vi.waitFor(() => expect(harness.listEvents).toHaveBeenCalledTimes(2))

    emitEvent(event('late-family-a'), 'family-1')
    emitEvent(event('current-family-b'), 'family-2')

    expect(useAppStore.getState().events.map(item => item.id)).toEqual(['current-family-b'])
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

  it('quarantines exact raw and auth-bound v0.3.8 fixture events during initial load', async () => {
    const raw = (upgradeContract.buildV038Fixture().events as DiaryEvent[])
      .find(item => item.id === 'legacy-temp')!
    const derivative = deriveAuthBoundEvent(raw, 'parent-1')
    const legitimate = event('legitimate-initial')
    harness.listEvents.mockResolvedValueOnce([raw, derivative, legitimate])
    const { useAppStore } = await import('../src/store/useAppStore')

    await useAppStore.getState().init()

    expect(useAppStore.getState().events).toEqual([legitimate])
  })

  it('quarantines exact raw and auth-bound v0.3.8 fixture events from external appends', async () => {
    const raw = (upgradeContract.buildV038Fixture().events as DiaryEvent[])
      .find(item => item.id === 'legacy-formula' && item.rev === 2)!
    const derivative = deriveAuthBoundEvent(raw, 'parent-1')
    const legitimate = event('legitimate-broadcast')
    harness.listEvents.mockResolvedValueOnce([])
    const { useAppStore } = await import('../src/store/useAppStore')
    await useAppStore.getState().init()

    emitEvent(raw)
    emitEvent(derivative)
    emitEvent(legitimate)

    expect(useAppStore.getState().events).toEqual([legitimate])
  })
})
