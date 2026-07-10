import React, { createContext, useContext, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'

interface ToastItem {
  id: string
  message: string
  undoLabel?: string
  onUndo?: () => void
  onTimeEdit?: () => void
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
  const { t } = useTranslation()

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

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-container">
        {toasts.map(toast => (
          <div key={toast.id} className="toast">
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
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
