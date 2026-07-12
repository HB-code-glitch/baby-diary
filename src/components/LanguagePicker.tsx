/**
 * LanguagePicker — first-launch full-screen language selection overlay
 *
 * Shown before the tutorial when babydiary.langChosen is not set.
 * z-index 1400 (above tutorial 1300).
 * Entrance: opacity + translateY only, with no layout shift.
 * No i18n keys used; labels are hardcoded in their own language.
 */

import React, { useEffect, useState } from 'react'
import type { Language } from '../i18n'

interface LanguagePickerProps {
  onPick: (lang: Language) => void
}

export function LanguagePicker({ onPick }: LanguagePickerProps) {
  const [mounted, setMounted] = useState(false)

  // Trigger entrance animation on next frame
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(id)
  }, [])

  return (
    <div
      className="lang-picker-overlay"
      aria-modal="true"
      role="dialog"
      aria-label="언어 선택 / 言語選択"
    >
      <div className={`lang-picker-card${mounted ? ' lang-picker-card-visible' : ''}`}>
        {/* Wordmark */}
        <div className="lang-picker-wordmark">Baby Diary</div>

        {/* Bilingual question — stacked */}
        <div className="lang-picker-question">
          <span className="lang-picker-q-ko">사용할 언어를 선택해주세요</span>
          <span className="lang-picker-q-ja">使用する言語を選んでください</span>
        </div>

        {/* Language buttons */}
        <div className="lang-picker-btns">
          <button
            className="lang-picker-btn"
            lang="ko"
            onClick={() => onPick('ko')}
            type="button"
          >
            한국어
          </button>
          <button
            className="lang-picker-btn"
            lang="ja"
            onClick={() => onPick('ja')}
            type="button"
          >
            日本語
          </button>
        </div>
      </div>
    </div>
  )
}

/** localStorage key for language-chosen flag */
export const LANG_CHOSEN_KEY = 'babydiary.langChosen'

export function isLangChosen(): boolean {
  try {
    return localStorage.getItem(LANG_CHOSEN_KEY) === '1'
  } catch {
    return false
  }
}

export function markLangChosen(): void {
  try {
    localStorage.setItem(LANG_CHOSEN_KEY, '1')
  } catch { /* ignore */ }
}
