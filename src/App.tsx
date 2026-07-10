import React, { useEffect, useState } from 'react'
import { ToastProvider } from './components/Toast'
import { Sidebar, Page } from './components/Sidebar'
import { useAppStore } from './store/useAppStore'
import { useSyncLifecycle } from './sync/useSync'

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

function AppInner() {
  const init = useAppStore(s => s.init)
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
      <AppInner />
    </ToastProvider>
  )
}
