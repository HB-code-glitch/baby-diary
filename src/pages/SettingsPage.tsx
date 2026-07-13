import React, { useState, useEffect, useCallback, useRef } from 'react'
import { IconFolderOpen, IconDownload, IconInfo } from '../components/icons'
import { GUIDANCE_MARKERS, GUIDANCE_DISCLAIMER } from '../lib/guidance'
import {
  BF_CLUSTER_NOTE,
  BF_DISCLAIMER,
  BF_NEWBORN_GUIDANCE,
  BF_RESPONSIVE_GUIDANCE,
} from '../lib/breastfeeding'
import { ko } from 'date-fns/locale'
import { ja } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { useToast } from '../components/Toast'
import { ipc } from '../lib/ipc'
import { SyncSettingsSlot } from '../components/SyncSettingsSlot'
import { DisclosureSection } from '../components/DisclosureSection'
import { AppSettings } from '../../shared/types'
import { v4 as uuidv4 } from 'uuid'
import { useTranslation } from 'react-i18next'
import { setLanguage, Language } from '../i18n'
import { DeleteAllModal } from '../components/DeleteAllModal'
import { mergeSettingsSafely, FormSnapshot } from '../lib/mergeSettings'
import { updateMemberEntry, useSyncStatus } from '../sync/useSync'
import { getSyncDisclosurePresentation } from '../lib/progressiveDisclosure'
import { getDataDisclosurePresentation } from '../lib/settingsPresentation'
import { AgeGuidancePanel } from '../components/AgeGuidancePanel'

// Re-export for any consumers that already import from this path
export type { FormSnapshot }
export { mergeSettingsSafely }

interface SettingsPageProps {
  onStartTour?: () => void
}

