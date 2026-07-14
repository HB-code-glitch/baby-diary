const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export const MODAL_LAYER_BASE = 1200

interface InertLease {
  references: number
  previousInert: string | null
  previousAriaHidden: string | null
}

interface ModalBoundary {
  portalRoot: HTMLElement
  dialog: HTMLElement
  preferredFocus: () => HTMLElement | null
  isBusy: () => boolean
  onEscape: () => void
}

const inertLeases = new Map<HTMLElement, InertLease>()
const modalStack: ModalBoundary[] = []
let listenerDocument: Document | null = null
let redirectingFocus = false

function restoreAttribute(element: HTMLElement, name: string, value: string | null) {
  if (value === null) element.removeAttribute(name)
  else element.setAttribute(name, value)
}

function acquireElementInert(element: HTMLElement): () => void {
  const activeLease = inertLeases.get(element)
  if (activeLease) {
    activeLease.references += 1
  } else {
    inertLeases.set(element, {
      references: 1,
      previousInert: element.getAttribute('inert'),
      previousAriaHidden: element.getAttribute('aria-hidden'),
    })
    element.setAttribute('inert', '')
    element.setAttribute('aria-hidden', 'true')
  }

  let released = false
  return () => {
    if (released) return
    released = true
    const lease = inertLeases.get(element)
    if (!lease) return
    lease.references -= 1
    if (lease.references > 0) return
    inertLeases.delete(element)
    restoreAttribute(element, 'inert', lease.previousInert)
    restoreAttribute(element, 'aria-hidden', lease.previousAriaHidden)
  }
}

/**
 * Isolate a body-level modal portal from the whole application surface.
 * Every body sibling and semantic app shell is leased independently so nested
 * modal types cannot restore #root, app content, toasts, update banners, or an
 * older portal too early.
 */
export function acquireModalIsolation(portalRoot: HTMLElement): () => void {
  const ownerDocument = portalRoot.ownerDocument
  if (!ownerDocument.body.contains(portalRoot)) return () => undefined
  const bodySiblings = Array.from(ownerDocument.body.children)
    .filter((element): element is HTMLElement => (
      element instanceof ownerDocument.defaultView!.HTMLElement
      && element !== portalRoot
    ))
  const semanticAppShells = bodySiblings.flatMap(element => (
    Array.from(element.querySelectorAll<HTMLElement>('.app-shell'))
  ))
  const releases = Array.from(new Set([...bodySiblings, ...semanticAppShells]))
    .map(acquireElementInert)

  let released = false
  return () => {
    if (released) return
    released = true
    for (let index = releases.length - 1; index >= 0; index -= 1) releases[index]()
  }
}

function topBoundary(): ModalBoundary | undefined {
  return modalStack.at(-1)
}

function syncModalLayers() {
  const topIndex = modalStack.length - 1
  modalStack.forEach((boundary, index) => {
    const layer = MODAL_LAYER_BASE + index
    boundary.portalRoot.style.position = 'fixed'
    boundary.portalRoot.style.inset = '0'
    boundary.portalRoot.style.zIndex = String(layer)
    boundary.portalRoot.style.pointerEvents = index === topIndex ? 'auto' : 'none'
    boundary.portalRoot.dataset.modalLayer = String(layer)
  })
}

function focusableElements(boundary: ModalBoundary): HTMLElement[] {
  return Array.from(boundary.dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(element => (
      element.isConnected
      && !element.hidden
      && !element.closest('[inert]')
      && element.getAttribute('aria-hidden') !== 'true'
    ))
}

function focusElement(element: HTMLElement | null | undefined) {
  if (!element?.isConnected) return
  try {
    element.focus({ preventScroll: true })
  } catch {
    element.focus()
  }
}

function focusPreferred(boundary: ModalBoundary) {
  const preferred = boundary.preferredFocus()
  if (
    preferred?.isConnected
    && boundary.dialog.contains(preferred)
    && !preferred.matches(':disabled')
  ) {
    focusElement(preferred)
    return
  }
  focusElement(focusableElements(boundary)[0] ?? boundary.dialog)
}

function handleDocumentFocusIn(event: FocusEvent) {
  if (redirectingFocus) return
  const boundary = topBoundary()
  const target = event.target
  if (!boundary || !(target instanceof Node) || boundary.dialog.contains(target)) return
  redirectingFocus = true
  try {
    focusPreferred(boundary)
  } finally {
    redirectingFocus = false
  }
}

function handleDocumentKeyDown(event: KeyboardEvent) {
  const boundary = topBoundary()
  if (!boundary) return

  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    if (!boundary.isBusy()) boundary.onEscape()
    return
  }

  if (event.key !== 'Tab') return
  const focusable = focusableElements(boundary)
  const active = boundary.dialog.ownerDocument.activeElement
  const activeInside = active instanceof Node && boundary.dialog.contains(active)
  const eventTargetInside = event.target instanceof Node && boundary.dialog.contains(event.target)
  const first = focusable[0]
  const last = focusable.at(-1)
  let destination: HTMLElement | undefined

  if (focusable.length === 0) destination = boundary.dialog
  else if (!activeInside || !eventTargetInside) destination = event.shiftKey ? last : first
  else if (event.shiftKey && active === first) destination = last
  else if (!event.shiftKey && active === last) destination = first

  if (!destination) return
  event.preventDefault()
  event.stopPropagation()
  focusElement(destination)
}

function attachDocumentListeners(ownerDocument: Document) {
  if (listenerDocument === ownerDocument) return
  if (listenerDocument) {
    listenerDocument.removeEventListener('focusin', handleDocumentFocusIn, true)
    listenerDocument.removeEventListener('keydown', handleDocumentKeyDown, true)
  }
  listenerDocument = ownerDocument
  ownerDocument.addEventListener('focusin', handleDocumentFocusIn, true)
  ownerDocument.addEventListener('keydown', handleDocumentKeyDown, true)
}

function detachDocumentListenersIfIdle() {
  if (modalStack.length > 0 || !listenerDocument) return
  listenerDocument.removeEventListener('focusin', handleDocumentFocusIn, true)
  listenerDocument.removeEventListener('keydown', handleDocumentKeyDown, true)
  listenerDocument = null
}

export function registerModalBoundary(boundary: ModalBoundary): () => void {
  modalStack.push(boundary)
  syncModalLayers()
  attachDocumentListeners(boundary.dialog.ownerDocument)
  let released = false

  return () => {
    if (released) return
    released = true
    const index = modalStack.lastIndexOf(boundary)
    if (index < 0) return
    const wasTopmost = index === modalStack.length - 1
    modalStack.splice(index, 1)
    boundary.portalRoot.style.pointerEvents = 'none'
    delete boundary.portalRoot.dataset.modalLayer
    syncModalLayers()
    if (wasTopmost) {
      const nextBoundary = topBoundary()
      if (nextBoundary) focusPreferred(nextBoundary)
    }
    detachDocumentListenersIfIdle()
  }
}
