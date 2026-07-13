import { getEvidenceSourceById } from '../shared/healthEvidence'

export const EVIDENCE_SOURCE_OPEN_CHANNEL = 'evidence:openSource' as const

interface IpcMainHandleLike {
  handle: (channel: string, handler: (_event: unknown, payload: unknown) => unknown) => void
}

export function registerEvidenceExternalLinkIPC(
  ipcMain: IpcMainHandleLike,
  openExternal: (url: string) => Promise<unknown>,
): void {
  ipcMain.handle(EVIDENCE_SOURCE_OPEN_CHANNEL, async (_event, payload) => {
    if (typeof payload !== 'string') {
      throw new Error('Unknown health evidence source')
    }

    const source = getEvidenceSourceById(payload)
    if (!source) {
      throw new Error('Unknown health evidence source')
    }

    await openExternal(source.url)
  })
}
