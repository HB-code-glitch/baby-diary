import React, { useState, useEffect } from 'react'
import { IconFolderOpen, IconDownload, IconInfo } from '../components/icons'
import { GUIDANCE_MARKERS, GUIDANCE_DISCLAIMER } from '../lib/guidance'
import { format, parseISO } from 'date-fns'
import { ko } from 'date-fns/locale'
import { ja } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { useToast } from '../components/Toast'
import { ipc } from '../lib/ipc'
import { SyncSettingsSlot } from '../components/SyncSettingsSlot'
import { AppSettings } from '../../shared/types'
import { v4 as uuidv4 } from 'uuid'
import { useTranslation } from 'react-i18next'
import { setLanguage, Language } from '../i18n'
import { DeleteAllModal } from '../components/DeleteAllModal'

interface SettingsPageProps {
  onStartTour?: () => void
}

export function SettingsPage({ onStartTour }: SettingsPageProps) {
  const { settings, saveSettings, loadDataInfo, dataInfo, softDeleteAllEvents } = useAppStore()
  const { showToast } = useToast()
  const { t, i18n: i18nInstance } = useTranslation()

  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko

  // Local form state
  const [babyName,   setBabyName]   = useState(settings?.baby?.name       ?? '')
  const [birthdate,  setBirthdate]  = useState(settings?.baby?.birthdate  ?? '')
  const [babyGender, setBabyGender] = useState<'girl' | 'boy' | undefined>(settings?.baby?.gender)
  const [myName,     setMyName]     = useState(settings?.profile?.name    ?? '')
  const [myRole,     setMyRole]     = useState<'mom' | 'dad'>(settings?.profile?.role ?? 'mom')
  const [saving, setSaving] = useState(false)
  const [currentTheme, setCurrentTheme] = useState<'light' | 'dark' | 'system'>(settings?.theme ?? 'system')
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)

  // Sync local form when settings load
  useEffect(() => {
    if (settings) {
      setBabyName(settings.baby?.name       ?? '')
      setBirthdate(settings.baby?.birthdate ?? '')
      setBabyGender(settings.baby?.gender)
      setMyName(settings.profile?.name      ?? '')
      setMyRole(settings.profile?.role      ?? 'mom')
      setCurrentTheme(settings.theme        ?? 'system')
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
        gender:    babyGender,
      },
      profile: {
        uid:  settings?.profile?.uid ?? uuidv4(),
        name: myName.trim(),
        role: myRole,
      },
      familyId: settings?.familyId ?? '',  // F8: never fabricate a familyId — only create/join flow sets this
      firebase:  settings?.firebase  ?? null,
      language:  (i18nInstance.language as Language) ?? 'ko',
      theme:     currentTheme,
    }
    await saveSettings(updated)
    setSaving(false)
    showToast({ message: t('settings.toastSaved') })
  }

  const handleLanguageChange = async (lang: Language) => {
    setLanguage(lang)
    // Persist immediately
    const updated: AppSettings = {
      baby:     settings?.baby     ?? { name: '', birthdate: '' },
      profile:  settings?.profile  ?? { uid: uuidv4(), name: '', role: 'mom' },
      familyId: settings?.familyId ?? '',
      firebase:  settings?.firebase  ?? null,
      language:  lang,
      theme:     currentTheme,
    }
    await saveSettings(updated)
  }

  const handleThemeChange = async (theme: 'light' | 'dark' | 'system') => {
    setCurrentTheme(theme)
    // Apply instantly via data-theme
    let resolved: 'light' | 'dark'
    if (theme === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } else {
      resolved = theme
    }
    document.documentElement.setAttribute('data-theme', resolved)
    // Persist immediately
    const updated: AppSettings = {
      baby:     settings?.baby     ?? { name: '', birthdate: '' },
      profile:  settings?.profile  ?? { uid: uuidv4(), name: '', role: 'mom' },
      familyId: settings?.familyId ?? '',
      firebase:  settings?.firebase  ?? null,
      language:  (i18nInstance.language as Language) ?? 'ko',
      theme,
    }
    await saveSettings(updated)
  }

  const handleExportJson = async () => {
    try {
      await ipc.exportData('json')
      showToast({ message: t('settings.toastExportJson') })
    } catch (err) {
      if (err instanceof Error && err.message === 'ELECTRON_ONLY') {
        showToast({ message: t('settings.electronOnly') })
      } else {
        showToast({ message: t('settings.toastExportFail') })
      }
    }
  }

  const handleExportCsv = async () => {
    try {
      await ipc.exportData('csv')
      showToast({ message: t('settings.toastExportCsv') })
    } catch (err) {
      if (err instanceof Error && err.message === 'ELECTRON_ONLY') {
        showToast({ message: t('settings.electronOnly') })
      } else {
        showToast({ message: t('settings.toastExportFail') })
      }
    }
  }

  const handleDeleteAll = async () => {
    setDeletingAll(true)
    try {
      const count = await softDeleteAllEvents()
      setShowDeleteAllModal(false)
      showToast({ message: t('settings.deleteAllToastSuccess', { count }) })
      await loadDataInfo()
    } catch {
      showToast({ message: t('settings.deleteAllToastPartial', { count: 0 }) })
    } finally {
      setDeletingAll(false)
    }
  }

  const handleOpenBackup = async () => {
    try {
      await ipc.openBackupFolder()
    } catch (err) {
      if (err instanceof Error && err.message === 'ELECTRON_ONLY') {
        showToast({ message: t('settings.electronOnly') })
      } else {
        showToast({ message: t('settings.toastOpenFolderFail') })
      }
    }
  }

  const currentLang = i18nInstance.language as Language

  return (
    <div className="page-container" style={{ maxWidth: 560 }} data-tour="settings-main">
      <div className="page-header">
        <div className="page-title">{t('settings.title')}</div>
      </div>

      {/* Language section — always at top, labels in own language */}
      <div className="settings-section">
        <div className="settings-section-title">{t('settings.language')}</div>
        <div className="card">
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className={`role-btn${currentLang === 'ko' ? ' selected' : ''}`}
              onClick={() => handleLanguageChange('ko')}
              lang="ko"
            >
              한국어
            </button>
            <button
              className={`role-btn${currentLang === 'ja' ? ' selected' : ''}`}
              onClick={() => handleLanguageChange('ja')}
              lang="ja"
            >
              日本語
            </button>
          </div>
        </div>
      </div>

      {/* Theme section */}
      <div className="settings-section">
        <div className="settings-section-title">{t('settings.theme')}</div>
        <div className="card">
          <div className="toggle-group">
            <button
              className={`toggle-btn${currentTheme === 'light' ? ' active' : ''}`}
              onClick={() => handleThemeChange('light')}
            >
              {t('settings.themeLight')}
            </button>
            <button
              className={`toggle-btn${currentTheme === 'dark' ? ' active' : ''}`}
              onClick={() => handleThemeChange('dark')}
            >
              {t('settings.themeDark')}
            </button>
            <button
              className={`toggle-btn${currentTheme === 'system' ? ' active' : ''}`}
              onClick={() => handleThemeChange('system')}
            >
              {t('settings.themeSystem')}
            </button>
          </div>
        </div>
      </div>

      {/* Baby info */}
      <div className="settings-section">
        <div className="settings-section-title">{t('settings.babyInfo')}</div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="label">{t('settings.babyName')}</div>
            <input
              type="text"
              className="input-field"
              placeholder={t('settings.babyNamePlaceholder')}
              value={babyName}
              onChange={e => setBabyName(e.target.value)}
            />
          </div>
          <div>
            <div className="label">{t('settings.birthdate')}</div>
            <input
              type="date"
              className="input-field"
              value={birthdate}
              onChange={e => setBirthdate(e.target.value)}
            />
          </div>
          <div>
            <div className="label">{t('settings.babyGender')}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className={`role-btn${babyGender === 'girl' ? ' selected' : ''}`}
                onClick={() => setBabyGender(babyGender === 'girl' ? undefined : 'girl')}
                type="button"
              >
                {t('settings.genderGirl')}
              </button>
              <button
                className={`role-btn${babyGender === 'boy' ? ' selected' : ''}`}
                onClick={() => setBabyGender(babyGender === 'boy' ? undefined : 'boy')}
                type="button"
              >
                {t('settings.genderBoy')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* My profile */}
      <div className="settings-section">
        <div className="settings-section-title">{t('settings.myProfile')}</div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="label">{t('settings.myName')}</div>
            <input
              type="text"
              className="input-field"
              placeholder={t('settings.myNamePlaceholder')}
              value={myName}
              onChange={e => setMyName(e.target.value)}
            />
          </div>
          <div>
            <div className="label">{t('settings.role')}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className={`role-btn${myRole === 'mom' ? ' selected' : ''}`}
                onClick={() => setMyRole('mom')}
              >
                {t('settings.roleMom')}
              </button>
              <button
                className={`role-btn${myRole === 'dad' ? ' selected' : ''}`}
                onClick={() => setMyRole('dad')}
              >
                {t('settings.roleDad')}
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
          {saving ? t('settings.saving') : t('settings.save')}
        </button>
      </div>

      {/* Data section */}
      <div className="settings-section">
        <div className="settings-section-title">{t('settings.dataSection')}</div>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {dataInfo && (
            <>
              <div className="settings-row">
                <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>{t('settings.totalRecords')}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-800)' }}>
                  {t('settings.recordUnit', { count: dataInfo.eventCount })}
                </span>
              </div>
              <div className="settings-row">
                <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>{t('settings.lastBackup')}</span>
                <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>
                  {dataInfo.lastBackupTime
                    ? format(parseISO(dataInfo.lastBackupTime), t('date.formatBackup'), { locale: dateFnsLocale })
                    : t('settings.noBackup')}
                </span>
              </div>
            </>
          )}
          <div className="settings-row">
            <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>{t('settings.backupFolder')}</span>
            <button
              className="btn-secondary"
              style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}
              onClick={handleOpenBackup}
            >
              <IconFolderOpen size={13} color="currentColor" />
              {t('settings.openFolder')}
            </button>
          </div>
          <div className="settings-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>{t('settings.exportData')}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="btn-secondary"
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}
                onClick={handleExportJson}
              >
                <IconDownload size={13} color="currentColor" />
                JSON
              </button>
              <button
                className="btn-secondary"
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}
                onClick={handleExportCsv}
              >
                <IconDownload size={13} color="currentColor" />
                CSV
              </button>
            </div>
          </div>
          <div className="settings-row">
            <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>&nbsp;</span>
            <button
              className="btn-danger-text"
              onClick={() => setShowDeleteAllModal(true)}
            >
              {t('settings.deleteAllRecords')}
            </button>
          </div>
        </div>
      </div>

      {/* Delete all records modal */}
      {showDeleteAllModal && (
        <DeleteAllModal
          onConfirm={handleDeleteAll}
          onClose={() => !deletingAll && setShowDeleteAllModal(false)}
          busy={deletingAll}
        />
      )}

      {/* Tutorial replay */}
      {onStartTour && (
        <div className="settings-section">
          <div className="card" style={{ padding: '10px 14px' }}>
            <button
              className="btn-secondary"
              style={{ width: '100%', textAlign: 'center' }}
              onClick={onStartTour}
            >
              {t('tour.replayBtn')}
            </button>
          </div>
        </div>
      )}

      {/* Sync section */}
      <div className="settings-section">
        <div className="settings-section-title">{t('settings.syncSection')}</div>
        <SyncSettingsSlot />
      </div>

      {/* Care guidance reference card */}
      <GuidanceReferenceCard lang={i18nInstance.language as 'ko' | 'ja'} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 육아 가이드 / 育児ガイド reference card — all 13 markers, accordion rows
