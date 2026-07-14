import React, { useEffect, useState, useCallback, useRef, Suspense, lazy } from 'react'
import { ToastProvider, useToast } from './components/Toast'
import { Sidebar, Page } from './components/Sidebar'
import { useAppStore } from './store/useAppStore'
import { useSyncLifecycle } from './sync/useSync'
import { setLanguage, initLangAttr } from './i18n'
import type { Language } from './i18n'
import i18n from './i18n'
import { TutorialTour } from './components/TutorialTour'
import { shouldAutoStartTutorial, type TutorialExitReason } from './lib/tutorial'
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
  const isReady = useAppStore(s => s.isReady)
  const [currentPage, setCurrentPage] = useState<Page>('home')
  const [tourActive, setTourActive] = useState(false)
  const tourOriginPage = useRef<Page>('home')
  const tourOriginFocus = useRef<HTMLElement | null>(null)
  // null = undecided (show picker on first launch), false = hidden, true = shown
  const [showLangPicker, setShowLangPicker] = useState<boolean>(false)
  const tutorialLaunchDecided = useRef(false)
  const languagePickInFlight = useRef(false)

  const startTour = useCallback(() => {
    tourOriginPage.current = currentPage
    tourOriginFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    setCurrentPage('home')
    setTourActive(true)
  }, [currentPage])

  const endTour = useCallback((reason: TutorialExitReason) => {
    const originPage = tourOriginPage.current
    const originFocus = tourOriginFocus.current
    setTourActive(false)
    setCurrentPage(reason === 'completed' ? 'home' : originPage)
    requestAnimationFrame(() => {
      if (originFocus?.isConnected) {
        originFocus.focus()
      } else if (reason === 'skipped' && originPage === 'settings') {
        document.querySelector<HTMLElement>('[data-tutorial-replay]')?.focus()
      }
    })
  }, [])

  // Start sync engine on mount; stop on unmount.
  // Works in both Electron (real Firebase) and browser (mock ipc, no Firebase).
  useSyncLifecycle()

  // P25: Reload events at local midnight so today-* selectors auto-refresh
  // when the calendar date rolls over (no manual reload required).
  useMidnightRefresh()

  // RC1/RC2: Re-fetch settings from disk on window focus and every 60s while visible.
  // This ensures external writes (other renderer windows, sync engine adopt paths)
  // are adopted into the store before any subsequent renderer save — preventing
  // a stale in-memory snapshot from overwriting a newer disk value.
  const loadSettings = useAppStore(s => s.loadSettings)
  useEffect(() => {
    const onFocus = () => { void loadSettings() }
    window.addEventListener('focus', onFocus)

    const intervalId = setInterval(() => {
      if (!document.hidden) void loadSettings()
    }, 60_000)

    return () => {
      window.removeEventListener('focus', onFocus)
      clearInterval(intervalId)
    }
  }, [loadSettings])

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

  // Decide the first-launch flow only after settings hydration. A time-based
  // decision can race a slow disk/IPC read and show the picker to an existing
  // user before their persisted language arrives.
  useEffect(() => {
    if (!isReady || tutorialLaunchDecided.current) return
    tutorialLaunchDecided.current = true
    if (!shouldAutoStartTutorial()) return

    // A persisted language is authoritative even when the old localStorage
    // marker is absent (for example after an app-data migration).
    if (!settings?.language) {
      if (!isLangChosen()) {
        setShowLangPicker(true)
        return
      }

      // Older builds could leave only a boolean marker when the full settings
      // write failed. Recover that legacy state without showing the picker
      // again, and migrate the detected active language through the merge API.
      const legacyLanguage: Language = i18n.language === 'ja' ? 'ja' : 'ko'
      setLanguage(legacyLanguage)
      useAppStore.setState(state => ({
        settings: state.settings
          ? { ...state.settings, language: legacyLanguage }
          : state.settings,
      }))
      void ipc.mergeSettings({ language: legacyLanguage }).catch(() => {
        // Keep the local marker so another launch retries this idempotent merge.
      })
    }

    tourOriginPage.current = 'home'
    setCurrentPage('home')
    setTourActive(true)
  }, [isReady, settings?.language])

  const handleLangPick = useCallback(async (lang: Language) => {
    if (languagePickInFlight.current) return
    languagePickInFlight.current = true

    // 1. Apply language immediately so tour renders in chosen language
    setLanguage(lang)

    // Keep the renderer snapshot aligned immediately, while preserving every
    // hydrated field that may have been written by family sync.
    useAppStore.setState(state => ({
      settings: state.settings
        ? { ...state.settings, language: lang }
        : state.settings,
    }))

    // 2. Persist only the field owned by this picker. The main-process merge
    // re-reads the authoritative file, so a stale renderer cannot overwrite
    // baby/profile/family data written during startup.
    try {
      await ipc.mergeSettings({ language: lang })
      markLangChosen()
    } catch {
      // Non-fatal for this session. Do not mark the choice as durable so the
      // picker retries persistence on the next launch.
    }

    // 3. Hide picker and start tutorial even if the disk is temporarily
    // unavailable; the in-memory language and store already agree.
    setShowLangPicker(false)
    startTour()
  }, [startTour])

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
          onExit={endTour}
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
