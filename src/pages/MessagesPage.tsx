import React, { useState, useMemo } from 'react'
import { Plus, Pencil, Trash2, X, Mail } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { ko } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { useToast } from '../components/Toast'
import { DiaryEvent, MessageData } from '../../shared/types'
import { v4 as uuidv4 } from 'uuid'

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
              {initial ? '메시지 수정' : `${babyName}에게`}
            </div>
            <div style={{ fontSize: 12, color: 'var(--stone-500)', marginTop: 2 }}>
              아이가 크면 읽을 메시지를 남겨요
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--stone-500)' }}
          >
            <X size={18} />
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
          placeholder={`우리 ${babyName}에게…`}
          value={text}
          onChange={e => setText(e.target.value)}
          autoFocus
        />

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose}>취소</button>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={saving || !text.trim()}
            style={{ opacity: !text.trim() ? 0.5 : 1 }}
          >
            {saving ? '저장 중...' : '보내기'}
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

  const [composerOpen, setComposerOpen] = useState(false)
  const [editTarget, setEditTarget]     = useState<DiaryEvent | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const babyName = settings?.baby?.name || '아기'

  const messageEvents = useMemo(() =>
    events
      .filter(e => !e.deleted && e.type === 'message')
      .sort((a, b) => b.at.localeCompare(a.at)),
    [events]
  )

  const handleSave = async (text: string) => {
    const t = new Date().toISOString()
    if (editTarget) {
      await editEvent(editTarget, { data: { text } as MessageData })
      showToast({ message: '메시지가 수정되었습니다.' })
    } else {
      const event: DiaryEvent = {
        id: uuidv4(),
        type: 'message',
        at: t,
        data: { text } as MessageData,
        author: {
          uid:  settings?.profile?.uid  ?? 'local',
          name: settings?.profile?.name ?? '나',
          role: settings?.profile?.role ?? 'mom',
        },
        createdAt: t,
        updatedAt: t,
        rev: 1,
        deleted: false,
      }
      await addEvent(event)
      showToast({ message: '메시지가 저장되었습니다.' })
    }
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

  const openComposer = (event?: DiaryEvent) => {
    setEditTarget(event ?? null)
    setComposerOpen(true)
  }

  return (
    <div className="page-container">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div>
          <div className="page-title">아기에게</div>
          <div style={{ fontSize: 12, color: 'var(--stone-500)', marginTop: 2 }}>
            {babyName}가 크면 읽을 편지들
          </div>
        </div>
        <button
          className="btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          onClick={() => openComposer()}
        >
          <Plus size={14} />
          편지 쓰기
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
          <div className="empty-state-title">아직 편지가 없어요</div>
          <div className="empty-state-sub">오늘의 마음을 {babyName}에게 남겨보세요</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {messageEvents.map(event => {
            const data = event.data as MessageData
            return (
              <div key={`${event.id}-${event.rev}`} className="letter-card">
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 14, color: 'var(--stone-700)', lineHeight: 1.8,
                      whiteSpace: 'pre-line',
                    }}>
                      {data.text}
                    </div>
                    <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                      <span style={{ fontSize: 11, color: 'var(--stone-400)' }}>
                        {format(parseISO(event.at), 'yyyy년 M월 d일', { locale: ko })}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--stone-400)' }}>
                        {event.author.role === 'mom' ? '엄마' : '아빠'} {event.author.name}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button
                      onClick={() => openComposer(event)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--stone-400)', borderRadius: 5 }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => handleDelete(event)}
                      style={{
                        background: confirmDelete === event.id ? '#fff0f0' : 'none',
                        border: 'none', cursor: 'pointer', padding: 4,
                        color: confirmDelete === event.id ? '#c44' : 'var(--stone-400)',
                        borderRadius: 5,
                      }}
                    >
                      <Trash2 size={13} />
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
