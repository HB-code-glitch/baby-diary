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
import type { AppSettings, BabyInfoUnlinkedArchive } from '../../shared/types'
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

const ARCHIVE_INITIAL_PAGE_SIZE = 10

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
  const babyGenderDirtyRef = useRef(false)
  const myNameDirtyRef = useRef(false)
  const myRoleDirtyRef = useRef(false)
  const themeDirtyRef = useRef(false)
  const languageDirtyRef = useRef(false)
  const babyNameEditGenerationRef = useRef(0)
  const birthdateEditGenerationRef = useRef(0)
  const babyGenderEditGenerationRef = useRef(0)
  const myNameEditGenerationRef = useRef(0)
  const myRoleEditGenerationRef = useRef(0)
  const themeEditGenerationRef = useRef(0)
  const languageEditGenerationRef = useRef(0)
  const mountHydrationEpochRef = useRef(0)
  const [babyGender, setBabyGender] = useState<'girl' | 'boy' | undefined>(settings?.baby?.gender)
  const [myName,     setMyName]     = useState(settings?.profile?.name    ?? '')
  const [myRole,     setMyRole]     = useState<'mom' | 'dad'>(settings?.profile?.role ?? 'mom')
  const [saving, setSaving] = useState(false)
  const [currentTheme, setCurrentTheme] = useState<'light' | 'dark' | 'system'>(settings?.theme ?? 'system')
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const [pdfSaving, setPdfSaving] = useState(false)
  const [unlinkedArchives, setUnlinkedArchives] = useState<BabyInfoUnlinkedArchive[]>([])
  const [unlinkedArchiveCursor, setUnlinkedArchiveCursor] = useState<string | undefined>()
  const [unlinkedArchiveLoading, setUnlinkedArchiveLoading] = useState(false)
  const [unlinkedArchiveError, setUnlinkedArchiveError] = useState(false)
  const archiveFocusIndexRef = useRef<number | null>(null)

  // Hydrate form from a settings object
  const hydrateForm = useCallback((s: AppSettings, forceAll = false) => {
    if (forceAll || !babyNameDirtyRef.current) {
      setBabyName(s.baby?.name ?? '')
    }
    if (forceAll || !birthdateDirtyRef.current) {
      setBirthdate(s.baby?.birthdate ?? '')
    }
    if (forceAll || !babyGenderDirtyRef.current) setBabyGender(s.baby?.gender)
    if (forceAll || !myNameDirtyRef.current) setMyName(s.profile?.name ?? '')
    if (forceAll || !myRoleDirtyRef.current) setMyRole(s.profile?.role ?? 'mom')
    if (forceAll || !themeDirtyRef.current) setCurrentTheme(s.theme ?? 'system')
  }, [])

  // Belt+suspenders: on mount, always fetch fresh settings directly from disk
  // (bypasses possible stale Zustand store state from hydration race)
  useEffect(() => {
    let cancelled = false
    const hydrationEpoch = mountHydrationEpochRef.current
    ipc.getSettings().then(fresh => {
      if (!cancelled && hydrationEpoch === mountHydrationEpochRef.current) {
        hydrateForm(fresh)
      }
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

  useEffect(() => {
    let cancelled = false
    setUnlinkedArchives([])
    setUnlinkedArchiveCursor(undefined)
    setUnlinkedArchiveError(false)
    archiveFocusIndexRef.current = null
    if (!settings?.familyId) return () => { cancelled = true }
    setUnlinkedArchiveLoading(true)
    ipc.listUnlinkedBabyInfoArchives({ limit: ARCHIVE_INITIAL_PAGE_SIZE }).then(page => {
      if (cancelled) return
      setUnlinkedArchives(page.items)
      setUnlinkedArchiveCursor(page.nextCursor)
    }).catch(() => {
      if (!cancelled) setUnlinkedArchiveError(true)
    }).finally(() => {
      if (!cancelled) setUnlinkedArchiveLoading(false)
    })
    return () => { cancelled = true }
  }, [settings?.familyId, settings?.profile?.uid])

  useEffect(() => {
    const index = archiveFocusIndexRef.current
    if (index === null || unlinkedArchiveLoading) return
    const button = document.querySelector<HTMLButtonElement>(`[data-archive-index="${index}"] button`)
    button?.focus()
    archiveFocusIndexRef.current = null
  }, [unlinkedArchives.length, unlinkedArchiveLoading])

  const loadMoreUnlinkedArchives = async () => {
    if (!unlinkedArchiveCursor || unlinkedArchiveLoading) return
    const firstNewIndex = unlinkedArchives.length
    setUnlinkedArchiveLoading(true)
    setUnlinkedArchiveError(false)
    try {
      const page = await ipc.listUnlinkedBabyInfoArchives({
        limit: ARCHIVE_INITIAL_PAGE_SIZE,
        cursor: unlinkedArchiveCursor,
      })
      const known = new Set(unlinkedArchives.map(item => item.archiveId))
      const additions = page.items.filter(item => !known.has(item.archiveId))
      archiveFocusIndexRef.current = additions.length > 0 ? firstNewIndex : null
      setUnlinkedArchives(current => [...current, ...additions])
      setUnlinkedArchiveCursor(page.nextCursor)
    } catch {
      setUnlinkedArchiveError(true)
    } finally {
      setUnlinkedArchiveLoading(false)
    }
  }

  const applyUnlinkedArchive = (archive: BabyInfoUnlinkedArchive) => {
    babyNameDirtyRef.current = true
    birthdateDirtyRef.current = true
    babyNameEditGenerationRef.current += 1
    birthdateEditGenerationRef.current += 1
    setBabyName(archive.babyName)
    setBirthdate(archive.babyBirthdate)
  }

  const handleSave = async () => {
    // Capture both values and ownership before the first await. Edits made
    // while this submission is pending belong to a later generation and must
    // remain visible/dirty when the older save resolves.
    const submittedBabyName = babyName
    const submittedBirthdate = birthdate
    const submittedBabyNameDirty = babyNameDirtyRef.current
    const submittedBirthdateDirty = birthdateDirtyRef.current
    const submittedBabyGenderDirty = babyGenderDirtyRef.current
    const submittedMyNameDirty = myNameDirtyRef.current
    const submittedMyRoleDirty = myRoleDirtyRef.current
    const submittedThemeDirty = themeDirtyRef.current
    const submittedLanguageDirty = languageDirtyRef.current
    const submittedBabyNameGeneration = babyNameEditGenerationRef.current
    const submittedBirthdateGeneration = birthdateEditGenerationRef.current
    const submittedBabyGenderGeneration = babyGenderEditGenerationRef.current
    const submittedMyNameGeneration = myNameEditGenerationRef.current
    const submittedMyRoleGeneration = myRoleEditGenerationRef.current
    const submittedThemeGeneration = themeEditGenerationRef.current
    const submittedLanguageGeneration = languageEditGenerationRef.current
    const submittedBabyGender = babyGender
    const submittedMyName = myName
    const submittedMyRole = myRole
    const submittedTheme = currentTheme
    const submittedLanguage = i18nInstance.language as Language
    // A late mount read belongs to the pre-save snapshot and must never win.
    mountHydrationEpochRef.current += 1
    setSaving(true)
    try {
      // Source of truth: always fetch fresh from disk before merging
      const current = await ipc.getSettings()

      // Disk is authoritative for every untouched field, even after an earlier
      // hydration completed: another process/sync path may have advanced it.
      // Explicit user edits retain ownership, including intentional empty values.
      const resolvedBabyName = submittedBabyNameDirty ? submittedBabyName : current.baby.name
      const resolvedBirthdate = submittedBirthdateDirty ? submittedBirthdate : current.baby.birthdate
      const resolvedBabyGender = submittedBabyGenderDirty ? submittedBabyGender : current.baby.gender
      const resolvedMyName = submittedMyNameDirty ? submittedMyName : current.profile.name
      const resolvedMyRole = submittedMyRoleDirty ? submittedMyRole : current.profile.role
      const resolvedTheme = submittedThemeDirty ? submittedTheme : current.theme
      const resolvedLanguage = submittedLanguageDirty ? submittedLanguage : current.language

      const form: FormSnapshot = {
        babyName: resolvedBabyName,
        birthdate: resolvedBirthdate,
        babyGender: resolvedBabyGender,
        myName: resolvedMyName,
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
          name: resolvedBabyName,
          birthdate: resolvedBirthdate,
        },
        profile: {
          ...merged.profile,
          uid:  current.profile?.uid ?? settings?.profile?.uid ?? uuidv4(),
          name: resolvedMyName,
          role: resolvedMyRole,
        },
        familyId: current.familyId ?? settings?.familyId ?? '',  // F8: never fabricate
        firebase:  current.firebase  ?? settings?.firebase  ?? null,
        language:  resolvedLanguage,
        theme:     resolvedTheme,
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
      const babyGenderChangedSinceSubmission = (
        babyGenderEditGenerationRef.current !== submittedBabyGenderGeneration
      )
      const myNameChangedSinceSubmission = myNameEditGenerationRef.current !== submittedMyNameGeneration
      const myRoleChangedSinceSubmission = myRoleEditGenerationRef.current !== submittedMyRoleGeneration
      const themeChangedSinceSubmission = themeEditGenerationRef.current !== submittedThemeGeneration
      const languageChangedSinceSubmission = (
        languageEditGenerationRef.current !== submittedLanguageGeneration
      )
      if (!babyNameChangedSinceSubmission) babyNameDirtyRef.current = false
      if (!birthdateChangedSinceSubmission) birthdateDirtyRef.current = false
      if (!babyGenderChangedSinceSubmission) babyGenderDirtyRef.current = false
      if (!myNameChangedSinceSubmission) myNameDirtyRef.current = false
      if (!myRoleChangedSinceSubmission) myRoleDirtyRef.current = false
      if (!themeChangedSinceSubmission) themeDirtyRef.current = false
      if (!languageChangedSinceSubmission) languageDirtyRef.current = false

      // Cleared fields accept the durable result. Edits made while the save was
      // pending remain dirty and are therefore not overwritten.
      hydrateForm(savedSettings)

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
        && !submittedMyName.trim()
      const diskHadData  = !!(current.baby?.name?.trim() || current.baby?.birthdate?.trim() || current.profile?.name?.trim())

      if (saveResult.babyInfo === 'pending') {
        showToast({ message: t('settings.babyInfoSavePending') })
      } else if (formWasBlank
        && diskHadData
        && !babyNameChangedSinceSubmission
        && !birthdateChangedSinceSubmission) {
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
    languageDirtyRef.current = true
    languageEditGenerationRef.current += 1
    const languageGeneration = languageEditGenerationRef.current
    setLanguage(lang)
    // P4: always fetch fresh settings from disk before merging — never reconstruct
    // sub-objects from possibly-null Zustand snapshot (would overwrite baby name/uid).
    try {
      const current = await ipc.getSettings()
      if (languageEditGenerationRef.current !== languageGeneration) return
      await saveSettings({ ...current, language: lang })
      if (languageEditGenerationRef.current === languageGeneration) languageDirtyRef.current = false
    } catch {
      showToast({ message: t('settings.toastSaveFail') })
    }
  }

  const handleThemeChange = async (theme: 'light' | 'dark' | 'system') => {
    themeDirtyRef.current = true
    themeEditGenerationRef.current += 1
    const themeGeneration = themeEditGenerationRef.current
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
      if (themeEditGenerationRef.current !== themeGeneration) return
      await saveSettings({ ...current, theme })
      if (themeEditGenerationRef.current === themeGeneration) themeDirtyRef.current = false
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
                  data-settings-language="ko"
                  lang="ko"
                >
                  한국어
                </button>
                <button
                  className={`role-btn${currentLang === 'ja' ? ' selected' : ''}`}
                  onClick={() => handleLanguageChange('ja')}
                  data-settings-language="ja"
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
              {settings?.familyId
                && (unlinkedArchives.length > 0 || unlinkedArchiveLoading || unlinkedArchiveError)
                && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {unlinkedArchives.map((archive, index) => (
                    <div
                      key={archive.archiveId}
                      data-archive-index={index}
                      style={{ padding: 10, border: '1px solid var(--stone-200)', borderRadius: 8 }}
                    >
                      <div style={{ fontSize: 12, lineHeight: 1.5, marginBottom: 8 }}>
                        {t('settings.unlinkedArchiveReview', {
                          name: archive.babyName || '—',
                          birthdate: archive.babyBirthdate || '—',
                        })}
                      </div>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => applyUnlinkedArchive(archive)}
                      >
                        {t('settings.unlinkedArchiveApply')}
                      </button>
                    </div>
                  ))}
                  {unlinkedArchiveError && (
                    <div role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>
                      {t('settings.unlinkedArchiveLoadError')}
                    </div>
                  )}
                  {unlinkedArchiveCursor && (
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={unlinkedArchiveLoading}
                      onClick={loadMoreUnlinkedArchives}
                    >
                      {unlinkedArchiveLoading
                        ? t('settings.unlinkedArchiveLoading')
                        : t('settings.unlinkedArchiveLoadMore')}
                    </button>
                  )}
                  {unlinkedArchiveLoading && !unlinkedArchiveCursor && unlinkedArchives.length === 0 && (
                    <div aria-live="polite" style={{ fontSize: 12 }}>
                      {t('settings.unlinkedArchiveLoading')}
                    </div>
                  )}
                </div>
                )}
              <div>
                <div className="label">{t('settings.babyName')}</div>
                <input
                  type="text"
                  className="input-field"
                  data-settings-baby-name
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
                  data-settings-baby-birthdate
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
                    onClick={() => {
                      babyGenderDirtyRef.current = true
                      babyGenderEditGenerationRef.current += 1
                      setBabyGender(babyGender === 'girl' ? undefined : 'girl')
                    }}
                    type="button"
                  >
                    {t('settings.genderGirl')}
                  </button>
                  <button
                    className={`role-btn${babyGender === 'boy' ? ' selected' : ''}`}
                    onClick={() => {
                      babyGenderDirtyRef.current = true
                      babyGenderEditGenerationRef.current += 1
                      setBabyGender(babyGender === 'boy' ? undefined : 'boy')
                    }}
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
                  data-settings-account-name
                  placeholder={t('settings.myNamePlaceholder')}
                  value={myName}
                  onChange={e => {
                    myNameDirtyRef.current = true
                    myNameEditGenerationRef.current += 1
                    setMyName(e.target.value)
                  }}
                />
              </div>
              <div>
                <div className="label">{t('settings.role')}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className={`role-btn${myRole === 'mom' ? ' selected' : ''}`}
                    data-settings-account-role="mom"
                    onClick={() => {
                      myRoleDirtyRef.current = true
                      myRoleEditGenerationRef.current += 1
                      setMyRole('mom')
                    }}
                  >
                    {t('settings.roleMom')}
                  </button>
                  <button
                    className={`role-btn${myRole === 'dad' ? ' selected' : ''}`}
                    data-settings-account-role="dad"
                    onClick={() => {
                      myRoleDirtyRef.current = true
                      myRoleEditGenerationRef.current += 1
                      setMyRole('dad')
                    }}
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
