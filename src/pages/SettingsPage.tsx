import React, { useState, useEffect } from 'react'
import { IconFolderOpen, IconDownload } from '../components/icons'
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

export function SettingsPage() {
  const { settings, saveSettings, loadDataInfo, dataInfo } = useAppStore()
  const { showToast } = useToast()
  const { t, i18n: i18nInstance } = useTranslation()

  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko

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
      language:  (i18nInstance.language as Language) ?? 'ko',
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
    }
    await saveSettings(updated)
  }

  const handleExportJson = async () => {
    try {
      await ipc.exportData('json')
      showToast({ message: t('settings.toastExportJson') })
    } catch {
      showToast({ message: t('settings.toastExportFail') })
    }
  }

  const handleExportCsv = async () => {
    try {
      await ipc.exportData('csv')
      showToast({ message: t('settings.toastExportCsv') })
    } catch {
      showToast({ message: t('settings.toastExportFail') })
    }
  }

  const handleOpenBackup = async () => {
    try {
      await ipc.openBackupFolder()
    } catch {
      showToast({ message: t('settings.toastOpenFolderFail') })
    }
  }

  const currentLang = i18nInstance.language as Language

  return (
    <div className="page-container" style={{ maxWidth: 560 }}>
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
        </div>
      </div>

      {/* Sync section */}
      <div className="settings-section">
        <div className="settings-section-title">{t('settings.syncSection')}</div>
        <SyncSettingsSlot />
      </div>
    </div>
  )
}
