import React, { useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { DiaryEvent } from '../../shared/types'
import { EventIcon, eventLabel } from './EventIcon'
import { formatEventValue, formatTime } from '../store/useAppStore'
import { TimeEditModal } from './TimeEditModal'
import { useAppStore } from '../store/useAppStore'
import { useToast } from './Toast'
import { useTranslation } from 'react-i18next'

interface EventTimelineProps {
  events: DiaryEvent[]
  showAuthor?: boolean
  /** If true, shows edit/delete controls */
  editable?: boolean
}

export function EventTimeline({ events, showAuthor = true, editable = true }: EventTimelineProps) {
  const { editEvent, softDeleteEvent } = useAppStore()
  const { showToast } = useToast()
  const { t } = useTranslation()
  const [editingAt, setEditingAt] = useState<DiaryEvent | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const handleTimeEdit = async (event: DiaryEvent, newAt: string) => {
    await editEvent(event, { at: newAt })
    setEditingAt(null)
    showToast({ message: t('toast.timeEdited') })
  }

  const handleDelete = async (event: DiaryEvent) => {
    if (confirmDelete === event.id) {
      await softDeleteEvent(event)
      setConfirmDelete(null)
      showToast({ message: t('toast.deleted') })
    } else {
      setConfirmDelete(event.id)
      setTimeout(() => setConfirmDelete(null), 3000)
    }
  }

  if (events.length === 0) {
    return (
      <div className="empty-state">
        {/* Sleeping moon + stars illustration */}
        <svg width="56" height="48" viewBox="0 0 56 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M22 36C22 27.163 29.163 20 38 20C39.4 20 40.76 20.18 42.06 20.52C40.14 14.42 34.54 10 28 10C19.716 10 13 16.716 13 25C13 33.284 19.716 40 28 40C29.14 40 30.26 39.87 31.32 39.62C25.8 38.3 22 32.58 22 36Z" stroke="var(--stone-300)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="42" cy="9" r="2" stroke="var(--stone-300)" strokeWidth="1.5"/>
          <circle cx="50" cy="18" r="1.5" stroke="var(--stone-300)" strokeWidth="1.5"/>
          <circle cx="46" cy="3" r="1" stroke="var(--stone-300)" strokeWidth="1.5"/>
        </svg>
        <div className="empty-state-title">{t('timeline.emptyTitle')}</div>
        <div className="empty-state-sub">{t('timeline.emptySub')}</div>
      </div>
    )
  }

  return (
    <>
      {events.map(event => (
        <div key={`${event.id}-${event.rev}`} className="timeline-item">
          <EventIcon type={event.type} />

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-800)' }}>
                {eventLabel(event.type)}
              </span>
              <span style={{ fontSize: 13, color: 'var(--stone-600)' }}>
                {formatEventValue(event)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
              <span style={{ fontSize: 11, color: 'var(--stone-400)' }}>
                {formatTime(event.at)}
              </span>
              {showAuthor && event.author?.name && (
                <span style={{ fontSize: 11, color: 'var(--stone-400)' }}>
                  {t(`role.${event.author.role}`)} {event.author.name}
                </span>
              )}
            </div>
          </div>

          {editable && (
            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              <button
                onClick={() => setEditingAt(event)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: '4px', color: 'var(--stone-400)', borderRadius: 5,
                }}
                title={t('timeline.editTime')}
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={() => handleDelete(event)}
                style={{
                  background: confirmDelete === event.id ? '#fff0f0' : 'none',
                  border: 'none', cursor: 'pointer',
                  padding: '4px',
                  color: confirmDelete === event.id ? '#c44' : 'var(--stone-400)',
                  borderRadius: 5,
                }}
                title={confirmDelete === event.id ? t('timeline.confirmDelete') : t('timeline.delete')}
              >
                <Trash2 size={13} />
              </button>
            </div>
          )}
        </div>
      ))}

      {editingAt && (
        <TimeEditModal
          currentAt={editingAt.at}
          onConfirm={(newAt) => handleTimeEdit(editingAt, newAt)}
          onClose={() => setEditingAt(null)}
        />
      )}
    </>
  )
}
