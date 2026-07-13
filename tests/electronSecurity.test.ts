import { EventEmitter } from 'node:events'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type { Session } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type ElectronPermissionRequestHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
type ElectronPermissionCheckHandler = NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>

type PermissionRequestHandler = (
  webContents: MockWebContents,
  permission: Parameters<ElectronPermissionRequestHandler>[1],
  callback: Parameters<ElectronPermissionRequestHandler>[2],
  details: Parameters<ElectronPermissionRequestHandler>[3],
) => void

type PermissionCheckHandler = (
  webContents: MockWebContents | null,
  permission: Parameters<ElectronPermissionCheckHandler>[1],
  requestingOrigin: string,
  details: Parameters<ElectronPermissionCheckHandler>[3],
) => boolean

class MockSession {
  permissionRequestHandler?: PermissionRequestHandler
  permissionCheckHandler?: PermissionCheckHandler

  setPermissionRequestHandler = vi.fn((handler: PermissionRequestHandler) => {
    this.permissionRequestHandler = handler
  })

  setPermissionCheckHandler = vi.fn((handler: PermissionCheckHandler) => {
    this.permissionCheckHandler = handler
  })
}

class MockWebContents extends EventEmitter {
  currentUrl = ''
  send = vi.fn()
  openDevTools = vi.fn()
  printToPDF = vi.fn(async () => Buffer.from('pdf'))
  setWindowOpenHandler = vi.fn()
  getURL = vi.fn(() => this.currentUrl)

  constructor(readonly session: MockSession) {
    super()
  }
}

class MockBrowserWindow extends EventEmitter {
  static instances: MockBrowserWindow[] = []
  static sharedSession = new MockSession()

  options: Record<string, any>
  destroyed = false
  webContents = new MockWebContents(MockBrowserWindow.sharedSession)
  loadURL = vi.fn(async (url: string) => {
    this.webContents.currentUrl = url
  })
  loadFile = vi.fn(async (filePath: string, options?: { hash?: string }) => {
    this.webContents.currentUrl = `${pathToFileURL(filePath)}${options?.hash ? `#${options.hash}` : ''}`
  })
  show = vi.fn()
  destroy = vi.fn(() => {
    if (this.destroyed) return
    this.destroyed = true
    this.webContents.emit('destroyed')
    this.emit('closed')
  })
  isMinimized = vi.fn(() => false)
  restore = vi.fn()
  focus = vi.fn()

  constructor(options: Record<string, any>) {
    super()
    this.options = options
    MockBrowserWindow.instances.push(this)
  }
}

const ipcHandlers = new Map<string, (...args: any[]) => any>()
const testPdfPath = join(tmpdir(), 'baby-diary-electron-security-test.pdf')
const settingsStoreMocks = vi.hoisted(() => ({
  construct: vi.fn(),
  get: vi.fn(() => ({})),
  save: vi.fn(),
  merge: vi.fn(),
  commitBabyInfo: vi.fn(),
  listPendingBabyInfo: vi.fn(),
  getBabyInfoSummary: vi.fn(),
  getBabyInfoMutation: vi.fn(),
}))

vi.mock('electron', () => {
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getPath: vi.fn(() => tmpdir()),
    setPath: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    exit: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  })
  const ipcMain = Object.assign(new EventEmitter(), {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      ipcHandlers.set(channel, handler)
    }),
  })

  return {
    app,
    BrowserWindow: MockBrowserWindow,
    ipcMain,
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: testPdfPath })),
      showErrorBox: vi.fn(),
    },
    shell: {
      openExternal: vi.fn(async () => undefined),
      openPath: vi.fn(async () => ''),
    },
  }
})

vi.mock('../electron/store/eventLog', () => ({
  EventLog: class {
    loadAll = vi.fn(() => [])
    getAll = vi.fn(() => [])
    append = vi.fn(() => 'ok')
    getCount = vi.fn(() => 0)
  },
}))

vi.mock('../electron/store/settings', () => ({
  SettingsStore: class {
    constructor() { settingsStoreMocks.construct() }
    get = settingsStoreMocks.get
    save = settingsStoreMocks.save
    merge = settingsStoreMocks.merge
    commitBabyInfo = settingsStoreMocks.commitBabyInfo
    listPendingBabyInfo = settingsStoreMocks.listPendingBabyInfo
    getBabyInfoSummary = settingsStoreMocks.getBabyInfoSummary
    getBabyInfoMutation = settingsStoreMocks.getBabyInfoMutation
  },
}))

