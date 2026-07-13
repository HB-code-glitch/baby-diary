import React, { useState, useMemo } from 'react'
import { IconPlus, IconPencil, IconTrash, IconX } from '../components/icons'
import { format, parseISO } from 'date-fns'
import { ko } from 'date-fns/locale'
import { ja } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { useToast } from '../components/Toast'
import { DiaryEvent, DiaryData } from '../../shared/types'
import { v4 as uuidv4 } from 'uuid'
import { useTranslation } from 'react-i18next'
import { sortValidEventsNewestFirst } from '../lib/eventTime'

// ---------------------------------------------------------------------------
// Diary entry editor
// ---------------------------------------------------------------------------

interface EditorProps {
  initial?: DiaryEvent
  onSave: (title: string, text: string) => Promise<void>
  onClose: () => void
}

function DiaryEditor({ initial, onSave, onClose }: EditorProps) {
  const data = initial?.data as DiaryData | undefined
  const [title, setTitle]  = useState(data?.title ?? '')
  const [text, setText]    = useState(data?.text  ?? '')
  const [saving, setSaving] = useState(false)
  const { t } = useTranslation()

  const handleSave = async () => {
    if (!text.trim()) return
    setSaving(true)
    await onSave(title.trim(), text.trim())
    setSaving(false)
    onClose()
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
      zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div
        style={{
          background: 'var(--stone-50)', borderRadius: 16, padding: 24,
          width: 'min(560px, 90vw)', boxShadow: '0 8px 40px rgba(0,0,0,0.12)',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--stone-800)' }}>
            {initial ? t('diary.editTitle') : t('diary.write')}
          </span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--stone-500)' }}
          >
            <IconX size={18} color="var(--stone-500)" />
          </button>
        </div>

        <div>
          <div className="label">{t('diary.titleLabel')}</div>
          <input
            type="text"
            className="input-field"
            placeholder={t('diary.titlePlaceholder')}
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
        </div>

        <div>
          <div className="label">{t('diary.contentLabel')}</div>
          <textarea
            className="textarea-field"
            placeholder={t('diary.contentPlaceholder')}
            style={{ minHeight: 160 }}
            value={text}
            onChange={e => setText(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose}>{t('diary.cancel')}</button>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={saving || !text.trim()}
            style={{ opacity: !text.trim() ? 0.5 : 1 }}
          >
            {saving ? t('diary.saving') : t('diary.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DiaryPage
// ---------------------------------------------------------------------------

export function DiaryPage() {
  const events    = useAppStore(s => s.events)
  const settings  = useAppStore(s => s.settings)
  const { addEvent, editEvent, softDeleteEvent } = useAppStore()
  const { showToast } = useToast()
  const { t, i18n: i18nInstance } = useTranslation()

  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko

  const [editorOpen, setEditorOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<DiaryEvent | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const diaryEvents = useMemo(() =>
    sortValidEventsNewestFirst(events.filter(e => !e.deleted && e.type === 'diary')),
    [events]
  )

  const handleSave = async (title: string, text: string) => {
    const time = new Date().toISOString()
    try {
      if (editTarget) {
        await editEvent(editTarget, { data: { title, text } as DiaryData })
        showToast({ message: t('diary.toastEdited') })
      } else {
        const event: DiaryEvent = {
          id: uuidv4(),
          type: 'diary',
          at: time,
          data: { title, text } as DiaryData,
          author: {
            uid:  settings?.profile?.uid  ?? 'local',
            name: settings?.profile?.name ?? '',
            role: settings?.profile?.role ?? 'mom',
          },
          createdAt: time,
          updatedAt: time,
          rev: 1,
          deleted: false,
        }
        await addEvent(event)
        showToast({ message: t('diary.toastSaved') })
      }
    } catch {
      showToast({ message: t('toast.saveFailed') })
    }
  }

  const handleDelete = async (event: DiaryEvent) => {
    if (confirmDelete === event.id) {
      try {
        await softDeleteEvent(event)
        setConfirmDelete(null)
        showToast({ message: t('diary.toastDeleted') })
      } catch {
        setConfirmDelete(null)
        showToast({ message: t('toast.deleteFailed') })
      }
    } else {
      setConfirmDelete(event.id)
      setTimeout(() => setConfirmDelete(null), 3000)
    }
  }

  const openEditor = (event?: DiaryEvent) => {
    setEditTarget(event ?? null)
    setEditorOpen(true)
  }

  return (
    <div className="page-container" data-tour="diary">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div className="page-title">{t('diary.title')}</div>
        <button
          className="btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          onClick={() => openEditor()}
        >
          <IconPlus size={14} color="white" />
          {t('diary.write')}
        </button>
      </div>

      {diaryEvents.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            {/* Open book illustration */}
            <svg width="64" height="52" viewBox="0 0 64 52" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M32 8V44" stroke="var(--stone-300)" strokeWidth="1.5" strokeLinecap="round"/>
              <path d="M32 10C32 10 24 6 12 8V42C24 40 32 44 32 44" stroke="var(--stone-300)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M32 10C32 10 40 6 52 8V42C40 40 32 44 32 44" stroke="var(--stone-300)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M17 16C20 15.5 24 15.5 27 16" stroke="var(--stone-300)" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M17 22C20 21.5 24 21.5 27 22" stroke="var(--stone-300)" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M17 28C20 27.5 24 27.5 27 28" stroke="var(--stone-300)" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M37 16C40 15.5 44 15.5 47 16" stroke="var(--stone-300)" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M37 22C40 21.5 44 21.5 47 22" stroke="var(--stone-300)" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <div className="empty-state-title">{t('diary.emptyTitle')}</div>
            <div className="empty-state-sub">{t('diary.emptySub')}</div>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 720 }}>
          {diaryEvents.map((event, i) => {
            const data = event.data as DiaryData
            return (
              <div
                key={`${event.id}-${event.rev}`}
                className="card stagger-mount"
                style={{ padding: '16px 18px', '--i': i } as React.CSSProperties}
              >
                {/* Title row */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {data.title && (
                      <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--stone-800)', marginBottom: 4 }}>
                        {data.title}
                      </div>
                    )}
                    <div style={{ fontSize: 13, color: 'var(--stone-600)', lineHeight: 1.65, whiteSpace: 'pre-line' }}>
                      {data.text.length > 120 ? data.text.slice(0, 120) + '…' : data.text}
                    </div>
                  </div>
                </div>
                {/* Footer row: date + author chip (right-aligned) */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--stone-400)' }}>
                    {format(parseISO(event.at), t('date.formatFull'), { locale: dateFnsLocale })}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {event.author?.name && (
                      <span style={{
                        fontSize: 11, color: 'var(--stone-500)',
                        background: 'var(--stone-100)', borderRadius: 99, padding: '2px 8px',
                      }}>
                        {t(`role.${event.author.role}`)} {event.author.name}
                      </span>
                    )}
                    <button
                      onClick={() => openEditor(event)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--stone-400)', borderRadius: 5 }}
                    >
                      <IconPencil size={13} color="var(--stone-400)" />
                    </button>
                    <button
                      onClick={() => handleDelete(event)}
                      style={{
                        background: confirmDelete === event.id ? 'var(--rose-100)' : 'none',
                        border: 'none', cursor: 'pointer', padding: 4,
                        color: confirmDelete === event.id ? 'var(--rose-500)' : 'var(--stone-400)',
                        borderRadius: 5,
                      }}
                    >
                      <IconTrash size={13} color={confirmDelete === event.id ? 'var(--rose-500)' : 'var(--stone-400)'} />
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editorOpen && (
        <DiaryEditor
          initial={editTarget ?? undefined}
          onSave={handleSave}
          onClose={() => { setEditorOpen(false); setEditTarget(null) }}
        />
      )}
    </div>
  )
}
