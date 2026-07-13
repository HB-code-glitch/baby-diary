/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getEvidenceSourceById } from '../shared/healthEvidence'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

type MainBridgeModule = typeof import('../electron/evidenceExternalLink')

async function loadMainBridge(): Promise<MainBridgeModule> {
  const loaded = await import('../electron/evidenceExternalLink').catch(() => ({}))
  expect(loaded).toHaveProperty('registerEvidenceExternalLinkIPC')
  return loaded as MainBridgeModule
}

describe('evidence external-link IPC boundary', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    delete (window as any).babyDiary
  })

  it('carries an exact source ID through preload and resolves the URL only in main', async () => {
    const { EVIDENCE_SOURCE_OPEN_CHANNEL, registerEvidenceExternalLinkIPC } = await loadMainBridge()
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const openExternal = vi.fn(async () => undefined)
    registerEvidenceExternalLinkIPC({
      handle: (channel, handler) => handlers.set(channel, handler),
    }, openExternal)

    let exposedApi: any
    const invoke = vi.fn(async (channel: string, payload: unknown) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`Missing handler: ${channel}`)
      return handler({}, payload)
    })
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: (_key: string, api: unknown) => { exposedApi = api } },
      ipcRenderer: {
        invoke,
        on: vi.fn(),
        removeListener: vi.fn(),
        send: vi.fn(),
      },
    }))

    await import('../electron/preload')
    await exposedApi.openEvidenceSource('who-infant-feeding')

    expect(invoke).toHaveBeenCalledWith(EVIDENCE_SOURCE_OPEN_CHANNEL, 'who-infant-feeding')
    expect(openExternal).toHaveBeenCalledWith(getEvidenceSourceById('who-infant-feeding')?.url)
  })

  it.each([
    'https://www.who.int/news-room/fact-sheets/detail/infant-and-young-child-feeding',
    'who-infant-feeding/',
    'WHO-INFANT-FEEDING',
  ])('rejects URL-shaped, lookalike, and unknown payloads: %s', async payload => {
    const { registerEvidenceExternalLinkIPC } = await loadMainBridge()
    const handlers = new Map<string, (...args: any[]) => unknown>()
    const openExternal = vi.fn(async () => undefined)
    registerEvidenceExternalLinkIPC({ handle: (channel, handler) => handlers.set(channel, handler) }, openExternal)
    const handler = [...handlers.values()][0]

    await expect(handler({}, payload)).rejects.toThrow(/source/i)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('uses the same immutable registry for browser fallback and never accepts a URL', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { ipc } = await import('../src/lib/ipc')

    await ipc.openEvidenceSource('who-infant-feeding')
    expect(open).toHaveBeenCalledWith(
      getEvidenceSourceById('who-infant-feeding')?.url,
      '_blank',
      'noopener,noreferrer',
    )

    open.mockClear()
    await expect(ipc.openEvidenceSource('https://example.com' as any)).rejects.toThrow(/source/i)
    expect(open).not.toHaveBeenCalled()
  })

  it('keeps the sandboxed preload free of relative runtime imports', () => {
    const preloadSource = readFileSync(resolve(process.cwd(), 'electron/preload.ts'), 'utf8')
    const relativeRuntimeImports = preloadSource
      .split(/\r?\n/)
      .filter(line => /^import (?!type\b).* from ['"]\.\//.test(line.trim()))

    expect(relativeRuntimeImports).toEqual([])
  })
})
