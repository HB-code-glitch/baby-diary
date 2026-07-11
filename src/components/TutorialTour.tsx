/**
 * TutorialTour — spotlight coachmark tour (10 steps)
 *
 * Design requirements:
 * - Dark overlay with spotlight cutout (box-shadow technique)
 * - Tooltip card positioned adjacent to target, viewport-clamped
 * - Progress dots (bottom-center), skip pill (bottom-left)
 * - Esc=skip, Enter=next
 * - Overlay click = no-op
 * - Persists completion to localStorage('babydiary.tutorialDone')
 * - prefers-reduced-motion aware
 * - z-index 1300 (topmost)
 * - Works at 960x640+
 */

import React, { useEffect, useState, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Page } from './Sidebar'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TourStep {
  id: string
  page: Page
  /** CSS selector using data-tour attribute, e.g. '[data-tour="nav-home"]' */
  targetSelector?: string
  titleKey: string
  bodyKey: string
  /** Preferred placement: 'right' | 'left' | 'bottom' | 'top' | 'center' */
  placement: 'right' | 'left' | 'bottom' | 'top' | 'center'
}

interface TutorialTourProps {
  onNavigate: (page: Page) => void
  onDone: () => void
}

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'babydiary.tutorialDone'

export function isTutorialDone(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function markTutorialDone(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch { /* ignore */ }
}

export function resetTutorial(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Tour steps definition (10 steps)
// ---------------------------------------------------------------------------

const STEPS: TourStep[] = [
  {
    id: 'nav-home',
    page: 'home',
    targetSelector: '[data-tour="nav-home"]',
    titleKey: 'tour.step1Title',
    bodyKey: 'tour.step1Body',
    placement: 'right',
  },
  {
    id: 'quick-row',
    page: 'home',
    targetSelector: '[data-tour="quick-row"]',
    titleKey: 'tour.step2Title',
    bodyKey: 'tour.step2Body',
    placement: 'bottom',
  },
  {
    id: 'hero',
    page: 'home',
    targetSelector: '[data-tour="hero"]',
    titleKey: 'tour.step3Title',
    bodyKey: 'tour.step3Body',
    placement: 'bottom',
  },
  {
    id: 'insights',
    page: 'home',
    targetSelector: '[data-tour="insights"]',
    titleKey: 'tour.step4Title',
    bodyKey: 'tour.step4Body',
    placement: 'left',
  },
  {
    id: 'calendar',
    page: 'history',
    targetSelector: '[data-tour="calendar"]',
    titleKey: 'tour.step5Title',
    bodyKey: 'tour.step5Body',
    placement: 'bottom',
  },
  {
    id: 'stats',
    page: 'stats',
    targetSelector: '[data-tour="stats"]',
    titleKey: 'tour.step6Title',
    bodyKey: 'tour.step6Body',
    placement: 'bottom',
  },
  {
    id: 'diary',
    page: 'diary',
    targetSelector: '[data-tour="diary"]',
    titleKey: 'tour.step7Title',
    bodyKey: 'tour.step7Body',
    placement: 'bottom',
  },
  {
    id: 'messages',
    page: 'messages',
    targetSelector: '[data-tour="messages"]',
    titleKey: 'tour.step8Title',
    bodyKey: 'tour.step8Body',
    placement: 'bottom',
  },
  {
    id: 'settings-main',
    page: 'settings',
    targetSelector: '[data-tour="settings-main"]',
    titleKey: 'tour.step9Title',
    bodyKey: 'tour.step9Body',
    placement: 'bottom',
  },
  {
    id: 'finish',
    page: 'home',
    targetSelector: undefined,
    titleKey: 'tour.step10Title',
    bodyKey: 'tour.step10Body',
    placement: 'center',
  },
]

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const PADDING = 6       // spotlight padding around target
const TOOLTIP_W = 300   // tooltip card width
const TOOLTIP_H = 180   // estimated tooltip height
const EDGE_GAP = 12     // minimum gap from viewport edge

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

interface TooltipPosition {
  top?: number
  left?: number
  bottom?: number
  right?: number
  transform?: string
}

function computeTooltipPosition(
  targetRect: Rect | null,
  placement: TourStep['placement'],
  vw: number,
  vh: number
): TooltipPosition {
  if (!targetRect || placement === 'center') {
    // Centered in viewport
    return {
      top: '50%' as unknown as number,
      left: '50%' as unknown as number,
      transform: 'translate(-50%, -50%)',
    }
  }

  const { top, left, width, height } = targetRect
  const padded = {
    top: top - PADDING,
    left: left - PADDING,
    width: width + PADDING * 2,
    height: height + PADDING * 2,
  }

  let pos: TooltipPosition = {}

  switch (placement) {
    case 'right': {
      const rawLeft = padded.left + padded.width + 12
      const clampedLeft = Math.min(rawLeft, vw - TOOLTIP_W - EDGE_GAP)
      const rawTop = padded.top + padded.height / 2 - TOOLTIP_H / 2
      const clampedTop = Math.max(EDGE_GAP, Math.min(rawTop, vh - TOOLTIP_H - EDGE_GAP))
      pos = { top: clampedTop, left: clampedLeft }
      break
    }
    case 'left': {
      const rawLeft = padded.left - TOOLTIP_W - 12
      const clampedLeft = Math.max(EDGE_GAP, rawLeft)
      const rawTop = padded.top + padded.height / 2 - TOOLTIP_H / 2
      const clampedTop = Math.max(EDGE_GAP, Math.min(rawTop, vh - TOOLTIP_H - EDGE_GAP))
      pos = { top: clampedTop, left: clampedLeft }
      break
    }
    case 'bottom': {
      const rawTop = padded.top + padded.height + 12
      // Flip above if overflows
      const fitsBelow = rawTop + TOOLTIP_H < vh - EDGE_GAP
      const finalTop = fitsBelow ? rawTop : padded.top - TOOLTIP_H - 12
      const rawLeft = padded.left + padded.width / 2 - TOOLTIP_W / 2
      const clampedLeft = Math.max(EDGE_GAP, Math.min(rawLeft, vw - TOOLTIP_W - EDGE_GAP))
      pos = { top: Math.max(EDGE_GAP, finalTop), left: clampedLeft }
      break
    }
    case 'top': {
      const rawTop = padded.top - TOOLTIP_H - 12
      const fitsAbove = rawTop > EDGE_GAP
      const finalTop = fitsAbove ? rawTop : padded.top + padded.height + 12
      const rawLeft = padded.left + padded.width / 2 - TOOLTIP_W / 2
      const clampedLeft = Math.max(EDGE_GAP, Math.min(rawLeft, vw - TOOLTIP_W - EDGE_GAP))
      pos = { top: Math.max(EDGE_GAP, finalTop), left: clampedLeft }
      break
    }
  }

  return pos
}

// ---------------------------------------------------------------------------
// Spotlight overlay styles
// ---------------------------------------------------------------------------

function buildSpotlightStyle(
  targetRect: Rect | null,
  placement: TourStep['placement'],
  isDark: boolean
): React.CSSProperties {
  const dimColor = isDark
    ? 'rgba(0,0,0,0.66)'
    : 'rgba(20,18,15,0.55)'

  if (!targetRect || placement === 'center') {
    return {
      position: 'fixed',
      inset: 0,
      zIndex: 1300,
      background: dimColor,
      pointerEvents: 'none',
    }
  }

  const { top, left, width, height } = targetRect
  const pt = top - PADDING
  const pl = left - PADDING
  const pw = width + PADDING * 2
  const ph = height + PADDING * 2

  // Ring color
  const ringColor = isDark
    ? 'rgba(255,214,140,0.95)'
    : 'rgba(244,185,94,0.9)'

  return {
    position: 'fixed',
    inset: 0,
    zIndex: 1300,
    pointerEvents: 'none',
    // clip-path approach: outer rect minus inner spotlight rect
    // We use a combined box-shadow on the highlight div instead.
    background: 'transparent',
  }
}

// ---------------------------------------------------------------------------
// Main TutorialTour component
// ---------------------------------------------------------------------------

export function TutorialTour({ onNavigate, onDone }: TutorialTourProps) {
  const { t } = useTranslation()
  const [stepIndex, setStepIndex] = useState(0)
  const [targetRect, setTargetRect] = useState<Rect | null>(null)
  const [visible, setVisible] = useState(false)
  const measureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevPage = useRef<Page | null>(null)

  const step = STEPS[stepIndex]
  const isLast = stepIndex === STEPS.length - 1

  // Detect dark theme
  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute('data-theme') === 'dark'
  )

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.getAttribute('data-theme') === 'dark')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  // Measure target element
  const measureTarget = useCallback(() => {
    if (!step.targetSelector) {
      setTargetRect(null)
      setVisible(true)
      return
    }
    const el = document.querySelector(step.targetSelector)
    if (el) {
      const rect = el.getBoundingClientRect()
      setTargetRect({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      })
      setVisible(true)
    } else {
      // Element not found — show centered
      setTargetRect(null)
      setVisible(true)
    }
  }, [step.targetSelector])

  // Navigate to step's page and measure after render
  useEffect(() => {
    setVisible(false)

    if (step.page !== prevPage.current) {
      prevPage.current = step.page
      onNavigate(step.page)
    }

    // Wait for page render + layout
    if (measureTimerRef.current) clearTimeout(measureTimerRef.current)
    measureTimerRef.current = setTimeout(() => {
      // rAF to ensure DOM paint
      requestAnimationFrame(() => {
        measureTarget()
      })
    }, 180)

    return () => {
      if (measureTimerRef.current) clearTimeout(measureTimerRef.current)
    }
  }, [stepIndex, step.page, onNavigate, measureTarget])

  // Re-measure on resize
  useEffect(() => {
    const handler = () => {
      if (measureTimerRef.current) clearTimeout(measureTimerRef.current)
      measureTimerRef.current = setTimeout(measureTarget, 100)
    }
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [measureTarget])

  // Keyboard controls
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleSkip()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        handleNext()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex])

  const handleNext = () => {
    if (isLast) {
      markTutorialDone()
      onDone()
    } else {
      setStepIndex(i => i + 1)
    }
  }

  const handleSkip = () => {
    markTutorialDone()
    onDone()
  }

  const vw = window.innerWidth
  const vh = window.innerHeight

  const tooltipPos = computeTooltipPosition(targetRect, step.placement, vw, vh)

  // Spotlight ring color
  const ringColor = isDark
    ? 'rgba(255,214,140,0.95)'
    : 'rgba(244,185,94,0.9)'

  const dimColor = isDark
    ? 'rgba(0,0,0,0.66)'
    : 'rgba(20,18,15,0.55)'

  // Reduce motion
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  return (
    <>
      {/* ── Dim overlay (click = no-op) ── */}
      {step.placement === 'center' || !targetRect ? (
        <div
          className="tour-overlay tour-overlay-full"
          style={{ background: dimColor }}
          onClick={e => e.stopPropagation()}
          aria-hidden="true"
        />
      ) : (
        /* Spotlight: four rects around the target */
        <>
          {/* Top strip */}
          <div
            className="tour-overlay-strip"
            style={{
              top: 0,
              left: 0,
              right: 0,
              height: Math.max(0, targetRect.top - PADDING),
              background: dimColor,
            }}
            onClick={e => e.stopPropagation()}
            aria-hidden="true"
          />
          {/* Bottom strip */}
          <div
            className="tour-overlay-strip"
            style={{
              top: targetRect.top + targetRect.height + PADDING,
              left: 0,
              right: 0,
              bottom: 0,
              background: dimColor,
            }}
            onClick={e => e.stopPropagation()}
            aria-hidden="true"
          />
          {/* Left strip */}
          <div
            className="tour-overlay-strip"
            style={{
              top: Math.max(0, targetRect.top - PADDING),
              left: 0,
              width: Math.max(0, targetRect.left - PADDING),
              height: targetRect.height + PADDING * 2,
              background: dimColor,
            }}
            onClick={e => e.stopPropagation()}
            aria-hidden="true"
          />
          {/* Right strip */}
          <div
            className="tour-overlay-strip"
            style={{
              top: Math.max(0, targetRect.top - PADDING),
              left: targetRect.left + targetRect.width + PADDING,
              right: 0,
              height: targetRect.height + PADDING * 2,
              background: dimColor,
            }}
            onClick={e => e.stopPropagation()}
            aria-hidden="true"
          />
          {/* Spotlight ring */}
          <div
            className="tour-spotlight-ring"
            style={{
              position: 'fixed',
              top: targetRect.top - PADDING,
              left: targetRect.left - PADDING,
              width: targetRect.width + PADDING * 2,
              height: targetRect.height + PADDING * 2,
              borderRadius: 10,
              boxShadow: `0 0 0 2px ${ringColor}, 0 0 0 4px ${isDark ? 'rgba(255,214,140,0.22)' : 'rgba(244,185,94,0.28)'}, 0 0 18px 4px ${isDark ? 'rgba(255,214,140,0.18)' : 'rgba(244,185,94,0.20)'}`,
              pointerEvents: 'none',
              zIndex: 1301,
            }}
            aria-hidden="true"
          />
        </>
      )}

      {/* ── Tooltip card ── */}
      {visible && (
        <div
          className={`tour-tooltip${prefersReducedMotion ? '' : ' tour-tooltip-animate'}`}
          style={{
            position: 'fixed',
            zIndex: 1302,
            width: TOOLTIP_W,
            ...tooltipPos,
          }}
          role="dialog"
          aria-modal="false"
          aria-label={t(step.titleKey)}
        >
          {/* Counter */}
          <div className="tour-counter">
            {stepIndex + 1}/{STEPS.length}
          </div>

          {/* Title */}
          <div className="tour-title">{t(step.titleKey)}</div>

          {/* Body */}
          <div className="tour-body">{t(step.bodyKey)}</div>

          {/* Next / Finish button */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
            <button
              className="btn-primary tour-next-btn"
              onClick={handleNext}
              autoFocus
            >
              {isLast ? t('tour.start') : t('tour.next')}
            </button>
          </div>
        </div>
      )}

      {/* ── Progress dots (bottom-center) ── */}
      {visible && (
        <div
          className="tour-progress-dots"
          style={{ zIndex: 1302 }}
          aria-label={`${stepIndex + 1} / ${STEPS.length}`}
        >
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`tour-dot${i === stepIndex ? ' active' : ''}`}
              aria-hidden="true"
            />
          ))}
        </div>
      )}

      {/* ── Skip pill (bottom-left) ── */}
      {visible && (
        <button
          className="tour-skip-pill"
          style={{ zIndex: 1302 }}
          onClick={handleSkip}
          aria-label={t('tour.skip')}
        >
          {t('tour.skip')}
        </button>
      )}
    </>
  )
}
