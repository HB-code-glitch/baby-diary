import React, { useState, useMemo } from 'react'
import { IconPlus, IconPencil, IconTrash, IconX } from '../components/icons'
import { format, parseISO } from 'date-fns'
import { ko } from 'date-fns/locale'
import { ja } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { useToast } from '../components/Toast'
import { DiaryEvent, MessageData } from '../../shared/types'
import { v4 as uuidv4 } from 'uuid'
import { useTranslation } from 'react-i18next'
import { sortValidEventsNewestFirst } from '../lib/eventTime'

// ---------------------------------------------------------------------------
// Message composer
// ---------------------------------------------------------------------------

interface ComposerProps {
  initial?: DiaryEvent
  babyName: string
  onSave: (text: string) => Promise<void>
  onClose: () => void
}

function MessageComposer({ initial, babyName, onSave, onClose }: ComposerProps) {
  const data = initial?.data as MessageData | undefined
  const [text, setText] = useState(data?.text ?? '')
  const [saving, setSaving] = useState(false)
  const { t } = useTranslation()

  const handleSave = async () => {
    if (!text.trim()) return
    setSaving(true)
    await onSave(text.trim())
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
          background: 'var(--cream-50)', borderRadius: 16, padding: 28,
          width: 'min(520px, 90vw)', boxShadow: '0 8px 40px rgba(0,0,0,0.12)',
          display: 'flex', flexDirection: 'column', gap: 14,
          borderTop: '3px solid var(--rose-200)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--stone-800)' }}>
              {initial ? t('messages.editTitle') : t('messages.composerToBaby', { babyName })}
            </div>
            <div style={{ fontSize: 12, color: 'var(--stone-500)', marginTop: 2 }}>
              {t('messages.composerSubtitle')}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--stone-500)' }}
          >
            <IconX size={18} color="var(--stone-500)" />
          </button>
        </div>

        <textarea
          className="textarea-field"
          style={{
            minHeight: 180,
            background: 'var(--cream-100)',
            border: '1.5px solid var(--stone-200)',
            lineHeight: 1.8,
            fontSize: 14,
          }}
          placeholder={t('messages.placeholder', { babyName })}
          value={text}
          onChange={e => setText(e.target.value)}
          autoFocus
        />

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose}>{t('messages.cancel')}</button>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={saving || !text.trim()}
            style={{ opacity: !text.trim() ? 0.5 : 1 }}
          >
            {saving ? t('messages.saving') : t('messages.send')}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MessagesPage
// ---------------------------------------------------------------------------

export function MessagesPage() {
  const events    = useAppStore(s => s.events)
  const settings  = useAppStore(s => s.settings)
  const { addEvent, editEvent, softDeleteEvent } = useAppStore()
  const { showToast } = useToast()
  const { t, i18n: i18nInstance } = useTranslation()

  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko

  const [composerOpen, setComposerOpen] = useState(false)
  const [editTarget, setEditTarget]     = useState<DiaryEvent | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const babyName = settings?.baby?.name || t('sidebar.defaultBabyName')

  const messageEvents = useMemo(() =>
    sortValidEventsNewestFirst(events.filter(e => !e.deleted && e.type === 'message')),
    [events]
  )

  const handleSave = async (text: string) => {
    const time = new Date().toISOString()
    try {
      if (editTarget) {
        await editEvent(editTarget, { data: { text } as MessageData })
        showToast({ message: t('messages.toastEdited') })
      } else {
        const event: DiaryEvent = {
          id: uuidv4(),
          type: 'message',
          at: time,
          data: { text } as MessageData,
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
        showToast({ message: t('messages.toastSaved') })
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
        showToast({ message: t('messages.toastDeleted') })
      } catch {
        setConfirmDelete(null)
        showToast({ message: t('toast.deleteFailed') })
      }
    } else {
      setConfirmDelete(event.id)
      setTimeout(() => setConfirmDelete(null), 3000)
    }
  }

  const openComposer = (event?: DiaryEvent) => {
    setEditTarget(event ?? null)
    setComposerOpen(true)
  }

  return (
    <div className="page-container" data-tour="messages">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div className="page-title">{t('messages.title')}</div>
          <div style={{ fontSize: 12, color: 'var(--stone-500)', marginTop: 2 }}>
            {t('messages.subtitle', { babyName })}
          </div>
        </div>
        <button
          className="btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          onClick={() => openComposer()}
        >
          <IconPlus size={14} color="white" />
          {t('messages.write')}
        </button>
      </div>

      <div style={{ marginBottom: 24 }}>
        <hr className="divider" />
      </div>

      {messageEvents.length === 0 ? (
        <div className="empty-state">
          {/* Envelope with heart illustration */}
          <svg width="64" height="52" viewBox="0 0 64 52" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="8" y="12" width="48" height="32" rx="4" stroke="var(--stone-300)" strokeWidth="1.5"/>
            <path d="M8 16L32 30L56 16" stroke="var(--stone-300)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M32 22C32 22 28.5 19 27 21C25.5 23 27 25 32 28C37 25 38.5 23 37 21C35.5 19 32 22 32 22Z" stroke="var(--rose-300)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <div className="empty-state-title">{t('messages.emptyTitle')}</div>
          <div className="empty-state-sub">{t('messages.emptySub', { babyName })}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
          {messageEvents.map((event, i) => {
            const data = event.data as MessageData
            return (
              <div
                key={`${event.id}-${event.rev}`}
                className="letter-card stagger-mount"
                style={{ '--i': i } as React.CSSProperties}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="letter-body">
                      {data.text}
                    </div>
                    <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                      <span style={{ fontSize: 11, color: 'var(--stone-400)' }}>
                        {format(parseISO(event.at), t('date.formatYear'), { locale: dateFnsLocale })}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--stone-400)' }}>
                        {t(`role.${event.author.role}`)} {event.author.name}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button
                      onClick={() => openComposer(event)}
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

      {composerOpen && (
        <MessageComposer
          initial={editTarget ?? undefined}
          babyName={babyName}
          onSave={handleSave}
          onClose={() => { setComposerOpen(false); setEditTarget(null) }}
        />
      )}
    </div>
  )
}
