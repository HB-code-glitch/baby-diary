import type { BrowserWindow, Session, WebContents } from 'electron'

type TrustedRenderer = {
  webContents: WebContents
  entryUrl: string
}

const trustedRenderersBySession = new WeakMap<Session, Set<TrustedRenderer>>()

function isTrustedRendererUrl(candidate: string | undefined, entryUrl: string): boolean {
  if (!candidate) return false

  try {
    const requested = new URL(candidate)
    const trusted = new URL(entryUrl)

    if (requested.protocol !== trusted.protocol) return false
    if (requested.protocol === 'file:') {
      return requested.host === trusted.host && requested.pathname === trusted.pathname
    }

    return requested.origin === trusted.origin && requested.pathname === trusted.pathname
  } catch {
    return false
  }
}

function getTrustedRenderer(
  renderers: Set<TrustedRenderer>,
  webContents: WebContents | null,
): TrustedRenderer | undefined {
  if (!webContents) return undefined
  let match: TrustedRenderer | undefined
  renderers.forEach(renderer => {
    if (renderer.webContents === webContents) match = renderer
  })
  return match
}

function installPermissionPolicy(session: Session, renderers: Set<TrustedRenderer>): void {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const renderer = getTrustedRenderer(renderers, webContents)
    const requestingUrl = 'requestingUrl' in details ? details.requestingUrl : undefined
    const allowTrustedClipboardWrite = permission === 'clipboard-sanitized-write'
      && renderer !== undefined
      && details.isMainFrame
      && isTrustedRendererUrl(requestingUrl, renderer.entryUrl)

    callback(allowTrustedClipboardWrite)
  })

  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const renderer = getTrustedRenderer(renderers, webContents)
    if (permission !== 'clipboard-sanitized-write' || !renderer || !details.isMainFrame) return false

    const requestingUrl = details.requestingUrl ?? requestingOrigin
    const requesterIsTrusted = isTrustedRendererUrl(requestingUrl, renderer.entryUrl)
    const embedderIsTrusted = details.embeddingOrigin === undefined
      || isTrustedRendererUrl(details.embeddingOrigin, renderer.entryUrl)

    return requesterIsTrusted && embedderIsTrusted
  })
}

/**
 * Applies the renderer boundary shared by every application BrowserWindow.
 * Programmatic loadURL/loadFile calls do not emit will-navigate, so startup and
 * report rendering continue to work while page-initiated navigation is denied.
 */
export function hardenBrowserWindow(window: BrowserWindow, entryUrl: string): void {
  const { webContents } = window

  webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  webContents.on('will-navigate', event => {
    event.preventDefault()
  })

  let trustedRenderers = trustedRenderersBySession.get(webContents.session)
  if (!trustedRenderers) {
    trustedRenderers = new Set()
    trustedRenderersBySession.set(webContents.session, trustedRenderers)
    installPermissionPolicy(webContents.session, trustedRenderers)
  }

  const renderer: TrustedRenderer = { webContents, entryUrl }
  trustedRenderers.add(renderer)
  webContents.once('destroyed', () => {
    trustedRenderers?.delete(renderer)
  })
}