vi.mock('../electron/store/backup', () => ({
  BackupManager: class {
    start = vi.fn()
    stop = vi.fn()
    backup = vi.fn(async () => undefined)
    isRunning = vi.fn(() => true)
    getBackupDir = vi.fn(() => tmpdir())
    getDocumentsBackupDir = vi.fn(() => tmpdir())
    getLastBackupTime = vi.fn(() => null)
  },
}))

vi.mock('../electron/updater', () => ({
  attachUpdaterWindow: vi.fn(),
  setupUpdater: vi.fn(),
  stopUpdater: vi.fn(),
  isUpdaterRunning: vi.fn(() => false),
}))

vi.mock('../electron/evidenceExternalLink', () => ({
  registerEvidenceExternalLinkIPC: vi.fn(),
}))

async function loadMainWindow(): Promise<MockBrowserWindow> {
  await import('../electron/main')
  await vi.waitFor(() => expect(MockBrowserWindow.instances).toHaveLength(1))
  return MockBrowserWindow.instances[0]
}

type PrintWindowTask = {
  window: MockBrowserWindow
  savePromise: Promise<unknown>
}

async function startPrintWindow(): Promise<PrintWindowTask> {
  const savePdf = ipcHandlers.get('report:savePdf')
  expect(savePdf).toBeTypeOf('function')
  const savePromise = savePdf!()
  await vi.waitFor(() => expect(MockBrowserWindow.instances).toHaveLength(2))
  await vi.waitFor(async () => {
    const electron = await import('electron')
    expect((electron.ipcMain as unknown as EventEmitter).listenerCount('report:ready')).toBe(1)
  })
  return { window: MockBrowserWindow.instances[1], savePromise }
}

async function finishPrintWindow(task: PrintWindowTask): Promise<void> {
  const electron = await import('electron')
  ;(electron.ipcMain as unknown as EventEmitter).emit('report:ready')
  await expect(task.savePromise).resolves.toEqual({ saved: true, path: testPdfPath })
  expect(task.window.destroy).toHaveBeenCalledTimes(1)
  expect(task.window.destroyed).toBe(true)
}

