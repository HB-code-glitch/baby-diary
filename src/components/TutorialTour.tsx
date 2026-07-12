import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Page } from './Sidebar'
import { TutorialCard } from './TutorialCard'
import {
  markTutorialExit,
  TUTORIAL_STEPS,
  type TutorialExitReason,
  type TutorialPlacement,
} from '../lib/tutorial'

interface TutorialTourProps {
  onNavigate: (page: Page) => void
  onExit: (reason: TutorialExitReason) => void
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

interface Viewport {
  width: number
  height: number
}

const SPOTLIGHT_PADDING = 6
const CARD_WIDTH = 400
const EDGE_GAP = 12
const TARGET_GAP = 12

function currentViewport(): Viewport {
  if (typeof window === 'undefined') return { width: 960, height: 640 }
  return { width: window.innerWidth, height: window.innerHeight }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, Math.max(minimum, maximum)))
}

function computeCardPosition(
  targetRect: Rect | null,
  placement: TutorialPlacement,
  viewport: Viewport,
  cardHeight: number,
): React.CSSProperties {
  const cardWidth = Math.min(CARD_WIDTH, viewport.width - EDGE_GAP * 2)
  const maxLeft = viewport.width - cardWidth - EDGE_GAP
  const maxTop = viewport.height - cardHeight - EDGE_GAP

  if (!targetRect || placement === 'center') {
    return {
      top: clamp((viewport.height - cardHeight) / 2, EDGE_GAP, maxTop),
      left: clamp((viewport.width - cardWidth) / 2, EDGE_GAP, maxLeft),
    }
  }

  const padded = {
    top: targetRect.top - SPOTLIGHT_PADDING,
    left: targetRect.left - SPOTLIGHT_PADDING,
    width: targetRect.width + SPOTLIGHT_PADDING * 2,
    height: targetRect.height + SPOTLIGHT_PADDING * 2,
  }
  const centeredTop = padded.top + padded.height / 2 - cardHeight / 2
  const centeredLeft = padded.left + padded.width / 2 - cardWidth / 2

  switch (placement) {
    case 'right':
      return {
        top: clamp(centeredTop, EDGE_GAP, maxTop),
        left: clamp(padded.left + padded.width + TARGET_GAP, EDGE_GAP, maxLeft),
      }
    case 'left':
      return {
        top: clamp(centeredTop, EDGE_GAP, maxTop),
        left: clamp(padded.left - cardWidth - TARGET_GAP, EDGE_GAP, maxLeft),
      }
    case 'bottom': {
      const below = padded.top + padded.height + TARGET_GAP
      const top = below + cardHeight <= viewport.height - EDGE_GAP
        ? below
        : padded.top - cardHeight - TARGET_GAP
      return {
        top: clamp(top, EDGE_GAP, maxTop),
        left: clamp(centeredLeft, EDGE_GAP, maxLeft),
      }
    }
    case 'top': {
      const above = padded.top - cardHeight - TARGET_GAP
      const top = above >= EDGE_GAP
        ? above
        : padded.top + padded.height + TARGET_GAP
      return {
        top: clamp(top, EDGE_GAP, maxTop),
        left: clamp(centeredLeft, EDGE_GAP, maxLeft),
      }
    }
  }
}

function spotlightGeometry(rect: Rect): React.CSSProperties {
  return {
    top: rect.top - SPOTLIGHT_PADDING,
    left: rect.left - SPOTLIGHT_PADDING,
    width: rect.width + SPOTLIGHT_PADDING * 2,
    height: rect.height + SPOTLIGHT_PADDING * 2,
  }
}

function isBlockedInteractiveTarget(target: EventTarget | null, primary: HTMLButtonElement | null): boolean {
  if (!(target instanceof Element)) return false
  if (primary && (target === primary || primary.contains(target))) return false

  const control = target.closest('input, textarea, select, button')
  if (control) return true

  const editable = target.closest('[contenteditable]')
  return editable !== null && editable.getAttribute('contenteditable') !== 'false'
}

