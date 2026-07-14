/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getEvidenceUrlById } from '../electron/healthEvidenceUrlRegistry'
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
    expect(openExternal).toHaveBeenCalledWith(getEvidenceUrlById('who-infant-feeding'))
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

  it('rejects browser fallback without importing or exposing the main-only URL registry', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const { ipc } = await import('../src/lib/ipc')

    await expect(ipc.openEvidenceSource('who-infant-feeding')).rejects.toThrow(/EVIDENCE_LINK_UNAVAILABLE/)
    expect(open).not.toHaveBeenCalled()
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
