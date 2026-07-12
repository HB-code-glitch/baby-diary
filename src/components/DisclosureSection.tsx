import { useEffect, useRef, useState } from 'react'
import type { ReactNode, SyntheticEvent } from 'react'

interface DisclosureSectionProps {
  title: string
  summary?: string
  defaultOpen?: boolean
  children: ReactNode
  className?: string
}

export function resolveDisclosureOpenState(
  currentOpen: boolean,
  previousDefaultOpen: boolean,
  defaultOpen: boolean,
): boolean {
  return !previousDefaultOpen && defaultOpen ? true : currentOpen
}

export function DisclosureSection({
  title,
  summary,
  defaultOpen = false,
  children,
  className = '',
}: DisclosureSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const previousDefaultOpen = useRef(defaultOpen)

  useEffect(() => {
    const wasDefaultOpen = previousDefaultOpen.current
    previousDefaultOpen.current = defaultOpen
    setIsOpen(currentOpen => resolveDisclosureOpenState(currentOpen, wasDefaultOpen, defaultOpen))
  }, [defaultOpen])

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setIsOpen(event.currentTarget.open)
  }

  return (
    <section className={`settings-section disclosure-section ${className}`.trim()}>
      <details open={isOpen} onToggle={handleToggle}>
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