export function SettingsPage({ onStartTour }: SettingsPageProps) {
  const {
    settings,
    saveSettings,
    saveSettingsWithBabyInfoMutation,
    loadDataInfo,
    dataInfo,
    softDeleteAllEvents,
  } = useAppStore()
  const { showToast } = useToast()
  const { t, i18n: i18nInstance } = useTranslation()

  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko
  const syncStatus = useSyncStatus()
  const syncPresentation = getSyncDisclosurePresentation(syncStatus.status, Boolean(settings?.familyId))
  const syncSummary = syncPresentation.summary === 'ready'
    ? t('settings.syncReady')
    : syncPresentation.summary === 'connecting'
      ? t('sync.connecting')
      : t('settings.syncNeedsAttention')
  const dataPresentation = getDataDisclosurePresentation(dataInfo, {
    formatPattern: t('date.formatBackup'),
    locale: dateFnsLocale,
    noBackup: t('settings.noBackup'),
  })
  const dataSummary = dataPresentation
    ? t('settings.dataSummary', dataPresentation)
    : undefined

  // Local form state
  const [babyName,   setBabyName]   = useState(settings?.baby?.name       ?? '')
  const [birthdate,  setBirthdate]  = useState(settings?.baby?.birthdate  ?? '')
  const babyNameDirtyRef = useRef(false)
  const birthdateDirtyRef = useRef(false)
  const babyNameEditGenerationRef = useRef(0)
  const birthdateEditGenerationRef = useRef(0)
  const [babyGender, setBabyGender] = useState<'girl' | 'boy' | undefined>(settings?.baby?.gender)
  const [myName,     setMyName]     = useState(settings?.profile?.name    ?? '')
  const [myRole,     setMyRole]     = useState<'mom' | 'dad'>(settings?.profile?.role ?? 'mom')
  const [saving, setSaving] = useState(false)
  const [currentTheme, setCurrentTheme] = useState<'light' | 'dark' | 'system'>(settings?.theme ?? 'system')
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const [pdfSaving, setPdfSaving] = useState(false)

  // Hydrate form from a settings object
  const hydrateForm = useCallback((s: AppSettings, forceBabyInfo = false) => {
    if (forceBabyInfo || !babyNameDirtyRef.current) {
      setBabyName(s.baby?.name ?? '')
    }
    if (forceBabyInfo || !birthdateDirtyRef.current) {
      setBirthdate(s.baby?.birthdate ?? '')
    }
    setBabyGender(s.baby?.gender)
    setMyName(s.profile?.name      ?? '')
    setMyRole(s.profile?.role      ?? 'mom')
    setCurrentTheme(s.theme        ?? 'system')
  }, [])

  // Belt+suspenders: on mount, always fetch fresh settings directly from disk
  // (bypasses possible stale Zustand store state from hydration race)
  useEffect(() => {
    let cancelled = false
    ipc.getSettings().then(fresh => {
      if (!cancelled) hydrateForm(fresh)
    }).catch(() => {
      // fallback to store state handled below
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync local form when store settings load (secondary, catches store updates)
  useEffect(() => {
    if (settings) {
      hydrateForm(settings)
    }
  }, [settings, hydrateForm])

  useEffect(() => {
    loadDataInfo()
  }, [])

  const handleSave = async () => {
    // Capture both values and ownership before the first await. Edits made
    // while this submission is pending belong to a later generation and must
    // remain visible/dirty when the older save resolves.
    const submittedBabyName = babyName
    const submittedBirthdate = birthdate
    const submittedBabyNameDirty = babyNameDirtyRef.current
    const submittedBirthdateDirty = birthdateDirtyRef.current
    const submittedBabyNameGeneration = babyNameEditGenerationRef.current
    const submittedBirthdateGeneration = birthdateEditGenerationRef.current
    setSaving(true)
    try {
      // Source of truth: always fetch fresh from disk before merging
      const current = await ipc.getSettings()

      const form: FormSnapshot = {
        babyName: submittedBabyName,
        birthdate: submittedBirthdate,
        babyGender,
        myName,
      }

      // Merge: never blank-overwrite non-empty saved critical fields
      const merged = mergeSettingsSafely(current, form)
      const babyInfoWasDirty = submittedBabyNameDirty || submittedBirthdateDirty

      // Apply non-critical fields from UI
      const updated: AppSettings = {
        ...merged,
        baby: {
          ...merged.baby,
          // Dirty fields carry exact user intent, including an empty string.
          name: submittedBabyNameDirty ? submittedBabyName : merged.baby.name,
          birthdate: submittedBirthdateDirty ? submittedBirthdate : merged.baby.birthdate,
        },
        profile: {
          ...merged.profile,
          uid:  current.profile?.uid ?? settings?.profile?.uid ?? uuidv4(),
          role: myRole,
        },
        familyId: current.familyId ?? settings?.familyId ?? '',  // F8: never fabricate
        firebase:  current.firebase  ?? settings?.firebase  ?? null,
        language:  (i18nInstance.language as Language) ?? 'ko',
        theme:     currentTheme,
      }

      const saveResult = babyInfoWasDirty
        ? await saveSettingsWithBabyInfoMutation(updated)
        : { settings: await saveSettings(updated), babyInfo: 'unchanged' as const }
      const savedSettings = saveResult.settings

      const babyNameChangedSinceSubmission = (
        babyNameEditGenerationRef.current !== submittedBabyNameGeneration
      )
      const birthdateChangedSinceSubmission = (
        birthdateEditGenerationRef.current !== submittedBirthdateGeneration
      )
      if (!babyNameChangedSinceSubmission) babyNameDirtyRef.current = false
      if (!birthdateChangedSinceSubmission) birthdateDirtyRef.current = false

      if (savedSettings.familyId) {
        // Member entry self-heal: push profile name/role to family doc member entry
        // so that any role/name change is reflected in the shared family doc.
        const newProfileName = savedSettings.profile?.name ?? ''
        const newProfileRole = savedSettings.profile?.role ?? 'mom'
        updateMemberEntry(newProfileName, newProfileRole).catch(() => {
          // best-effort: non-fatal
        })
      }

      // Detect race scenario: form was fully blank but disk had data →
      // re-hydrate the form and show info toast instead of normal saved toast
      const formWasBlank = !babyInfoWasDirty
        && !submittedBabyName.trim()
        && !submittedBirthdate.trim()
        && !myName.trim()
      const diskHadData  = !!(current.baby?.name?.trim() || current.baby?.birthdate?.trim() || current.profile?.name?.trim())

      if (saveResult.babyInfo === 'pending') {
        showToast({ message: t('settings.babyInfoSavePending') })
      } else if (formWasBlank
        && diskHadData
        && !babyNameChangedSinceSubmission
        && !birthdateChangedSinceSubmission) {
        // Re-hydrate from merged result so the user sees their real data
        hydrateForm(savedSettings, true)
        showToast({ message: t('settings.restoredFromDisk') })
      } else {
        showToast({ message: t('settings.toastSaved') })
      }
    } catch {
      // P5: surface fs/IPC errors — user must know the save failed
      showToast({ message: t('settings.toastSaveFail'), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const handleLanguageChange = async (lang: Language) => {
    setLanguage(lang)
    // P4: always fetch fresh settings from disk before merging — never reconstruct
    // sub-objects from possibly-null Zustand snapshot (would overwrite baby name/uid).
    try {
      const current = await ipc.getSettings()
      await saveSettings({ ...current, language: lang })
    } catch {
      showToast({ message: t('settings.toastSaveFail') })
    }
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
    // P4: always fetch fresh settings from disk before merging — never reconstruct
    // sub-objects from possibly-null Zustand snapshot (would overwrite baby name/uid).
    try {
      const current = await ipc.getSettings()
      await saveSettings({ ...current, theme })
    } catch {
      showToast({ message: t('settings.toastSaveFail') })
    }
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
      // MF-12: partial failure must show the partial toast (not success)
      const { count, partial } = await softDeleteAllEvents()
      if (partial) {
        showToast({ message: t('settings.deleteAllToastPartial', { count }) })
      } else {
        setShowDeleteAllModal(false)
        showToast({ message: t('settings.deleteAllToastSuccess', { count }) })
      }
      await loadDataInfo()
    } catch {
      showToast({ message: t('toast.saveFailed') })
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

  const handleSavePdf = async () => {
    setPdfSaving(true)
    try {
      const result = await ipc.savePdf()
      if (result.saved) {
        showToast({ message: t('report.toastSuccess', { path: result.path }) })
      } else {
        showToast({ message: t('report.toastCanceled') })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'ELECTRON_ONLY') {
        showToast({ message: t('report.electronOnly') })
      } else {
        showToast({ message: t('report.toastError') })
      }
    } finally {
      setPdfSaving(false)
    }
  }

  const currentLang = i18nInstance.language as Language

  return (
    <div className="page-container" data-tour="settings-main">
      <div className="page-header">
        <div className="page-title">{t('settings.title')}</div>
      </div>

      {/* Responsive 2-column grid — switches to 1 column below 1180px viewport width */}
      <div className="settings-grid">

        {/* ── Left column: 언어, 테마, 아기 정보, 내 프로필, 저장 버튼 ── */}
        <div className="settings-column">

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
              {settings?.familyId && (
                <div style={{ fontSize: 11, color: 'var(--stone-400)', lineHeight: 1.5, marginBottom: -4 }}>
                  {t('settings.babyInfoSharedHint')}
                </div>
              )}
              <div>
                <div className="label">{t('settings.babyName')}</div>
                <input
                  type="text"
                  className="input-field"
                  placeholder={t('settings.babyNamePlaceholder')}
                  value={babyName}
                  onChange={e => {
                    babyNameDirtyRef.current = true
                    babyNameEditGenerationRef.current += 1
                    setBabyName(e.target.value)
                  }}
                />
              </div>
              <div>
                <div className="label">{t('settings.birthdate')}</div>
                <input
                  type="date"
                  className="input-field"
                  value={birthdate}
                  onChange={e => {
                    birthdateDirtyRef.current = true
                    birthdateEditGenerationRef.current += 1
                    setBirthdate(e.target.value)
                  }}
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

          {/* Save button — visually attached to the profile/baby forms above */}
          <div style={{ marginBottom: 24 }}>
            <button
              className="btn-primary"
              onClick={handleSave}
              disabled={!settings || saving}
              style={{ width: '100%', padding: '11px' }}
            >
              {saving ? t('settings.saving') : t('settings.save')}
            </button>
          </div>

        </div>{/* end left column */}

        {/* ── Right column: 데이터, 육아 가이드, 가족 동기화, 튜토리얼 ── */}
        <div className="settings-column">

          {/* Data section */}
          <DisclosureSection title={t('settings.dataSection')} summary={dataSummary}>
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
                      {dataPresentation?.backup ?? t('settings.noBackup')}
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
                <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>{t('report.btnLabel')}</span>
                <button
                  className="btn-secondary"
                  style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}
                  onClick={handleSavePdf}
                  disabled={pdfSaving}
                >
                  {pdfSaving ? t('report.saving') : t('report.btnLabel')}
                </button>
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
          </DisclosureSection>

          {/* Current-stage evidence center — unknown residence keeps both KR/JP official links. */}
          <AgeGuidancePanel birthdate={birthdate} variant="settings" />

          {/* Sync section */}
          <div data-tour="settings-sync" data-sync-settings>
            <DisclosureSection
              title={t('settings.syncSection')}
              summary={syncSummary}
              defaultOpen={syncPresentation.defaultOpen}
            >
              <SyncSettingsSlot />
            </DisclosureSection>
          </div>

          {/* Tutorial replay */}
          {onStartTour && (
            <div className="settings-section">
              <div className="card" style={{ padding: '10px 14px' }}>
                <button
                  className="btn-secondary"
                  style={{ width: '100%', textAlign: 'center' }}
                  onClick={onStartTour}
                  data-tutorial-replay
                >
                  {t('tour.replayBtn')}
                </button>
              </div>
            </div>
          )}

        </div>{/* end right column */}

      </div>{/* end settings-grid */}

      {/* Delete all records modal — portal-level, outside grid */}
      {showDeleteAllModal && (
        <DeleteAllModal
          onConfirm={handleDeleteAll}
          onClose={() => !deletingAll && setShowDeleteAllModal(false)}
          busy={deletingAll}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 반응형 수유 안내 / 赤ちゃんのサインに応じる授乳
// ---------------------------------------------------------------------------
function BreastfeedingGuideCard({ lang }: { lang: 'ko' | 'ja' }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

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
        {t('guidance.bfGuideTitle')}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
          {open ? t('guidance.guideCollapse') : t('guidance.guideExpand')}
        </span>
      </button>
      {open && (
        <div className="card" style={{ marginTop: 8 }}>
          <div style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            lineHeight: 1.6,
            marginBottom: 10,
            borderLeft: '3px solid var(--sky)',
            paddingLeft: 10,
          }}>
            {BF_RESPONSIVE_GUIDANCE[lang]}
          </div>

          <div style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            lineHeight: 1.6,
            marginBottom: 10,
            borderLeft: '3px solid var(--butter)',
            paddingLeft: 10,
          }}>
            {BF_NEWBORN_GUIDANCE[lang]}
          </div>

          <div style={{
            fontSize: 12,
            color: 'var(--text-secondary)',
            lineHeight: 1.6,
            marginBottom: 10,
            borderLeft: '3px solid var(--mint)',
            paddingLeft: 10,
          }}>
            {BF_CLUSTER_NOTE[lang]}
          </div>

          <div style={{
            fontSize: 11.5,
            color: 'var(--text-muted)',
            lineHeight: 1.5,
            marginBottom: 10,
            borderLeft: '3px solid var(--sky)',
            paddingLeft: 10,
          }}>
            {BF_DISCLAIMER[lang]}
          </div>

          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {t('guidance.bfGuideSourceLabel')}
          </div>
        </div>
      )}
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
