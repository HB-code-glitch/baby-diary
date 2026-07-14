import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import type { FirebasePersistenceRegistry } from './store/firebasePersistenceRegistry'

type MainWindowProvider = () => BrowserWindow | null

export function registerFirebasePersistenceIPC(
  ipcMain: Pick<IpcMain, 'handle'>,
  registry: Pick<FirebasePersistenceRegistry, 'claim'>,
  getMainWindow: MainWindowProvider,
): void {
  ipcMain.handle('firebase:claimPersistence', async (
    event: IpcMainInvokeEvent,
    config: unknown,
  ) => {
    const mainWindow = getMainWindow()
    if (!mainWindow
      || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('Firebase persistence claim denied for untrusted renderer')
    }
    return registry.claim(config)
  })
}
