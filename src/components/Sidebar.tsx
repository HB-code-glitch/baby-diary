import React from 'react'
import { IconHome, IconCalendar, IconChart, IconBook, IconMail, IconGear } from './icons'
import { useAppStore, getDDay } from '../store/useAppStore'
import { useTranslation } from 'react-i18next'

export type Page = 'home' | 'history' | 'stats' | 'diary' | 'messages' | 'settings'

interface NavItem {
  id: Page
  labelKey: string
  Icon: React.ComponentType<{ size?: number; color?: string }>
  badgeKeys?: ('today' | 'history')
}

const NAV_ITEMS: NavItem[] = [
  { id: 'home',     labelKey: 'nav.home',     Icon: IconHome,     badgeKeys: 'today' },
  { id: 'history',  labelKey: 'nav.history',  Icon: IconCalendar, badgeKeys: 'history' },
  { id: 'stats',    labelKey: 'nav.stats',    Icon: IconChart },
  { id: 'diary',    labelKey: 'nav.diary',    Icon: IconBook },
  { id: 'messages', labelKey: 'nav.messages', Icon: IconMail },
  { id: 'settings', labelKey: 'nav.settings', Icon: IconGear },
]

interface SidebarProps {
  currentPage: Page
  onNavigate: (page: Page) => void
}

/** Warm palette pairs: [bg, text] */
const WARM_PALETTE: [string, string][] = [
  ['#e3f3e9', '#1d6636'], // mint
  ['#fde9e4', '#a83320'], // blush
  ['#fbf3d8', '#7a5f10'], // butter
  ['#e7eef8', '#1a4a8a'], // sky
  ['#e8f0e0', '#3a5e28'], // sage
]

function nameToWarmPair(name: string): [string, string] {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return WARM_PALETTE[Math.abs(hash) % WARM_PALETTE.length]
}

export function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const settings = useAppStore(s => s.settings)
  const todayCount = useAppStore(s => s.todayEvents().length)
  const { t } = useTranslation()

  const babyName = settings?.baby?.name || t('sidebar.defaultBabyName')
  const birthdate = settings?.baby?.birthdate
  const dday = birthdate ? getDDay(birthdate) : null

  const initial = babyName.charAt(0).toUpperCase()
  const [avatarBg, avatarFg] = nameToWarmPair(babyName)

  return (
    <nav className="sidebar" data-tour="navigation">
      <div className="sidebar-header">
        {/* Wordmark */}
        <div className="sidebar-logo">Baby Diary</div>

        {/* Baby avatar circle */}
        <div
          className="sidebar-avatar"
          style={{ background: avatarBg, color: avatarFg }}
          aria-hidden="true"
        >
          {initial}
        </div>
        <div className="sidebar-baby-name">{babyName}</div>
        {dday != null ? (
          <div className="sidebar-dday">{t('dday', { days: dday })}</div>
        ) : (
          <div className="sidebar-dday" style={{ opacity: 0.5 }}>{t('sidebar.birthdatePlaceholder')}</div>
        )}
      </div>

      <div className="sidebar-nav">
        {NAV_ITEMS.map(({ id, labelKey, Icon, badgeKeys }) => {
          const isActive = currentPage === id
          // Show count badge on 오늘(home) and 기록(history) items
          const badge = badgeKeys === 'today' && todayCount > 0
            ? todayCount
            : null

          return (
            <button
              key={id}
              className={`nav-item${isActive ? ' active' : ''}`}
              onClick={() => onNavigate(id)}
              data-tour={`nav-${id}`}
            >
              <Icon
                size={18}
                color={isActive ? '#ffffff' : 'var(--text-secondary)'}
              />
              <span>{t(labelKey)}</span>
              {badge != null && (
                <span className="nav-badge">{badge}</span>
              )}
            </button>
          )
        })}
      </div>
    </nav>
  )
}
