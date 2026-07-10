import React, { useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { DiaryEvent } from '../../shared/types'
import { EventIcon, eventLabel } from './EventIcon'
import { formatEventValue, formatTime } from '../store/useAppStore'
import { TimeEditModal } from './TimeEditModal'
import { useAppStore } from '../store/useAppStore'
import { useToast } from './Toast'

interface EventTimelineProps {
  events: DiaryEvent[]
  showAuthor?: boolean
  /** If true, shows edit/delete controls */
  editable?: boolean
}

export function EventTimeline({ events, showAuthor = true, editable = true }: EventTimelineProps) {
  const { editEvent, softDeleteEvent } = useAppStore()
  const { showToast } = useToast()
  const [editingAt, setEditingAt] = useState<DiaryEvent | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const handleTimeEdit = async (event: DiaryEvent, newAt: string) => {
    await editEvent(event, { at: newAt })
    setEditingAt(null)
    showToast({ message: '시간이 수정되었습니다.' })
  }

  const handleDelete = async (event: DiaryEvent) => {
    if (confirmDelete === event.id) {
      await softDeleteEvent(event)
      setConfirmDelete(null)
      showToast({ message: '삭제되었습니다.' })
    } else {
      setConfirmDelete(event.id)
      setTimeout(() => setConfirmDelete(null), 3000)
    }
  }

  if (events.length === 0) {
    return (
      <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--stone-400)', fontSize: 13 }}>
        기록이 없습니다
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
                  {event.author.role === 'mom' ? '엄마' : '아빠'} {event.author.name}
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
                title="시간 수정"
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
                title={confirmDelete === event.id ? '한 번 더 눌러 삭제' : '삭제'}
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
