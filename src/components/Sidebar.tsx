import React from 'react'
import { Home, List, BarChart2, BookOpen, Mail, Settings } from 'lucide-react'
import { useAppStore, getDDay } from '../store/useAppStore'
import { useTranslation } from 'react-i18next'

export type Page = 'home' | 'history' | 'stats' | 'diary' | 'messages' | 'settings'

interface NavItem {
  id: Page
  labelKey: string
  icon: React.ElementType
}

const NAV_ITEMS: NavItem[] = [
  { id: 'home',     labelKey: 'nav.home',     icon: Home },
  { id: 'history',  labelKey: 'nav.history',  icon: List },
  { id: 'stats',    labelKey: 'nav.stats',    icon: BarChart2 },
  { id: 'diary',    labelKey: 'nav.diary',    icon: BookOpen },
  { id: 'messages', labelKey: 'nav.messages', icon: Mail },
  { id: 'settings', labelKey: 'nav.settings', icon: Settings },
]

interface SidebarProps {
  currentPage: Page
  onNavigate: (page: Page) => void
}

export function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const settings = useAppStore(s => s.settings)
  const { t } = useTranslation()

  const babyName = settings?.baby?.name || t('sidebar.defaultBabyName')
  const birthdate = settings?.baby?.birthdate
  const dday = birthdate ? getDDay(birthdate) : null

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">Baby Diary</div>
        <div className="sidebar-baby-name">{babyName}</div>
        {dday != null ? (
          <div className="sidebar-dday">{t('dday', { days: dday })}</div>
        ) : (
          <div className="sidebar-dday" style={{ opacity: 0.5 }}>{t('sidebar.birthdatePlaceholder')}</div>
        )}
      </div>

      <div className="sidebar-nav">
        {NAV_ITEMS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item${currentPage === id ? ' active' : ''}`}
            onClick={() => onNavigate(id)}
          >
            <Icon />
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
