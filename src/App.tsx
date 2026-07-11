import React, { useEffect, useState } from 'react'
import { ToastProvider, useToast } from './components/Toast'
import { Sidebar, Page } from './components/Sidebar'
import { useAppStore } from './store/useAppStore'
import { useSyncLifecycle } from './sync/useSync'
import { setLanguage, initLangAttr } from './i18n'
import i18n from './i18n'

import { HomePage }     from './pages/HomePage'
import { HistoryPage }  from './pages/HistoryPage'
import { StatsPage }    from './pages/StatsPage'
import { DiaryPage }    from './pages/DiaryPage'
import { MessagesPage } from './pages/MessagesPage'
import { SettingsPage } from './pages/SettingsPage'

function PageContent({ page, onNavigate }: { page: Page; onNavigate: (p: Page) => void }) {
  switch (page) {
    case 'home':     return <HomePage onNavigate={onNavigate} />
    case 'history':  return <HistoryPage />
    case 'stats':    return <StatsPage />
    case 'diary':    return <DiaryPage />
    case 'messages': return <MessagesPage />
    case 'settings': return <SettingsPage />
    default:         return <HomePage onNavigate={onNavigate} />
  }
}

/** Attach global unhandled error / rejection listeners so nothing is ever silent. */
function GlobalErrorBoundary() {
  const { showToast } = useToast()

  useEffect(() => {
    const handleUnhandledRejection = (e: PromiseRejectionEvent) => {
      console.error('[GlobalError] Unhandled promise rejection:', e.reason)
      // Only surface as toast if it looks like an app-level error (not a
      // benign external library rejection)
      const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? '')
      if (msg === 'append_failed') {
        showToast({ message: i18n.t('toast.saveFailed') })
      }
    }
    const handleError = (e: ErrorEvent) => {
      console.error('[GlobalError] Uncaught error:', e.error ?? e.message)
    }
    window.addEventListener('unhandledrejection', handleUnhandledRejection)
    window.addEventListener('error', handleError)
    return () => {
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
      window.removeEventListener('error', handleError)
    }
  }, [showToast])

  return null
}

/** Resolve theme setting → 'light' | 'dark', then set data-theme on <html>. */
function applyTheme(theme: 'light' | 'dark' | 'system'): void {
  let resolved: 'light' | 'dark'
  if (theme === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } else {
    resolved = theme
  }
  document.documentElement.setAttribute('data-theme', resolved)
}

function AppInner() {
  const init = useAppStore(s => s.init)
  const settings = useAppStore(s => s.settings)
  const [currentPage, setCurrentPage] = useState<Page>('home')

  // Start sync engine on mount; stop on unmount.
  // Works in both Electron (real Firebase) and browser (mock ipc, no Firebase).
  useSyncLifecycle()

  useEffect(() => {
    // Guard for non-Electron environments (e.g. vite preview, tests)
    if (typeof window !== 'undefined') {
      init()
    }
  }, [init])

  // Sync language from persisted settings whenever settings change
  useEffect(() => {
    if (settings?.language) {
      setLanguage(settings.language)
    } else {
      // Set data-lang from detected language on first load
      initLangAttr()
    }
  }, [settings?.language])

  // Apply theme whenever settings change
  useEffect(() => {
    const theme = settings?.theme ?? 'system'
    applyTheme(theme)
  }, [settings?.theme])

  // Listen for OS color-scheme changes when theme is 'system'
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      if ((settings?.theme ?? 'system') === 'system') {
        document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light')
      }
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [settings?.theme])

  return (
    <div className="app-shell">
      <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />
      <main className="main-content">
        <PageContent page={currentPage} onNavigate={setCurrentPage} />
      </main>
    </div>
  )
}

export default function App() {
  return (
    <ToastProvider>
      <GlobalErrorBoundary />
      <AppInner />
    </ToastProvider>
  )
}
