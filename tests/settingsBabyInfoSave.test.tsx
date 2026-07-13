// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
  AppSettings,
  BabyInfoCommitIpcResponse,
  BabyInfoSettingsCommitOperation,
} from '../shared/types'
import { getBabyInfoMutationKey, makeBabyInfoUnlinkedArchive } from '../shared/babyInfoResolver'
import { makeBabyInfoArchiveCursor } from '../shared/babyInfoArchivePaging'
import { BabyInfoSettingsCommitError } from '../shared/babyInfoSettingsCommit'
import { SettingsStore } from '../electron/store/settings'
import { SettingsPage } from '../src/pages/SettingsPage'
import { ToastProvider } from '../src/components/Toast'
import { useAppStore } from '../src/store/useAppStore'
import i18n from '../src/i18n'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

function settings(): AppSettings {
  return {
    baby: { name: '기존 아기', birthdate: '2026-01-02', gender: 'girl' },
    profile: { uid: 'user-1', name: '보호자', role: 'mom' },
    familyId: 'family-1',
    firebase: null,
    language: 'ko',
    theme: 'light',
  }
}

let tmpDir: string
let mainStore: SettingsStore

async function commitOnMain(
  operation: BabyInfoSettingsCommitOperation,
): Promise<BabyInfoCommitIpcResponse> {
  try {
    return { ok: true, value: clone(mainStore.commitBabyInfo(operation)) }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof BabyInfoSettingsCommitError ? error.code : 'STORAGE_FAILURE',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

const saveSettings = vi.fn(async (next: AppSettings) => {
  return clone(mainStore.save(next))
})
const getSettings = vi.fn(async () => clone(mainStore.get()))
const commitBabyInfo = vi.fn(async (
  operation: BabyInfoSettingsCommitOperation,
): Promise<BabyInfoCommitIpcResponse> => commitOnMain(operation))
const archivedBabyInfo = makeBabyInfoUnlinkedArchive(
  '보관된 아기',
  '2025-12-31',
  '2026-07-13T00:00:00.000Z',
)!
const listUnlinkedBabyInfoArchives = vi.fn(async (_request: { limit: number; cursor?: string }) => ({
  items: [archivedBabyInfo],
}))

const bridge: Window['babyDiary'] = {
  getFirebaseEmulator: async () => null,
  openEvidenceSource: async () => undefined,
  listEvents: async () => [],
  listEventMutations: async () => [],
  appendEvent: async () => 'ok',
  getSettings,
  saveSettings,
  commitBabyInfo,
  listPendingBabyInfo: async request => clone(mainStore.listPendingBabyInfo(request)),
  getBabyInfoSummary: async familyId => clone(mainStore.getBabyInfoSummary(familyId)),
  listUnlinkedBabyInfoArchives,
  exportData: async () => undefined,
  openBackupFolder: async () => undefined,
  getDataInfo: async () => ({
    dataDir: 'data',
    backupDir: 'backup',
    documentsBackupDir: 'documents',
    eventCount: 0,
    lastBackupTime: null,
  }),
  onEventAppended: () => () => undefined,
  onSettingsChanged: () => () => undefined,
  onUpdateReady: () => () => undefined,
  onUpdateAvailable: () => () => undefined,
  updateRendererReady: () => undefined,
  installUpdate: () => undefined,
  openUpdateDownload: () => undefined,
  savePdf: async () => ({ saved: false }),
  reportReady: () => undefined,
  mergeSettings: async partial => {
    return clone(mainStore.merge(partial))
  },
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

function inputByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const labelNode = Array.from(container.querySelectorAll('.label')).find(node => node.textContent === label)
  const input = labelNode?.parentElement?.querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error(`input not found: ${label}`)
  return input
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(node => (
    node.textContent?.trim() === i18n.t('settings.save')
  ))
  if (!(button instanceof HTMLButtonElement)) throw new Error('save button not found')
  return button
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

describe('SettingsPage baby info durable save', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    await i18n.changeLanguage('ko')
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baby-info-settings-ui-'))
    const seeded = settings()
    fs.writeFileSync(path.join(tmpDir, 'settings.json'), JSON.stringify({
      ...seeded,
      baby: { ...seeded.baby, name: '', birthdate: '' },
    }), 'utf8')
    mainStore = new SettingsStore(tmpDir)
    const initialPair = mainStore.commitBabyInfo({
      kind: 'user-edit',
      familyId: seeded.familyId,
      babyName: seeded.baby.name,
      babyBirthdate: seeded.baby.birthdate,
    })
    mainStore.commitBabyInfo({
      kind: 'reconcile',
      familyId: seeded.familyId,
      discoveredMutations: [],
      exactAcknowledgedMutationKeys: [getBabyInfoMutationKey(initialPair.mutation!)],
    })

    getSettings.mockReset().mockImplementation(async () => clone(mainStore.get()))
    saveSettings.mockReset().mockImplementation(async next => {
      return clone(mainStore.save(next))
    })
    commitBabyInfo.mockReset().mockImplementation(commitOnMain)
    listUnlinkedBabyInfoArchives.mockReset().mockImplementation(async () => ({
      items: [archivedBabyInfo],
    }))
    Object.defineProperty(window, 'babyDiary', { configurable: true, value: bridge })
    useAppStore.setState({ settings: clone(mainStore.get()), dataInfo: null, error: null })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(
      <ToastProvider>
        <SettingsPage />
      </ToastProvider>,
    ))
    await flush()
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    delete (window as Partial<Window>).babyDiary
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('persists an intentional empty name/date and queued mutation in one save, then shows pending copy', async () => {
    const name = inputByLabel(container, i18n.t('settings.babyName'))
    const birthdate = inputByLabel(container, i18n.t('settings.birthdate'))

    await act(async () => {
      setInput(name, '')
      setInput(birthdate, '')
    })
    await act(async () => saveButton(container).click())
    await flush()

    expect(commitBabyInfo).toHaveBeenCalledTimes(1)
    expect(commitBabyInfo).toHaveBeenCalledWith({
      kind: 'user-edit',
      familyId: 'family-1',
      babyName: '',
      babyBirthdate: '',
    })
    const saved = mainStore.get()
    expect(saved.baby).toMatchObject({ name: '', birthdate: '' })
    expect(saved.babyInfoSync).toBeUndefined()
    const pending = mainStore.listPendingBabyInfo({ familyId: 'family-1', limit: 10 }).items
    expect(pending.find(item => item.origin === 'user')).toMatchObject({
      babyName: '',
      babyBirthdate: '',
    })
    expect(mainStore.getBabyInfoSummary('family-1').pendingCount).toBe(1)
    expect(container.textContent).toContain('연결되면 동기화')
    expect(container.textContent).not.toContain(i18n.t('settings.toastSaved'))
  })

  it('applies an archived unlinked pair only to dirty fields and creates a mutation only after Save', async () => {
    expect(listUnlinkedBabyInfoArchives).toHaveBeenCalledWith({ limit: 10 })
    const apply = Array.from(container.querySelectorAll('button')).find(button => (
      button.textContent?.includes('보관된 아기 정보 적용')
    ))
    expect(apply).toBeInstanceOf(HTMLButtonElement)

    await act(async () => (apply as HTMLButtonElement).click())

    expect(inputByLabel(container, i18n.t('settings.babyName')).value).toBe('보관된 아기')
    expect(inputByLabel(container, i18n.t('settings.birthdate')).value).toBe('2025-12-31')
    expect(commitBabyInfo).not.toHaveBeenCalled()

    await act(async () => saveButton(container).click())
    await flush()

    expect(commitBabyInfo).toHaveBeenCalledOnce()
    expect(commitBabyInfo).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'user-edit',
      familyId: 'family-1',
      babyName: '보관된 아기',
      babyBirthdate: '2025-12-31',
    }))
  })

  it('keeps the initial archive DOM bounded and progressively loads the next page with visible focus', async () => {
    const archives = Array.from({ length: 11 }, (_, index) => makeBabyInfoUnlinkedArchive(
      `보관 ${index}`,
      '2025-12-31',
      new Date(Date.parse('2026-07-13T00:00:00.000Z') - index).toISOString(),
    )!)
    const firstPage = archives.slice(0, 10)
    const cursor = makeBabyInfoArchiveCursor(firstPage.at(-1)!.archiveId)
    listUnlinkedBabyInfoArchives.mockImplementation(async request => (
      request.cursor
        ? { items: [archives[10]] }
        : { items: firstPage, nextCursor: cursor }
    ))

    await act(async () => {
      useAppStore.setState({
        settings: { ...clone(mainStore.get()), familyId: 'family-page-reset' },
      })
    })
    await flush()

    expect(container.querySelectorAll('[data-archive-index]')).toHaveLength(10)
    const loadMore = Array.from(container.querySelectorAll('button')).find(button => (
      button.textContent?.includes(i18n.t('settings.unlinkedArchiveLoadMore'))
    )) as HTMLButtonElement
    expect(loadMore).toBeInstanceOf(HTMLButtonElement)

    await act(async () => loadMore.click())
    await flush()

    expect(listUnlinkedBabyInfoArchives).toHaveBeenLastCalledWith({ limit: 10, cursor })
    expect(container.querySelectorAll('[data-archive-index]')).toHaveLength(11)
    const firstNewApply = container.querySelector<HTMLButtonElement>('[data-archive-index="10"] button')
    expect(document.activeElement).toBe(firstNewApply)
  })

  it('keeps loaded archives visible while a next page is loading and reports a retryable page error', async () => {
    const archives = Array.from({ length: 10 }, (_, index) => makeBabyInfoUnlinkedArchive(
      `보관 오류 ${index}`,
      '2025-12-31',
      new Date(Date.parse('2026-07-13T00:00:00.000Z') - index).toISOString(),
    )!)
    const cursor = makeBabyInfoArchiveCursor(archives.at(-1)!.archiveId)
    const nextPage = deferred<{ items: typeof archives }>()
    listUnlinkedBabyInfoArchives.mockImplementation(request => (
      request.cursor
        ? nextPage.promise
        : Promise.resolve({ items: archives, nextCursor: cursor })
    ))

    await act(async () => {
      useAppStore.setState({ settings: { ...clone(mainStore.get()), profile: {
        ...clone(mainStore.get()).profile,
        uid: 'archive-error-reset',
      } } })
    })
    await flush()

    const loadMore = Array.from(container.querySelectorAll('button')).find(button => (
      button.textContent?.includes(i18n.t('settings.unlinkedArchiveLoadMore'))
    )) as HTMLButtonElement
    await act(async () => { loadMore.click() })
    expect(loadMore.disabled).toBe(true)
    expect(loadMore.textContent).toContain(i18n.t('settings.unlinkedArchiveLoading'))
    expect(container.querySelectorAll('[data-archive-index]')).toHaveLength(10)

    await act(async () => { nextPage.reject(new Error('page unavailable')) })
    await flush()

    expect(container.querySelectorAll('[data-archive-index]')).toHaveLength(10)
    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain(i18n.t('settings.unlinkedArchiveLoadError'))
    expect(loadMore.disabled).toBe(false)
    expect(loadMore.textContent).toContain(i18n.t('settings.unlinkedArchiveLoadMore'))
  })

  it('keeps a newer edit dirty when the prior dedicated save resolves, then commits it', async () => {
    let releaseCommit!: () => void
    const held = new Promise<void>(resolve => { releaseCommit = resolve })
    commitBabyInfo.mockImplementationOnce(async operation => {
      await held
      return commitOnMain(operation)
    })

    const name = inputByLabel(container, i18n.t('settings.babyName'))
    await act(async () => setInput(name, '첫 저장 값'))
    await act(async () => saveButton(container).click())
    await flush()
    expect(commitBabyInfo).toHaveBeenCalledTimes(1)

    await act(async () => setInput(name, '저장 중 새 값'))
    await act(async () => releaseCommit())
    await flush()
    expect(name.value).toBe('저장 중 새 값')

    await act(async () => saveButton(container).click())
    await flush()

    expect(commitBabyInfo).toHaveBeenCalledTimes(2)
    expect(commitBabyInfo).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'user-edit',
      babyName: '저장 중 새 값',
    }))
    expect(mainStore.get().baby.name).toBe('저장 중 새 값')
    const pendingNames = mainStore
      .listPendingBabyInfo({ familyId: 'family-1', limit: 10 })
      .items.map(item => item.babyName)
    expect(pendingNames).toEqual(expect.arrayContaining(['첫 저장 값', '저장 중 새 값']))
  })

  it('does not let late hydration overwrite a dirty intentional empty field', async () => {
    await act(async () => root.unmount())
    container.remove()

    let resolveHydration!: (value: AppSettings) => void
    const hydration = new Promise<AppSettings>(resolve => { resolveHydration = resolve })
    getSettings.mockReset()
      .mockImplementationOnce(async () => hydration)
      .mockImplementation(async () => clone(mainStore.get()))
    useAppStore.setState({ settings: null })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(
      <ToastProvider>
        <SettingsPage />
      </ToastProvider>,
    ))

    const name = inputByLabel(container, i18n.t('settings.babyName'))
    await act(async () => setInput(name, '잠깐 입력'))
    await act(async () => setInput(name, ''))
    await act(async () => resolveHydration(clone(mainStore.get())))
    await flush()

    expect(name.value).toBe('')
    expect(inputByLabel(container, i18n.t('settings.birthdate')).value).toBe('2026-01-02')
  })

  it('shows an error alert and no success/pending copy when the atomic disk save fails', async () => {
    commitBabyInfo.mockResolvedValueOnce({
      ok: false,
      error: { code: 'STORAGE_FAILURE', message: 'disk full' },
    })
    const name = inputByLabel(container, i18n.t('settings.babyName'))
    await act(async () => setInput(name, '저장 실패 값'))
    await act(async () => saveButton(container).click())
    await flush()

    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain(i18n.t('settings.toastSaveFail'))
    expect(container.textContent).not.toContain(i18n.t('settings.toastSaved'))
    expect(container.textContent).not.toContain('연결되면 동기화')
  })

  it('preserves a newer durable baby-info log when generic settings save receives a stale object', async () => {
    const stale = clone(mainStore.get())
    const committed = mainStore.commitBabyInfo({
      kind: 'user-edit',
      familyId: 'family-1',
      babyName: 'durable',
      babyBirthdate: '2026-01-02',
    })
    const durableSettings = clone(committed.settings)
    await act(async () => {
      useAppStore.setState({ settings: stale })
    })

    await act(async () => {
      await useAppStore.getState().saveSettings({ ...stale, theme: 'dark' })
    })

    expect(mainStore.get()).toMatchObject({
      baby: { name: 'durable', birthdate: '2026-01-02' },
      babyInfoJournal: durableSettings.babyInfoJournal,
      babyInfoRevision: durableSettings.babyInfoRevision,
      theme: 'dark',
    })
    expect(mainStore.getBabyInfoSummary('family-1').pendingCount).toBe(1)
    expect(mainStore.listPendingBabyInfo({ familyId: 'family-1', limit: 10 }).items)
      .toContainEqual(committed.mutation)
  })

  it('does not resurrect an already acknowledged pending key from stale generic settings', async () => {
    const edited = mainStore.commitBabyInfo({
      kind: 'user-edit',
      familyId: 'family-1',
      babyName: 'acknowledged',
      babyBirthdate: '2026-01-02',
    })
    const stale = clone(edited.settings)
    const key = getBabyInfoMutationKey(edited.mutation!)
    mainStore.commitBabyInfo({
      kind: 'reconcile',
      familyId: 'family-1',
      discoveredMutations: [],
      exactAcknowledgedMutationKeys: [key],
    })
    expect(mainStore.getBabyInfoSummary('family-1').pendingCount).toBe(0)

    await act(async () => {
      await useAppStore.getState().saveSettings(stale)
    })

    expect(mainStore.get().babyInfoSync).toBeUndefined()
    expect(mainStore.getBabyInfoSummary('family-1').pendingCount).toBe(0)
    expect(mainStore.listPendingBabyInfo({ familyId: 'family-1', limit: 10 }).items).toEqual([])
  })
})
