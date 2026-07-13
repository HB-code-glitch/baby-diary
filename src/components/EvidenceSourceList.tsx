import React, { useMemo, useState } from 'react'
import type { HealthContentLocale, HealthEvidenceSourceId } from '../../shared/healthEvidence'
import { getEvidenceSources } from '../../shared/healthEvidence'
import { ipc } from '../lib/ipc'

export interface EvidenceSourceListProps {
  sourceIds: readonly HealthEvidenceSourceId[]
  locale: HealthContentLocale
  compact?: boolean
}

function getSourceCountry(sourceId: HealthEvidenceSourceId): 'KR' | 'JP' | null {
  if (sourceId.startsWith('kdca-') || sourceId === 'kr-nfa-119') return 'KR'
  if (sourceId.startsWith('cfa-') || sourceId.startsWith('mhlw-') || sourceId === 'jp-fdma-119') return 'JP'
  return null
}

export function EvidenceSourceList({ sourceIds, locale, compact = false }: EvidenceSourceListProps) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState(false)
  const uniqueIds = useMemo(
    () => [...new Set(sourceIds)],
    [sourceIds],
  )
  const sources = useMemo(() => getEvidenceSources(uniqueIds, locale), [uniqueIds, locale])

  if (sources.length === 0) return null

  const copy = locale === 'ja'
    ? {
        summary: `公式根拠 ${sources.length}件`,
        reviewed: '確認日',
        open: '公式ページを開く',
        failed: '公式ページを開けませんでした。',
        countries: { KR: '韓国の公的機関', JP: '日本の公的機関' },
      }
    : {
        summary: `공식 근거 ${sources.length}개`,
        reviewed: '검토일',
        open: '공식 페이지 열기',
        failed: '공식 페이지를 열지 못했어요.',
        countries: { KR: '한국 공공기관', JP: '일본 공공기관' },
      }

  return (
    <details className={`evidence-source-list${compact ? ' is-compact' : ''}`} open={open}>
      <summary
        aria-expanded={open}
        onClick={event => {
          event.preventDefault()
          setOpen(value => !value)
        }}
      >
        <span>{copy.summary}</span>
        <span className="evidence-source-chevron" aria-hidden="true">⌄</span>
      </summary>
      {open && (
        <div className="evidence-source-items">
          {sources.map(source => {
            const country = getSourceCountry(source.id)
            return (
              <article className="evidence-source-item" key={source.id}>
                <div className="evidence-source-meta">
                  {country && (
                    <span className="evidence-country" data-evidence-country={country}>
                      {copy.countries[country]}
                    </span>
                  )}
                  <span>{source.organization}</span>
                </div>
                <div className="evidence-source-title">{source.title}</div>
                <div className="evidence-source-footer">
                  <span>{copy.reviewed} · {source.reviewedOn}</span>
                  <button
                    type="button"
                    className="evidence-source-button"
                    data-source-id={source.id}
                    onClick={async () => {
                      setError(false)
                      try {
                        await ipc.openEvidenceSource(source.id)
                      } catch {
                        setError(true)
                      }
                    }}
                  >
                    {copy.open}
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {error ? copy.failed : ''}
      </span>
    </details>
  )
}
