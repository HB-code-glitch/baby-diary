/**
 * Advances a legacy counter or an epoch-millisecond HLC without ever moving
 * backwards. Existing small counters are promoted on their next mutation.
 */
export function nextHybridLogicalClock(
  prior: number,
  nowMs = Date.now(),
): number {
  if (!Number.isSafeInteger(prior) || prior < 0) {
    throw new Error('prior logical clock is invalid')
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('current logical clock time is invalid')
  }
  if (prior >= Number.MAX_SAFE_INTEGER) {
    throw new Error('logical clock exhausted')
  }
  return Math.max(prior + 1, nowMs)
}
