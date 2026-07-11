import { AppSettings } from '../../shared/types'

// ---------------------------------------------------------------------------
// Pure merge helper — no React dependency, fully unit-testable
//
// Rule: if the saved (disk) value is non-empty and the form value is empty
//       → keep the saved value (never blank-overwrite real data).
//       If the form value is non-empty → use the form value (normal edit).
// ---------------------------------------------------------------------------

export interface FormSnapshot {
  babyName: string
  birthdate: string
  babyGender: 'girl' | 'boy' | undefined
  myName: string
}

function pickString(saved: string | undefined, formVal: string): string {
  const savedNE = (saved ?? '').trim()
  const formNE  = formVal.trim()
  if (savedNE && !formNE) return savedNE  // guard: never blank-overwrite
  return formNE                            // normal: use what the user typed
}

function pickGender(
  saved: 'girl' | 'boy' | undefined,
  formVal: 'girl' | 'boy' | undefined,
): 'girl' | 'boy' | undefined {
  if (saved && !formVal) return saved
  return formVal
}

/**
 * Merge disk-fresh settings with the current form snapshot.
 * Returns a new AppSettings with critical fields protected against
 * blank-overwrite from a hydration-race empty form.
 */
export function mergeSettingsSafely(
  current: AppSettings,
  form: FormSnapshot,
): AppSettings {
  return {
    ...current,
    baby: {
      ...current.baby,
      name:      pickString(current.baby?.name,      form.babyName),
      birthdate: pickString(current.baby?.birthdate, form.birthdate),
      gender:    pickGender(current.baby?.gender, form.babyGender),
    },
    profile: {
      ...current.profile,
      name: pickString(current.profile?.name, form.myName),
    },
  }
}
