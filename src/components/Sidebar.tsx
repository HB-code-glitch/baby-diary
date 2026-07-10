import React from 'react'
import { Home, List, BarChart2, BookOpen, Mail, Settings } from 'lucide-react'
import { useAppStore, getDDay } from '../store/useAppStore'

export type Page = 'home' | 'history' | 'stats' | 'diary' | 'messages' | 'settings'

interface NavItem {
  id: Page
  label: string
  icon: React.ElementType
}

const NAV_ITEMS: NavItem[] = [
  { id: 'home',     label: '오늘',     icon: Home },
  { id: 'history',  label: '기록',     icon: List },
  { id: 'stats',    label: '통계',     icon: BarChart2 },
  { id: 'diary',    label: '일기',     icon: BookOpen },
  { id: 'messages', label: '아기에게', icon: Mail },
  { id: 'settings', label: '설정',     icon: Settings },
]

interface SidebarProps {
  currentPage: Page
  onNavigate: (page: Page) => void
}

export function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const settings = useAppStore(s => s.settings)

  const babyName = settings?.baby?.name || '아기'
  const birthdate = settings?.baby?.birthdate
  const dday = birthdate ? getDDay(birthdate) : null

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">Baby Diary</div>
        <div className="sidebar-baby-name">{babyName}</div>
        {dday != null ? (
          <div className="sidebar-dday">D+{dday}일</div>
        ) : (
          <div className="sidebar-dday" style={{ opacity: 0.5 }}>생일을 설정해주세요</div>
        )}
      </div>

      <div className="sidebar-nav">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`nav-item${currentPage === id ? ' active' : ''}`}
            onClick={() => onNavigate(id)}
          >
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