// ---------------------------------------------------------------------------
function GuidanceReferenceCard({ lang }: { lang: 'ko' | 'ja' }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const disclaimer = lang === 'ja' ? GUIDANCE_DISCLAIMER.ja : GUIDANCE_DISCLAIMER.ko

  const toggleItem = (id: string) => {
    setExpandedId(prev => prev === id ? null : id)
  }

  return (
    <div className="settings-section">
      <button
        className="settings-section-title"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: 0,
          fontSize: 'inherit',
          color: 'inherit',
          fontWeight: 'inherit',
          width: '100%',
          textAlign: 'left',
        }}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <IconInfo size={15} color="var(--sky-text)" />
        {t('guidance.guideCardTitle')}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
          {open ? t('guidance.guideCollapse') : t('guidance.guideExpand')}
        </span>
      </button>
      {open && (
        <div className="card" style={{ marginTop: 8 }}>
          {/* Disclaimer at top */}
          <div style={{
            fontSize: 11.5,
            color: 'var(--text-muted)',
            marginBottom: 14,
            lineHeight: 1.5,
            borderLeft: '3px solid var(--sky)',
            paddingLeft: 10,
          }}>
            {disclaimer}
          </div>

          {/* Accordion rows — all 13 markers */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {GUIDANCE_MARKERS.map(marker => {
              const isExpanded = expandedId === marker.id
              const title = lang === 'ja' ? marker.titleJa : marker.titleKo
              const body  = lang === 'ja' ? marker.bodyJa  : marker.bodyKo
              return (
                <div
                  key={marker.id}
                  style={{
                    borderBottom: '1px solid var(--border)',
                    paddingBottom: 8,
                    marginBottom: 4,
                  }}
                >
                  <button
                    onClick={() => toggleItem(marker.id)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 0',
                    }}
                    aria-expanded={isExpanded}
                  >
                    <span style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--text-primary)', flex: 1 }}>
                      {title}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: marker.evidenceLevel === 'RCT' ? 'var(--sky)' : 'var(--mint)',
                        color: marker.evidenceLevel === 'RCT' ? 'var(--sky-text)' : 'var(--mint-text)',
                        flexShrink: 0,
                      }}
                    >
                      {marker.evidenceLevel === 'RCT' ? 'RCT' : t('guidance.evidenceConsensus')}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>
                      {isExpanded ? '▲' : '▼'}
                    </span>
                  </button>
                  {isExpanded && (
                    <div style={{ paddingLeft: 4, paddingBottom: 6 }}>
                      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.65, marginBottom: 6 }}>
                        {body}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {t('guidance.sourcePrefix')}{marker.sourceLabel}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
