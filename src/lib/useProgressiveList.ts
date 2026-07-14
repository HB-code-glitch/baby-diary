import { useCallback, useMemo, useState } from 'react'

export const PROGRESSIVE_LIST_BATCH = 48
const STAGGER_STEP_MS = 42
const MAX_STAGGER_STEPS = 8

export function getBoundedStaggerDelay(index: number): string {
  return `${Math.min(Math.max(index, 0), MAX_STAGGER_STEPS) * STAGGER_STEP_MS}ms`
}

export function useProgressiveList<Item>(items: readonly Item[]) {
  const [visibleCount, setVisibleCount] = useState(PROGRESSIVE_LIST_BATCH)
  const visibleItems = useMemo(
    () => items.slice(0, visibleCount),
    [items, visibleCount],
  )
  const remainingCount = Math.max(items.length - visibleItems.length, 0)
  const loadMore = useCallback(() => {
    setVisibleCount(current => Math.min(current + PROGRESSIVE_LIST_BATCH, items.length))
  }, [items.length])

  return {
    visibleItems,
    remainingCount,
    canLoadMore: remainingCount > 0,
    nextBatchCount: Math.min(PROGRESSIVE_LIST_BATCH, remainingCount),
    loadMore,
  }
}