export function TutorialTour({ onNavigate, onExit }: TutorialTourProps) {
  const [stepIndex, setStepIndex] = useState(0)
  const [targetRect, setTargetRect] = useState<Rect | null>(null)
  const [cardHeight, setCardHeight] = useState(0)
  const [visible, setVisible] = useState(false)
  const [viewport, setViewport] = useState<Viewport>(currentViewport)
  const cardRef = useRef<HTMLElement>(null)
  const measureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const measureFrameRef = useRef<number | null>(null)
  const previousPageRef = useRef<Page | null>(null)

  const step = TUTORIAL_STEPS[stepIndex]
  const compact = viewport.width <= 720 || viewport.height <= 600

  const handleSkip = useCallback(() => {
    markTutorialExit('skipped')
    onExit('skipped')
  }, [onExit])

  const handleNext = useCallback(() => {
    if (stepIndex === TUTORIAL_STEPS.length - 1) {
      markTutorialExit('completed')
      onExit('completed')
      return
    }
    setStepIndex(index => index + 1)
  }, [onExit, stepIndex])

  const handleBack = useCallback(() => {
    setStepIndex(index => Math.max(0, index - 1))
  }, [])

  const measureTarget = useCallback(() => {
    if (!step.targetSelector) {
      setTargetRect(null)
      setVisible(true)
      return
    }

    const target = document.querySelector(step.targetSelector)
    if (!target) {
      setTargetRect(null)
      setVisible(true)
      return
    }

    const rect = target.getBoundingClientRect()
    setTargetRect({ top: rect.top, left: rect.left, width: rect.width, height: rect.height })
    setVisible(true)
  }, [step.targetSelector])

  useLayoutEffect(() => {
    const background = Array.from(document.querySelectorAll<HTMLElement>('.sidebar, .main-content'))
    const previousInert = background.map(element => ({
      element,
      value: element.getAttribute('inert'),
    }))
    const previousOverflow = document.body.style.overflow
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const restoreReplayFocus = previouslyFocused?.matches('[data-tutorial-replay]') ?? false

    background.forEach(element => element.setAttribute('inert', ''))
    document.body.style.overflow = 'hidden'

    return () => {
      previousInert.forEach(({ element, value }) => {
        if (value === null) element.removeAttribute('inert')
        else element.setAttribute('inert', value)
      })
      document.body.style.overflow = previousOverflow
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus()
      } else if (restoreReplayFocus) {
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>('[data-tutorial-replay]')?.focus()
        })
      }
    }
  }, [])

  useEffect(() => {
    setVisible(false)
    setCardHeight(0)

    if (step.page !== previousPageRef.current) {
      previousPageRef.current = step.page
      onNavigate(step.page)
    }

    if (measureTimerRef.current) clearTimeout(measureTimerRef.current)
    measureTimerRef.current = setTimeout(() => {
      if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current)
      measureFrameRef.current = requestAnimationFrame(() => {
        measureFrameRef.current = null
        measureTarget()
      })
    }, 180)

    return () => {
      if (measureTimerRef.current) clearTimeout(measureTimerRef.current)
      if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current)
    }
  }, [measureTarget, onNavigate, step.page, stepIndex])

  useLayoutEffect(() => {
    if (!visible || !cardRef.current) return
    const measuredHeight = cardRef.current.offsetHeight
    setCardHeight(previous => previous === measuredHeight ? previous : measuredHeight)
  }, [stepIndex, viewport.height, viewport.width, visible])

  useEffect(() => {
    if (!visible || !cardRef.current) return
    const frame = requestAnimationFrame(() => {
      cardRef.current?.querySelector<HTMLButtonElement>('.tour-primary-button')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [stepIndex, visible])

  useEffect(() => {
    const handler = () => {
      if (measureTimerRef.current) clearTimeout(measureTimerRef.current)
      measureTimerRef.current = setTimeout(() => {
        setViewport(currentViewport())
        measureTarget()
      }, 100)
    }
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [measureTarget])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        handleSkip()
        return
      }

      const primary = cardRef.current?.querySelector<HTMLButtonElement>('.tour-primary-button') ?? null
      if (isBlockedInteractiveTarget(event.target, primary)) return

      if (event.key === 'ArrowLeft' && stepIndex > 0) {
        event.preventDefault()
        handleBack()
      } else if (event.key === 'ArrowRight' || event.key === 'Enter') {
        event.preventDefault()
        handleNext()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleBack, handleNext, handleSkip, stepIndex])

  const cardPosition = compact
    ? {}
    : computeCardPosition(targetRect, step.placement, viewport, cardHeight)
  const spotlightStyle = targetRect && step.placement !== 'center'
    ? spotlightGeometry(targetRect)
    : null

  return (
    <div className="tour-stage">
      {spotlightStyle ? (
        <>
          <div className="tour-backdrop tour-backdrop-top" style={{ height: spotlightStyle.top }} aria-hidden="true" />
          <div
            className="tour-backdrop tour-backdrop-bottom"
            style={{ top: Number(spotlightStyle.top) + Number(spotlightStyle.height) }}
            aria-hidden="true"
          />
          <div
            className="tour-backdrop tour-backdrop-left"
            style={{ top: spotlightStyle.top, width: spotlightStyle.left, height: spotlightStyle.height }}
            aria-hidden="true"
          />
          <div
            className="tour-backdrop tour-backdrop-right"
            style={{ top: spotlightStyle.top, left: Number(spotlightStyle.left) + Number(spotlightStyle.width), height: spotlightStyle.height }}
            aria-hidden="true"
          />
          <div className="tour-spotlight-ring" style={spotlightStyle} aria-hidden="true" />
          <div className="tour-target-shield" style={spotlightStyle} aria-hidden="true" />
        </>
      ) : (
        <div className="tour-backdrop tour-backdrop-full" aria-hidden="true" />
      )}

      {visible && (
        <TutorialCard
          step={step}
          stepIndex={stepIndex}
          totalSteps={TUTORIAL_STEPS.length}
          position={cardPosition}
          compact={compact}
          onBack={handleBack}
          onNext={handleNext}
          onSkip={handleSkip}
          cardRef={cardRef}
        />
      )}
    </div>
  )
}
