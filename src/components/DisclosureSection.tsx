import type { ReactNode } from 'react'

interface DisclosureSectionProps {
  title: string
  summary?: string
  defaultOpen?: boolean
  children: ReactNode
  className?: string
}

export function DisclosureSection({
  title,
  summary,
  defaultOpen = false,
  children,
  className = '',
}: DisclosureSectionProps) {
  return (
    <section className={`settings-section disclosure-section ${className}`.trim()}>
      <details open={defaultOpen}>
        <summary className="disclosure-summary">
          <span className="disclosure-heading">{title}</span>
          {summary && <span className="disclosure-meta">{summary}</span>}
          <span className="disclosure-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div className="disclosure-content">{children}</div>
      </details>
    </section>
  )
}
