import React, { useState, useMemo } from 'react'
import { Plus, Pencil, Trash2, X, BookOpen } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { ko } from 'date-fns/locale'
import { useAppStore } from '../store/useAppStore'
import { useToast } from '../components/Toast'
import { DiaryEvent, DiaryData } from '../../shared/types'
import { v4 as uuidv4 } from 'uuid'

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
            {initial ? '일기 수정' : '일기 쓰기'}
          </span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--stone-500)' }}
          >
            <X size={18} />
          </button>
        </div>

        <div>
          <div className="label">제목 (선택)</div>
          <input
            type="text"
            className="input-field"
            placeholder="오늘의 제목..."
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
        </div>

        <div>
          <div className="label">내용</div>
          <textarea
            className="textarea-field"
            placeholder="오늘 있었던 일을 기록해요..."
            style={{ minHeight: 160 }}
            value={text}
            onChange={e => setText(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose}>취소</button>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={saving || !text.trim()}
            style={{ opacity: !text.trim() ? 0.5 : 1 }}
          >
            {saving ? '저장 중...' : '저장'}
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

  const [editorOpen, setEditorOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<DiaryEvent | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const diaryEvents = useMemo(() =>
    events
      .filter(e => !e.deleted && e.type === 'diary')
      .sort((a, b) => b.at.localeCompare(a.at)),
    [events]
  )

  const handleSave = async (title: string, text: string) => {
    const t = new Date().toISOString()
    if (editTarget) {
      await editEvent(editTarget, { data: { title, text } as DiaryData })
      showToast({ message: '일기가 수정되었습니다.' })
    } else {
      const event: DiaryEvent = {
        id: uuidv4(),
        type: 'diary',
        at: t,
        data: { title, text } as DiaryData,
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
      showToast({ message: '일기가 저장되었습니다.' })
    }
  }

  const handleDelete = async (event: DiaryEvent) => {
    if (confirmDelete === event.id) {
      await softDeleteEvent(event)
      setConfirmDelete(null)
      showToast({ message: '일기가 삭제되었습니다.' })
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
    <div className="page-container">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div className="page-title">일기</div>
        <button
          className="btn-primary"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          onClick={() => openEditor()}
        >
          <Plus size={14} />
          일기 쓰기
        </button>
      </div>

      {diaryEvents.length === 0 ? (
        <div
          className="card"
          style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--stone-400)' }}
        >
          <BookOpen size={32} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
          <div style={{ fontSize: 14 }}>아직 일기가 없어요.</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>소중한 오늘을 기록해보세요.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {diaryEvents.map(event => {
            const data = event.data as DiaryData
            return (
              <div key={`${event.id}-${event.rev}`} className="card" style={{ padding: '16px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {data.title && (
                      <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--stone-800)', marginBottom: 4 }}>
                        {data.title}
                      </div>
                    )}
                    <div style={{ fontSize: 13, color: 'var(--stone-600)', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
                      {data.text.length > 120 ? data.text.slice(0, 120) + '…' : data.text}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--stone-400)' }}>
                        {format(parseISO(event.at), 'yyyy년 M월 d일 EEEEE', { locale: ko })}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--stone-400)' }}>
                        {event.author.role === 'mom' ? '엄마' : '아빠'} {event.author.name}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button
                      onClick={() => openEditor(event)}
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
