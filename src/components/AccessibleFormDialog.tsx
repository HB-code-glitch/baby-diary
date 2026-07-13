import React, { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { acquireModalIsolation, registerModalBoundary } from '../lib/modalIsolation'

interface AccessibleFormDialogProps {
  modalName: 'diary' | 'messages'
  titleId: string
  descriptionId?: string
  busy: boolean
  initialFocusRef: RefObject<HTMLElement>
  onClose: () => void
  onSubmit: () => void
  className?: string
  children: React.ReactNode
}

export function AccessibleFormDialog({
  modalName,
  titleId,
  descriptionId,
  busy,
  initialFocusRef,
  onClose,
  onSubmit,
  className = '',
  children,
}: AccessibleFormDialogProps) {
  const dialogRef = useRef<HTMLFormElement | null>(null)
  const busyRef = useRef(busy)
  const onCloseRef = useRef(onClose)
  const restoreFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  )
  const [portalRoot] = useState<HTMLElement | null>(() => {
    if (typeof document === 'undefined') return null
    const root = document.createElement('div')
    root.dataset.modalPortal = 'editor'
    root.dataset.modalName = modalName
    return root
  })

  busyRef.current = busy
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!portalRoot || !dialog) return
    document.body.appendChild(portalRoot)
    const releaseIsolation = acquireModalIsolation(portalRoot)
    const unregisterBoundary = registerModalBoundary({
      portalRoot,
      dialog,
      preferredFocus: () => initialFocusRef.current,
      isBusy: () => busyRef.current,
      onEscape: () => onCloseRef.current(),
    })
    initialFocusRef.current?.focus({ preventScroll: true })

    return () => {
      releaseIsolation()
      unregisterBoundary()
      portalRoot.remove()
      const trigger = restoreFocusRef.current
      if (trigger?.isConnected && !trigger.closest('[inert]')) {
        trigger.focus({ preventScroll: true })
      }
    }
  }, [initialFocusRef, portalRoot])

  useEffect(() => {
    if (busy) dialogRef.current?.focus({ preventScroll: true })
  }, [busy])

  const close = () => {
    if (!busy) onClose()
  }

  const overlay = (
    <div
      className="editor-modal-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <form
        ref={dialogRef}
        data-editor-modal={modalName}
        className={`editor-modal-dialog ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onSubmit={event => {
          event.preventDefault()
          if (!busy) onSubmit()
        }}
      >
        {children}
      </form>
    </div>
  )

  return portalRoot ? createPortal(overlay, portalRoot) : overlay
}
