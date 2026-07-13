import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

interface ToastItem {
  id: string
  message: string
  undoLabel?: string
  onUndo?: () => void
  onTimeEdit?: () => void
  className?: string
  tone?: 'status' | 'error'
}

interface ToastContextValue {
  showToast: (opts: Omit<ToastItem, 'id'>) => void
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} })

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const { t, i18n } = useTranslation()

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const showToast = useCallback((opts: Omit<ToastItem, 'id'>) => {
    const id = Date.now().toString()
    setToasts(prev => [...prev, { ...opts, id }])
    const timer = setTimeout(() => removeToast(id), 4000)
    timers.current.set(id, timer)
  }, [removeToast])

  const clearToasts = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
    setToasts(prev => prev.length === 0 ? prev : [])
  }, [])

  useEffect(() => {
    i18n.on('languageChanged', clearToasts)
    return () => i18n.off('languageChanged', clearToasts)
  }, [clearToasts, i18n])

  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-container">
        {toasts.map(toast => {
          const isError = toast.tone === 'error' || toast.className?.split(' ').includes('toast-error')
          return (
          <div
            key={toast.id}
            className={['toast', isError ? 'toast-error' : '', toast.className].filter(Boolean).join(' ')}
            role={isError ? 'alert' : 'status'}
            aria-atomic="true"
          >
            <span>{toast.message}</span>
            {toast.onTimeEdit && (
              <button
                className="toast-btn"
                onClick={() => {
                  toast.onTimeEdit!()
                  removeToast(toast.id)
                }}
              >
                {t('toast.editTime')}
              </button>
            )}
            {toast.onUndo && (
              <button
                className="toast-btn"
                onClick={() => {
                  toast.onUndo!()
                  removeToast(toast.id)
                }}
              >
                {toast.undoLabel ?? t('toast.undo')}
              </button>
            )}
            <button
              className="toast-btn"
              style={{ opacity: 0.6 }}
              onClick={() => removeToast(toast.id)}
              aria-label={t('toast.dismiss')}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}
