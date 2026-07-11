/**
 * WHO Child Growth Standards (2006) — Z-score computation and percentile utilities.
 * Source: WHO Technical Report Series No. 916. Z = ((X/M)^L - 1)/(L*S).
 * Special case L=1 (length/height): Z = (X - M)/(M*S).
 * WHO weight SD23 restricted adjustment for |z|>3 (per WHO guidelines, section 5.2).
 *
 * DO NOT modify whoGrowthData.ts — this module imports (never re-exports) from it.
 */
import { WFA_BOYS, WFA_GIRLS, LHFA_BOYS, LHFA_GIRLS, LmsPoint } from './whoGrowthData'

type Metric = 'weight' | 'height'
type Sex = 'boy' | 'girl'

function getTable(metric: Metric, sex: Sex): LmsPoint[] {
  if (metric === 'weight') return sex === 'boy' ? WFA_BOYS : WFA_GIRLS
  return sex === 'boy' ? LHFA_BOYS : LHFA_GIRLS
}

/** Linear interpolation between two LmsPoints at a fractional month. */
function interpolateLms(table: LmsPoint[], ageMonthsFloat: number): LmsPoint {
  const clamped = Math.max(0, Math.min(24, ageMonthsFloat))
  const lo = Math.floor(clamped)
  const hi = Math.min(24, lo + 1)
  if (lo === hi) return table[lo]
  const t = clamped - lo
  const a = table[lo]
  const b = table[hi]
  return {
    month: clamped,
    L: a.L + t * (b.L - a.L),
    M: a.M + t * (b.M - a.M),
    S: a.S + t * (b.S - a.S),
  }
}

/**
 * Compute WHO z-score for weight or height.
 * For weight (non-linear LMS): Z = ((X/M)^L - 1)/(L*S).
 * For height (L~1, normal): Z = (X - M)/(M*S).
 * WHO weight SD23 restricted adjustment: if |z|>3, use linear extrapolation
 * from SD3 using the SD2-to-SD3 distance as the unit SD.
 */
export function computeZ(metric: Metric, sex: Sex, ageMonthsFloat: number, value: number): number {
  const table = getTable(metric, sex)
  const { L, M, S } = interpolateLms(table, ageMonthsFloat)

  let z: number
  if (metric === 'height' || Math.abs(L - 1) < 1e-9) {
    // L~1: normal distribution approximation
    z = (value - M) / (M * S)
  } else {
    z = (Math.pow(value / M, L) - 1) / (L * S)
  }

  // WHO SD23 restricted adjustment for weight when |z|>3.
  // SD3pos = M*(1+L*S*3)^(1/L); SD2pos = M*(1+L*S*2)^(1/L)
  // if z>3: z_adj = 3 + (X - SD3pos)/(SD3pos - SD2pos)
  // if z<-3: z_adj = -3 + (X - SD3neg)/(SD3neg - SD2neg)
  if (metric === 'weight' && Math.abs(L) > 1e-9) {
    if (z > 3) {
      const sd3pos = M * Math.pow(1 + L * S * 3, 1 / L)
      const sd2pos = M * Math.pow(1 + L * S * 2, 1 / L)
      z = 3 + (value - sd3pos) / (sd3pos - sd2pos)
    } else if (z < -3) {
      const sd3neg = M * Math.pow(1 + L * S * (-3), 1 / L)
      const sd2neg = M * Math.pow(1 + L * S * (-2), 1 / L)
      z = -3 + (value - sd3neg) / (sd2neg - sd3neg)
    }
  }

  return z
}

/**
 * Convert z-score to percentile (0-100) using Abramowitz & Stegun erf approximation (7.1.26).
 * Max error < 1.5e-7. Source: Handbook of Mathematical Functions, formula 7.1.26.
 */
export function zToPercentile(z: number): number {
  // erf approximation
  const t = 1 / (1 + 0.3275911 * Math.abs(z / Math.SQRT2))
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const erf = 1 - poly * Math.exp(-(z / Math.SQRT2) * (z / Math.SQRT2))
  const cdf = 0.5 * (1 + (z >= 0 ? erf : -erf))
  return Math.min(99.9, Math.max(0.1, cdf * 100))
}

/**
 * Return the measurement value at a given z-score for chart band lines.
 * Inverse of computeZ for the normal (height) case; for weight uses power-law inverse.
 */
export function percentileBandValue(metric: Metric, sex: Sex, ageMonthsFloat: number, z: number): number {
  const table = getTable(metric, sex)
  const { L, M, S } = interpolateLms(table, ageMonthsFloat)

  if (metric === 'height' || Math.abs(L - 1) < 1e-9) {
    return M * (1 + z * S)
  }
  return M * Math.pow(1 + L * S * z, 1 / L)
}
