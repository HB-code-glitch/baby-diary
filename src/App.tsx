import React, { useEffect, useState, useCallback, Suspense, lazy } from 'react'
import { ToastProvider, useToast } from './components/Toast'
import { Sidebar, Page } from './components/Sidebar'
import { useAppStore } from './store/useAppStore'
import { useSyncLifecycle } from './sync/useSync'
import { setLanguage, initLangAttr } from './i18n'
import type { Language } from './i18n'
import i18n from './i18n'
import { TutorialTour, isTutorialDone } from './components/TutorialTour'
import { LanguagePicker, isLangChosen, markLangChosen } from './components/LanguagePicker'
import { UpdateBanner } from './components/UpdateBanner'
import { useMidnightRefresh } from './lib/useMidnightRefresh'
import { PageSkeleton } from './components/PageSkeleton'
import { ReportView } from './report/ReportView'
import { ipc } from './lib/ipc'

// HomePage is the landing view — always eager so first paint has no async gap.
import { HomePage } from './pages/HomePage'

// All other pages are lazy-loaded so they land in separate JS chunks.
const HistoryPage  = lazy(() => import('./pages/HistoryPage').then(m => ({ default: m.HistoryPage })))
const StatsPage    = lazy(() => import('./pages/StatsPage').then(m => ({ default: m.StatsPage })))
const DiaryPage    = lazy(() => import('./pages/DiaryPage').then(m => ({ default: m.DiaryPage })))
const MessagesPage = lazy(() => import('./pages/MessagesPage').then(m => ({ default: m.MessagesPage })))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })))

function PageContent({ page, onNavigate, onStartTour }: { page: Page; onNavigate: (p: Page) => void; onStartTour: () => void }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      {(() => {
        switch (page) {
          case 'home':     return <HomePage onNavigate={onNavigate} />
          case 'history':  return <HistoryPage />
          case 'stats':    return <StatsPage />
          case 'diary':    return <DiaryPage />
          case 'messages': return <MessagesPage />
          case 'settings': return <SettingsPage onStartTour={onStartTour} />
          default:         return <HomePage onNavigate={onNavigate} />
        }
      })()}
    </Suspense>
  )
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
  const saveSettings = useAppStore(s => s.saveSettings)
  const [currentPage, setCurrentPage] = useState<Page>('home')
  const [tourActive, setTourActive] = useState(false)
  // null = undecided (show picker on first launch), false = hidden, true = shown
  const [showLangPicker, setShowLangPicker] = useState<boolean>(false)

  const startTour = useCallback(() => {
    setCurrentPage('home')
    setTourActive(true)
  }, [])

  const endTour = useCallback(() => {
    setTourActive(false)
    setCurrentPage('home')
  }, [])

  // Start sync engine on mount; stop on unmount.
  // Works in both Electron (real Firebase) and browser (mock ipc, no Firebase).
  useSyncLifecycle()

  // P25: Reload events at local midnight so today-* selectors auto-refresh
  // when the calendar date rolls over (no manual reload required).
  useMidnightRefresh()

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

  // First-launch: show LanguagePicker if language not yet chosen,
  // then start tutorial. If language already chosen, go straight to tutorial.
  useEffect(() => {
    const id = setTimeout(() => {
      if (isTutorialDone()) return // neither picker nor tour needed

      if (!isLangChosen()) {
        // Show language picker first; tutorial starts after pick (see handleLangPick)
        setShowLangPicker(true)
      } else {
        // Language already picked → straight to tutorial
        setTourActive(true)
      }
    }, 300)
    return () => clearTimeout(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLangPick = useCallback(async (lang: Language) => {
    // 1. Apply language immediately so tour renders in chosen language
    setLanguage(lang)

    // 2. Persist to settings (best-effort; works in Electron, no-op in pure web)
    try {
      const current = settings ?? ({} as any)
      await saveSettings({ ...current, language: lang })
    } catch {
      // non-fatal — language is already applied in-memory
    }

    // 3. Mark as chosen so next launch skips picker
    markLangChosen()

    // 4. Hide picker and start tutorial
    setShowLangPicker(false)
    setTourActive(true)
  }, [settings, saveSettings])

  return (
    <div className="app-shell">
      <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />
      <main className="main-content">
        <PageContent page={currentPage} onNavigate={setCurrentPage} onStartTour={startTour} />
      </main>
      {showLangPicker && (
        <LanguagePicker onPick={handleLangPick} />
      )}
      {tourActive && (
        <TutorialTour
          onNavigate={setCurrentPage}
          onDone={endTour}
        />
      )}
    </div>
  )
}

/**
 * MF-06: Wrapper that loads the store before rendering ReportView.
 * After init() resolves, signals main via report:ready IPC so printToPDF
 * starts at the right moment (not after a fixed 800ms guess).
 */
function ReportRoute() {
  const init = useAppStore(s => s.init)
  const isReady = useAppStore(s => s.isReady)

  useEffect(() => {
    init().then(() => {
      ipc.reportReady()
    })
  }, [init])

  if (!isReady) return null
  return <ReportView />
}

export default function App() {
  // Hidden print window: when the app is loaded at #/report, render only
  // the print-optimized ReportView with no navigation chrome.
  if (typeof window !== 'undefined' && window.location.hash === '#/report') {
    return (
      <ToastProvider>
        <ReportRoute />
      </ToastProvider>
    )
  }

  return (
    <ToastProvider>
      <GlobalErrorBoundary />
      <AppInner />
      <UpdateBanner />
    </ToastProvider>
  )
}