describe('Electron BrowserWindow security boundary', () => {
  beforeEach(async () => {
    vi.resetModules()
    ipcHandlers.clear()
    MockBrowserWindow.instances.length = 0
    MockBrowserWindow.sharedSession = new MockSession()
    if (existsSync(testPdfPath)) rmSync(testPdfPath, { force: true })
    const electron = await import('electron')
    const app = electron.app as unknown as EventEmitter
    const ipcMain = electron.ipcMain as unknown as EventEmitter & { handle: ReturnType<typeof vi.fn> }
    app.removeAllListeners()
    ipcMain.removeAllListeners()
    ipcMain.handle.mockClear()
    settingsStoreMocks.commitBabyInfo.mockReset()
    settingsStoreMocks.construct.mockReset()
    settingsStoreMocks.get.mockReset().mockReturnValue({})
    settingsStoreMocks.save.mockReset()
    settingsStoreMocks.merge.mockReset()
    settingsStoreMocks.listPendingBabyInfo.mockReset()
    settingsStoreMocks.getBabyInfoSummary.mockReset()
    settingsStoreMocks.getBabyInfoMutation.mockReset()
  })

  it('explicitly sandboxes both the main and print windows', async () => {
    const mainWindow = await loadMainWindow()
    const printTask = await startPrintWindow()

    for (const window of [mainWindow, printTask.window]) {
      expect(window.options.webPreferences).toMatchObject({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      })
    }

    await finishPrintWindow(printTask)
  })

  it('returns an allowlisted envelope for baby-info commits without exposing storage details', async () => {
    await loadMainWindow()
    const handler = ipcHandlers.get('settings:commitBabyInfo')
    expect(handler).toBeTypeOf('function')

    const value = { kind: 'user-edit', settings: {}, babyInfo: 'pending', pendingCount: 1, activePendingCount: 1 }
    settingsStoreMocks.commitBabyInfo.mockReturnValueOnce(value)
    await expect(handler!({}, { kind: 'user-edit' })).resolves.toEqual({ ok: true, value })

    settingsStoreMocks.commitBabyInfo.mockImplementationOnce(() => {
      throw new Error('[Settings] save failed: C:\\private\\settings.json EACCES')
    })
    await expect(handler!({}, { kind: 'user-edit' })).resolves.toEqual({
      ok: false,
      error: {
        code: 'STORAGE_FAILURE',
        message: 'Unable to save baby info settings.',
      },
    })
  })

  it('fails closed with a user-visible recovery message when settings and journal cannot be verified', async () => {
    settingsStoreMocks.construct.mockImplementationOnce(() => {
      throw Object.assign(new Error('C:\\private\\settings.json contains secrets'), {
        code: 'SETTINGS_RECOVERY_REQUIRED',
        recoverable: true,
      })
    })
    const electron = await import('electron')
    electron.dialog.showErrorBox.mockClear()

    await import('../electron/main')
    await vi.waitFor(() => expect(electron.dialog.showErrorBox).toHaveBeenCalledTimes(1))

    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'Baby Diary recovery required',
      expect.stringContaining('verified backup'),
    )
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'Baby Diary recovery required',
      expect.stringContaining('could not be confirmed'),
    )
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('C:\\private'),
    )
    expect(electron.app.exit).toHaveBeenCalledWith(1)
    expect(MockBrowserWindow.instances).toHaveLength(0)
  })

  it('claims original preservation only when recovery reports a confirmed durable forensic archive', async () => {
    settingsStoreMocks.construct.mockImplementationOnce(() => {
      throw Object.assign(new Error('redacted'), {
        code: 'SETTINGS_RECOVERY_REQUIRED',
        recoverable: true,
        originalsPreserved: true,
      })
    })
    const electron = await import('electron')
    electron.dialog.showErrorBox.mockClear()

    await import('../electron/main')
    await vi.waitFor(() => expect(electron.dialog.showErrorBox).toHaveBeenCalledTimes(1))

    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'Baby Diary recovery required',
      expect.stringContaining('durable forensic archive'),
    )
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('could not be confirmed'),
    )
  })

  it('asks for a Windows restart without claiming unconfirmed forensic preservation', async () => {
    settingsStoreMocks.construct.mockImplementationOnce(() => {
      throw Object.assign(new Error('redacted'), {
        code: 'SETTINGS_RECOVERY_REQUIRED',
        recoverable: true,
        restartRequired: true,
        primaryUntouched: true,
        originalsPreserved: false,
      })
    })
    const electron = await import('electron')
    electron.dialog.showErrorBox.mockClear()

    await import('../electron/main')
    await vi.waitFor(() => expect(electron.dialog.showErrorBox).toHaveBeenCalledTimes(1))

    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'Baby Diary recovery required',
      expect.stringMatching(/restart Baby Diary/i),
    )
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'Baby Diary recovery required',
      expect.stringMatching(/primary.+untouched/i),
    )
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'Baby Diary recovery required',
      expect.stringMatching(/not yet confirmed/i),
    )
  })

  it('admits a durable local archive-only mutation in startup copy', async () => {
    settingsStoreMocks.construct.mockImplementationOnce(() => {
      throw Object.assign(new Error('redacted'), {
        code: 'SETTINGS_RECOVERY_REQUIRED',
        recoverable: true,
        localDataModified: true,
        archiveEvidence: {
          archiveId: '11111111-1111-4111-8111-111111111111',
          durable: true,
        },
      })
    })
    const electron = await import('electron')
    electron.dialog.showErrorBox.mockClear()

    await import('../electron/main')
    await vi.waitFor(() => expect(electron.dialog.showErrorBox).toHaveBeenCalledTimes(1))

    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'Baby Diary recovery required',
      expect.stringMatching(/local baby-info archive was durably added/i),
    )
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/no local data was modified/i),
    )
  })

  it('exposes bounded baby-info delta handlers and broadcasts authoritative settings after successful writes', async () => {
    const mainWindow = await loadMainWindow()
    const save = ipcHandlers.get('settings:save')
    const merge = ipcHandlers.get('settings:merge')
    const commit = ipcHandlers.get('settings:commitBabyInfo')
    const listPending = ipcHandlers.get('babyInfo:listPending')
    const getSummary = ipcHandlers.get('babyInfo:getSummary')
    const getMutation = ipcHandlers.get('babyInfo:getMutation')
    expect(save).toBeTypeOf('function')
    expect(merge).toBeTypeOf('function')
    expect(commit).toBeTypeOf('function')
    expect(listPending).toBeTypeOf('function')
    expect(getSummary).toBeTypeOf('function')
    expect(getMutation).toBeTypeOf('function')

    const first = { baby: { name: 'A', birthdate: '' } }
    const second = { baby: { name: 'B', birthdate: '' } }
    const third = { baby: { name: 'C', birthdate: '' } }
    settingsStoreMocks.save.mockReturnValueOnce(first)
    settingsStoreMocks.merge.mockReturnValueOnce(second)
    settingsStoreMocks.commitBabyInfo.mockReturnValueOnce({
      kind: 'reconcile',
      settings: third,
      babyInfo: 'unchanged',
      pendingCount: 0,
      activePendingCount: 0,
    })
    settingsStoreMocks.listPendingBabyInfo.mockReturnValueOnce({ items: [], nextCursor: undefined })
    settingsStoreMocks.getBabyInfoSummary.mockReturnValueOnce({
      familyId: 'family-A', mutationCount: 0, pendingCount: 0,
    })
    settingsStoreMocks.getBabyInfoMutation.mockReturnValueOnce(undefined)

    await expect(save!({}, first)).resolves.toBe(first)
    await expect(merge!({}, { theme: 'dark' })).resolves.toBe(second)
    await expect(commit!({}, {
      kind: 'reconcile', familyId: 'family-A', discoveredMutations: [], exactAcknowledgedMutationKeys: [],
    })).resolves.toEqual({ ok: true, value: expect.objectContaining({ settings: third }) })
    await expect(listPending!({}, { familyId: 'family-A', limit: 100 })).resolves.toEqual({ items: [] })
    await expect(getSummary!({}, 'family-A')).resolves.toMatchObject({ familyId: 'family-A' })
    await expect(getMutation!({}, 'family-A', 'baby-info:key')).resolves.toBeUndefined()
    expect(settingsStoreMocks.getBabyInfoMutation)
      .toHaveBeenCalledWith('family-A', 'baby-info:key')

    expect(mainWindow.webContents.send.mock.calls.filter(call => call[0] === 'settings:changed'))
      .toEqual([
        ['settings:changed', { sequence: 1, settings: first }],
        ['settings:changed', { sequence: 2, settings: second }],
        ['settings:changed', { sequence: 3, settings: third }],
      ])
  })

  it('denies renderer-created windows and renderer-initiated navigation on both windows', async () => {
    const mainWindow = await loadMainWindow()
    const printTask = await startPrintWindow()
    const printWindow = printTask.window

    expect(mainWindow.loadFile).toHaveBeenCalledTimes(1)
    expect(printWindow.loadFile).toHaveBeenCalledWith(expect.stringContaining('index.html'), { hash: '/report' })

    for (const window of [mainWindow, printWindow]) {
      expect(window.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1)
      const openHandler = window.webContents.setWindowOpenHandler.mock.calls[0][0]
      expect(openHandler({ url: 'https://attacker.example' })).toEqual({ action: 'deny' })

      for (const target of ['https://attacker.example', 'file:///C:/Windows/System32/calc.exe']) {
        const event = { preventDefault: vi.fn() }
        window.webContents.emit('will-navigate', event, target)
        expect(event.preventDefault).toHaveBeenCalledTimes(1)
      }
    }

    await finishPrintWindow(printTask)
  })

  it('allows only the required trusted clipboard write and denies every other permission', async () => {
    const mainWindow = await loadMainWindow()
    const printTask = await startPrintWindow()
    const printWindow = printTask.window
    const session = MockBrowserWindow.sharedSession

    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
    expect(session.permissionRequestHandler).toBeTypeOf('function')
    expect(session.permissionCheckHandler).toBeTypeOf('function')

    for (const window of [mainWindow, printWindow]) {
      const trustedUrl = window.webContents.getURL()
      const trustedClipboard = vi.fn()
      session.permissionRequestHandler!(
        window.webContents,
        'clipboard-sanitized-write',
        trustedClipboard,
        { requestingUrl: trustedUrl, isMainFrame: true },
      )
      expect(trustedClipboard).toHaveBeenCalledWith(true)

      for (const [permission, requestingUrl] of [
        ['media', trustedUrl],
        ['clipboard-sanitized-write', 'https://attacker.example'],
      ] as const) {
        const callback = vi.fn()
        session.permissionRequestHandler!(
          window.webContents,
          permission,
          callback,
          { requestingUrl, isMainFrame: true },
        )
        expect(callback).toHaveBeenCalledWith(false)
      }

      const subframeClipboard = vi.fn()
      session.permissionRequestHandler!(
        window.webContents,
        'clipboard-sanitized-write',
        subframeClipboard,
        { requestingUrl: trustedUrl, isMainFrame: false },
      )
      expect(subframeClipboard).toHaveBeenCalledWith(false)

      expect(session.permissionCheckHandler!(
        window.webContents,
        'clipboard-sanitized-write',
        'file://',
        { requestingUrl: trustedUrl, isMainFrame: true },
      )).toBe(true)
      expect(session.permissionCheckHandler!(
        window.webContents,
        'clipboard-sanitized-write',
        'https://attacker.example',
        { requestingUrl: 'https://attacker.example', isMainFrame: true },
      )).toBe(false)
      expect(session.permissionCheckHandler!(
        window.webContents,
        'clipboard-sanitized-write',
        'file://',
        { requestingUrl: trustedUrl, isMainFrame: false },
      )).toBe(false)
      expect(session.permissionCheckHandler!(
        window.webContents,
        'geolocation',
        'file://',
        { requestingUrl: trustedUrl, isMainFrame: true },
      )).toBe(false)
    }

    const mainUrl = mainWindow.webContents.getURL()
    for (const untrustedWebContents of [new MockWebContents(session), null]) {
      const callback = vi.fn()
      if (untrustedWebContents) untrustedWebContents.currentUrl = mainUrl
      session.permissionRequestHandler!(
        untrustedWebContents ?? new MockWebContents(session),
        'clipboard-sanitized-write',
        callback,
        { requestingUrl: mainUrl, isMainFrame: true },
      )
      expect(callback).toHaveBeenCalledWith(false)
      expect(session.permissionCheckHandler!(
        untrustedWebContents,
        'clipboard-sanitized-write',
        'file://',
        { requestingUrl: mainUrl, isMainFrame: true },
      )).toBe(false)
    }

    await finishPrintWindow(printTask)
    const destroyedPrintClipboard = vi.fn()
    session.permissionRequestHandler!(
      printWindow.webContents,
      'clipboard-sanitized-write',
      destroyedPrintClipboard,
      { requestingUrl: printWindow.webContents.getURL(), isMainFrame: true },
    )
    expect(destroyedPrintClipboard).toHaveBeenCalledWith(false)
    expect(session.permissionCheckHandler!(
      printWindow.webContents,
      'clipboard-sanitized-write',
      'file://',
      { requestingUrl: printWindow.webContents.getURL(), isMainFrame: true },
    )).toBe(false)

    mainWindow.destroy()
    const destroyedMainClipboard = vi.fn()
    session.permissionRequestHandler!(
      mainWindow.webContents,
      'clipboard-sanitized-write',
      destroyedMainClipboard,
      { requestingUrl: mainUrl, isMainFrame: true },
    )
    expect(destroyedMainClipboard).toHaveBeenCalledWith(false)

    const electron = await import('electron')
    ;(electron.app as unknown as EventEmitter).emit('activate')
    await vi.waitFor(() => expect(MockBrowserWindow.instances).toHaveLength(3))
    const recreatedMainWindow = MockBrowserWindow.instances[2]
    const recreatedClipboard = vi.fn()
    session.permissionRequestHandler!(
      recreatedMainWindow.webContents,
      'clipboard-sanitized-write',
      recreatedClipboard,
      { requestingUrl: recreatedMainWindow.webContents.getURL(), isMainFrame: true },
    )
    expect(recreatedClipboard).toHaveBeenCalledWith(true)
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
  })
})
