import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import ko from './ko.json'
import ja from './ja.json'

export type Language = 'ko' | 'ja'

/** Detect initial language from navigator.language; default to 'ko'. */
function detectLanguage(): Language {
  if (typeof navigator !== 'undefined') {
    const lang = navigator.language ?? ''
    if (lang.toLowerCase().startsWith('ja')) return 'ja'
  }
  return 'ko'
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      ko: { translation: ko },
      ja: { translation: ja },
    },
    lng: detectLanguage(),
    fallbackLng: 'ko',
    interpolation: {
      escapeValue: false, // React already escapes
    },
  })

export default i18n

/** Change language at runtime (no restart needed). */
export function setLanguage(lang: Language): void {
  i18n.changeLanguage(lang)
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-lang', lang)
    document.documentElement.setAttribute('lang', lang)
  }
}

/** Set initial data-lang attribute (called once on startup). */
export function initLangAttr(): void {
  if (typeof document !== 'undefined') {
    const lang = detectLanguage()
    document.documentElement.setAttribute('data-lang', lang)
    document.documentElement.setAttribute('lang', lang)
  }
}

export function getLanguage(): Language {
  return (i18n.language as Language) || 'ko'
}
