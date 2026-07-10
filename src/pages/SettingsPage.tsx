import React, { useState, useEffect } from 'react'
import { FolderOpen, Download, Info } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { ko } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { useToast } from '../components/Toast'
import { ipc } from '../lib/ipc'
import { SyncSettingsSlot } from '../components/SyncSettingsSlot'
import { AppSettings } from '../../shared/types'
import { v4 as uuidv4 } from 'uuid'

export function SettingsPage() {
  const { settings, saveSettings, loadDataInfo, dataInfo } = useAppStore()
  const { showToast } = useToast()

  // Local form state
  const [babyName,   setBabyName]   = useState(settings?.baby?.name       ?? '')
  const [birthdate,  setBirthdate]  = useState(settings?.baby?.birthdate  ?? '')
  const [myName,     setMyName]     = useState(settings?.profile?.name    ?? '')
  const [myRole,     setMyRole]     = useState<'mom' | 'dad'>(settings?.profile?.role ?? 'mom')
  const [saving, setSaving] = useState(false)

  // Sync local form when settings load
  useEffect(() => {
    if (settings) {
      setBabyName(settings.baby?.name       ?? '')
      setBirthdate(settings.baby?.birthdate ?? '')
      setMyName(settings.profile?.name      ?? '')
      setMyRole(settings.profile?.role      ?? 'mom')
    }
  }, [settings])

  useEffect(() => {
    loadDataInfo()
  }, [])

  const handleSave = async () => {
    setSaving(true)
    const updated: AppSettings = {
      baby: {
        name:      babyName.trim(),
        birthdate: birthdate,
      },
      profile: {
        uid:  settings?.profile?.uid ?? uuidv4(),
        name: myName.trim(),
        role: myRole,
      },
      familyId: settings?.familyId ?? '',  // F8: never fabricate a familyId — only create/join flow sets this
      firebase:  settings?.firebase  ?? null,
    }
    await saveSettings(updated)
    setSaving(false)
    showToast({ message: '설정이 저장되었습니다.' })
  }

  const handleExportJson = async () => {
    try {
      await ipc.exportData('json')
      showToast({ message: 'JSON 파일이 내보내기되었습니다.' })
    } catch {
      showToast({ message: '내보내기에 실패했습니다.' })
    }
  }

  const handleExportCsv = async () => {
    try {
      await ipc.exportData('csv')
      showToast({ message: 'CSV 파일이 내보내기되었습니다.' })
    } catch {
      showToast({ message: '내보내기에 실패했습니다.' })
    }
  }

  const handleOpenBackup = async () => {
    try {
      await ipc.openBackupFolder()
    } catch {
      showToast({ message: '폴더를 열 수 없습니다.' })
    }
  }

  return (
    <div className="page-container" style={{ maxWidth: 560 }}>
      <div className="page-header">
        <div className="page-title">설정</div>
      </div>

      {/* Baby info */}
      <div className="settings-section">
        <div className="settings-section-title">아기 정보</div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="label">아기 이름</div>
            <input
              type="text"
              className="input-field"
              placeholder="아기 이름"
              value={babyName}
              onChange={e => setBabyName(e.target.value)}
            />
          </div>
          <div>
            <div className="label">생일</div>
            <input
              type="date"
              className="input-field"
              value={birthdate}
              onChange={e => setBirthdate(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* My profile */}
      <div className="settings-section">
        <div className="settings-section-title">내 프로필</div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="label">이름</div>
            <input
              type="text"
              className="input-field"
              placeholder="이름"
              value={myName}
              onChange={e => setMyName(e.target.value)}
            />
          </div>
          <div>
            <div className="label">역할</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className={`role-btn${myRole === 'mom' ? ' selected' : ''}`}
                onClick={() => setMyRole('mom')}
              >
                엄마
              </button>
              <button
                className={`role-btn${myRole === 'dad' ? ' selected' : ''}`}
                onClick={() => setMyRole('dad')}
              >
                아빠
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Save button */}
      <div style={{ marginBottom: 24 }}>
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving}
          style={{ width: '100%', padding: '11px' }}
        >
          {saving ? '저장 중...' : '설정 저장'}
        </button>
      </div>

      {/* Data section */}
      <div className="settings-section">
        <div className="settings-section-title">데이터</div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {dataInfo && (
            <>
              <div className="settings-row">
                <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>총 기록 수</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-800)' }}>
                  {dataInfo.eventCount}개
                </span>
              </div>
              <div className="settings-row">
                <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>마지막 백업</span>
                <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>
                  {dataInfo.lastBackupTime
                    ? format(parseISO(dataInfo.lastBackupTime), 'M월 d일 HH:mm', { locale: ko })
                    : '없음'}
                </span>
              </div>
            </>
          )}
          <div className="settings-row">
            <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>백업 폴더</span>
            <button
              className="btn-secondary"
              style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}
              onClick={handleOpenBackup}
            >
              <FolderOpen size={13} />
              열기
            </button>
          </div>
          <div className="settings-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>데이터 내보내기</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="btn-secondary"
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}
                onClick={handleExportJson}
              >
                <Download size={13} />
                JSON
              </button>
              <button
                className="btn-secondary"
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}
                onClick={handleExportCsv}
              >
                <Download size={13} />
                CSV
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Sync section */}
      <div className="settings-section">
        <div className="settings-section-title">가족 동기화</div>
        <SyncSettingsSlot />
      </div>
    </div>
  )
}
