import React from 'react'
import { IconHome, IconCalendar, IconChart, IconBook, IconMail, IconGear } from './icons'
import { useAppStore, getDDay } from '../store/useAppStore'
import { useTranslation } from 'react-i18next'

export type Page = 'home' | 'history' | 'stats' | 'diary' | 'messages' | 'settings'

interface NavItem {
  id: Page
  labelKey: string
  Icon: React.ComponentType<{ size?: number; color?: string }>
}

const NAV_ITEMS: NavItem[] = [
  { id: 'home',     labelKey: 'nav.home',     Icon: IconHome },
  { id: 'history',  labelKey: 'nav.history',  Icon: IconCalendar },
  { id: 'stats',    labelKey: 'nav.stats',    Icon: IconChart },
  { id: 'diary',    labelKey: 'nav.diary',    Icon: IconBook },
  { id: 'messages', labelKey: 'nav.messages', Icon: IconMail },
  { id: 'settings', labelKey: 'nav.settings', Icon: IconGear },
]

interface SidebarProps {
  currentPage: Page
  onNavigate: (page: Page) => void
}

/** Warm palette pairs: [bg, text] using CSS hex values */
const WARM_PALETTE: [string, string][] = [
  ['#e0edd9', '#3d7535'], // sage
  ['#fde8df', '#c55c30'], // peach
  ['#fef0cd', '#b07208'], // amber
  ['#fde3e8', '#d44060'], // rose
  ['#faf0d0', '#8c6a1a'], // warm sand
]

/** Deterministic warm color pair from name string */
function nameToWarmPair(name: string): [string, string] {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return WARM_PALETTE[Math.abs(hash) % WARM_PALETTE.length]
}

export function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const settings = useAppStore(s => s.settings)
  const { t } = useTranslation()

  const babyName = settings?.baby?.name || t('sidebar.defaultBabyName')
  const birthdate = settings?.baby?.birthdate
  const dday = birthdate ? getDDay(birthdate) : null

  const initial = babyName.charAt(0).toUpperCase()
  const [avatarBg, avatarFg] = nameToWarmPair(babyName)

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        {/* Baby avatar circle */}
        <div
          className="sidebar-avatar"
          style={{
            background: avatarBg,
            color: avatarFg,
          }}
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
        {NAV_ITEMS.map(({ id, labelKey, Icon }) => (
          <button
            key={id}
            className={`nav-item${currentPage === id ? ' active' : ''}`}
            onClick={() => onNavigate(id)}
          >
            <Icon
              size={16}
              color={currentPage === id ? 'var(--stone-700)' : 'var(--stone-500)'}
            />
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
