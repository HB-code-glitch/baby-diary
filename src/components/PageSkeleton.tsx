/**
 * src/components/PageSkeleton.tsx
 * Minimal glass skeleton shown while a lazy page chunk is loading.
 * No spinner emoji — subtle pulse animation, works in both light and dark themes.
 */
import React from 'react'

export function PageSkeleton() {
  return (
    <div className="page-skeleton">
      <div className="page-skeleton-bar page-skeleton-bar--wide" />
      <div className="page-skeleton-bar page-skeleton-bar--medium" />
      <div className="page-skeleton-bar page-skeleton-bar--narrow" />
    </div>
  )
}
