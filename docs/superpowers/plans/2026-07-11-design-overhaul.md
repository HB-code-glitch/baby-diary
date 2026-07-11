# Baby Diary Design Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Baby Diary Electron app from generic AI-looking design to a warm, hand-crafted Japanese/Korean baby app aesthetic (ぴよログ/Glow Baby references) — chunky custom SVG icons, asymmetric layouts, fluid CSS micro-motion, and rich typographic hierarchy.

**Architecture:** Pure CSS + TSX reskin — no new runtime dependencies. Custom SVG icon component replaces lucide-react usages app-wide. All motion is CSS-only (cubic-bezier transitions, animation-delay stagger, prefers-reduced-motion respected). Every new display string added to both ko.json and ja.json.

**Tech Stack:** React 18 + TypeScript + Vite, custom CSS (index.css design tokens), i18next (ko/ja), Recharts, Pretendard font, existing Zustand store (read-only from this plan's perspective).

## Global Constraints

- NO emojis in any file. NO `#000` pure black. NO purple/neon glows. NO text gradients. NO 3-equal-column card rows. NO centered hero.
- Palette stays: cream base `#fdf9ed` family + existing pastel accents (sage/peach/amber/rose). Accent text shades can go one step deeper (e.g., sage-600 for text on sage-100 bg) for WCAG contrast.
- Pretendard font stays. Numbers use `font-variant-numeric: tabular-nums`. Big stats 28-40px semibold. Labels 11-12px with tracking.
- Tinted shadows: use `rgba(var(--peach-rgb), 0.12)` style, not `rgba(0,0,0,x)` for colored elements.
- CSS-only motion: `transition: cubic-bezier(0.16,1,0.3,1)`. Stagger via `animation-delay: calc(var(--i, 0) * 40ms)`. `:active { transform: scale(0.97) }`. Extend existing `@media (prefers-reduced-motion: reduce)` block.
- Keep lucide-react installed (don't remove from package.json); just stop importing its icons from UI files.
- Every new string goes in BOTH `src/i18n/ko.json` AND `src/i18n/ja.json`.
- NO behavior changes — no store logic, no sync engine, no electron/ touches.
- After each task: `npx tsc --noEmit` must pass (0 errors). After final task: `npm test` (58 green) + `npm run build`.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/components/icons.tsx` | **CREATE** | All custom SVG icons (24px grid, stroke 2.5, rounded caps) |
| `src/components/EventIcon.tsx` | **MODIFY** | Use custom icons from icons.tsx instead of lucide |
| `src/components/EventTimeline.tsx` | **MODIFY** | Time-rail layout with vertical line, dot, author avatar |
| `src/components/Sidebar.tsx` | **MODIFY** | Baby initial avatar, custom icons, warm pill active state |
| `src/pages/HomePage.tsx` | **MODIFY** | Asymmetric hero, circular quick-btns, today stat tiles |
| `src/pages/HistoryPage.tsx` | **MODIFY** | Calendar: today filled circle, weekend tints, breathe cells |
| `src/pages/StatsPage.tsx` | **MODIFY** | Section header accent bar, Recharts restyled |
| `src/pages/DiaryPage.tsx` | **MODIFY** | Asymmetric card (title row + preview + author chip right) |
| `src/pages/MessagesPage.tsx` | **MODIFY** | Stationery top band, paper tint, ruled-line spacing |
| `src/index.css` | **MODIFY** | New tokens, motion system, all restyled class blocks |
| `src/i18n/ko.json` | **MODIFY** | New strings for new UI elements |
| `src/i18n/ja.json` | **MODIFY** | Matching Japanese strings |

---

### Task 1: Custom SVG Icon Set

**Files:**
- Create: `src/components/icons.tsx`
- Modify: `src/components/EventIcon.tsx` (lines 1-57)

**Interfaces:**
- Produces: `IconProps = { size?: number; color?: string; strokeWidth?: number }` — all icons accept this
- Produces named exports: `IconDrop`, `IconPoop`, `IconThermometer`, `IconHeart`, `IconBottle`, `IconBook`, `IconEnvelopeHeart`, `IconGear`, `IconClock`, `IconCalendar`, `IconChart`, `IconPencil`, `IconTrash`, `IconHome`, `IconList`, `IconMail`, `IconSettings`, `IconChevronLeft`, `IconChevronRight`, `IconPlus`, `IconX`

- [ ] **Step 1: Create icons.tsx with all custom SVG icons**

```tsx
// src/components/icons.tsx
import React from 'react'

export interface IconProps {
  size?: number
  color?: string
  strokeWidth?: number
  className?: string
}

const defaults = { size: 24, strokeWidth: 2.5 }

export function IconDrop({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M12 3C12 3 6 9.5 6 14C6 17.314 8.686 20 12 20C15.314 20 18 17.314 18 14C18 9.5 12 3 12 3Z" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M9 15.5C9.5 17 10.6 17.8 12 17.8" stroke={color} strokeWidth={strokeWidth * 0.7} strokeLinecap="round" opacity="0.5"/>
    </svg>
  )
}

export function IconPoop({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M8 18C6.343 18 5 16.657 5 15C5 13.657 5.79 12.5 6.937 12.069C6.65 11.588 6.5 11.023 6.5 10.5C6.5 8.567 8.067 7 10 7C10.448 7 10.877 7.083 11.274 7.234C11.685 6.5 12.447 6 13.5 6C15.157 6 16.5 7.343 16.5 9C16.5 9.38 16.427 9.743 16.3 10.077C17.3 10.554 18 11.59 18 12.75C18 14.545 16.545 16 14.75 16" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
      <rect x="6" y="17" width="12" height="3" rx="1.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
    </svg>
  )
}

export function IconThermometer({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M12 3C13.105 3 14 3.895 14 5V14.268C15.165 14.863 16 16.089 16 17.5C16 19.433 14.433 21 12.5 21C10.567 21 9 19.433 9 17.5C9 16.089 9.835 14.863 11 14.268V5C11 3.895 11.895 3 13 3H12Z" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="12.5" cy="17.5" r="2" fill={color} opacity="0.35"/>
      <path d="M14 7.5H15.5" stroke={color} strokeWidth={strokeWidth * 0.7} strokeLinecap="round"/>
      <path d="M14 10H15.5" stroke={color} strokeWidth={strokeWidth * 0.7} strokeLinecap="round"/>
      <path d="M14 12.5H15.5" stroke={color} strokeWidth={strokeWidth * 0.7} strokeLinecap="round"/>
    </svg>
  )
}

export function IconHeart({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M12 20C12 20 4 14.5 4 9C4 6.239 6.239 4 9 4C10.476 4 11.803 4.65 12.727 5.682C12.882 5.855 13.118 5.855 13.273 5.682C14.197 4.65 15.524 4 17 4C19.761 4 22 6.239 22 9" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M12 20C12 20 20 14.5 20 9" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
    </svg>
  )
}

export function IconBottle({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M10 3H14V5.5C14 5.5 16.5 7 16.5 10V19C16.5 20.105 15.605 21 14.5 21H9.5C8.395 21 7.5 20.105 7.5 19V10C7.5 7 10 5.5 10 5.5V3Z" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M10 3H14" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
      <path d="M7.5 13H16.5" stroke={color} strokeWidth={strokeWidth * 0.7} strokeLinecap="round" opacity="0.5"/>
    </svg>
  )
}

export function IconBook({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M12 6V20" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
      <path d="M12 7C12 7 8 4.5 4 5.5V18C8 17 12 19.5 12 19.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M12 7C12 7 16 4.5 20 5.5V18C16 17 12 19.5 12 19.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

export function IconEnvelopeHeart({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M3 8L12 14L21 8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M12 10.5C12 10.5 10.5 9.2 9.7 10.2C8.9 11.2 9.8 12.3 12 13.5C14.2 12.3 15.1 11.2 14.3 10.2C13.5 9.2 12 10.5 12 10.5Z" stroke="var(--rose-400)" strokeWidth={strokeWidth * 0.7} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

export function IconGear({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke={color} strokeWidth={strokeWidth}/>
      <path d="M12 2V4M12 20V22M2 12H4M20 12H22M4.93 4.93L6.34 6.34M17.66 17.66L19.07 19.07M4.93 19.07L6.34 17.66M17.66 6.34L19.07 4.93" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
    </svg>
  )
}

export function IconClock({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke={color} strokeWidth={strokeWidth}/>
      <path d="M12 7V12L15 14.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

export function IconCalendar({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="3" stroke={color} strokeWidth={strokeWidth}/>
      <path d="M3 9H21" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
      <path d="M8 3V7M16 3V7" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
      <circle cx="8" cy="14" r="1" fill={color}/>
      <circle cx="12" cy="14" r="1" fill={color}/>
      <circle cx="16" cy="14" r="1" fill={color}/>
    </svg>
  )
}

export function IconChart({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M4 20H20" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
      <rect x="5" y="13" width="3" height="7" rx="1.5" stroke={color} strokeWidth={strokeWidth}/>
      <rect x="10.5" y="8" width="3" height="12" rx="1.5" stroke={color} strokeWidth={strokeWidth}/>
      <rect x="16" y="4" width="3" height="16" rx="1.5" stroke={color} strokeWidth={strokeWidth}/>
    </svg>
  )
}

export function IconPencil({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M15.5 4.5L19.5 8.5L8.5 19.5L4 20L4.5 15.5L15.5 4.5Z" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M13.5 6.5L17.5 10.5" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
    </svg>
  )
}

export function IconTrash({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M4 7H20" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
      <path d="M10 7V4H14V7" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M6 7L7 19C7 19.552 7.448 20 8 20H16C16.552 20 17 19.552 17 19L18 7" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

export function IconHome({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M4 10.5L12 3L20 10.5V20C20 20.552 19.552 21 19 21H15V16H9V21H5C4.448 21 4 20.552 4 20V10.5Z" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

export function IconList({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <circle cx="5" cy="7" r="1.5" fill={color}/>
      <circle cx="5" cy="12" r="1.5" fill={color}/>
      <circle cx="5" cy="17" r="1.5" fill={color}/>
      <path d="M10 7H20M10 12H20M10 17H18" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
    </svg>
  )
}

export function IconMail({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" stroke={color} strokeWidth={strokeWidth}/>
      <path d="M3 8L12 14L21 8" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

export function IconChevronLeft({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M15 18L9 12L15 6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

export function IconChevronRight({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M9 6L15 12L9 18" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

export function IconPlus({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M12 5V19M5 12H19" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
    </svg>
  )
}

export function IconX({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M18 6L6 18M6 6L18 18" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
    </svg>
  )
}
```

- [ ] **Step 2: Update EventIcon.tsx to use custom icons**

Replace the entire content of `src/components/EventIcon.tsx`:

```tsx
import React from 'react'
import { IconDrop, IconPoop, IconThermometer, IconHeart, IconBottle, IconBook, IconEnvelopeHeart } from './icons'
import { EventType } from '../../shared/types'
import i18n from '../i18n'

interface EventIconProps {
  type: EventType
  size?: number
}

const COLOR_MAP: Record<EventType, { bg: string; color: string; ring: string }> = {
  pee:     { bg: 'var(--sage-100)',   color: 'var(--sage-600)',   ring: 'var(--sage-200)' },
  poop:    { bg: 'var(--sage-100)',   color: 'var(--sage-500)',   ring: 'var(--sage-200)' },
  temp:    { bg: 'var(--amber-100)',  color: 'var(--amber-600)',  ring: 'var(--amber-200)' },
  breast:  { bg: 'var(--peach-100)', color: 'var(--peach-600)',  ring: 'var(--peach-200)' },
  formula: { bg: 'var(--peach-100)', color: 'var(--peach-500)',  ring: 'var(--peach-200)' },
  diary:   { bg: 'var(--rose-100)',  color: 'var(--rose-500)',   ring: 'var(--rose-200)' },
  message: { bg: 'var(--rose-100)',  color: 'var(--rose-500)',   ring: 'var(--rose-200)' },
}

type IconComponent = React.ComponentType<{ size?: number; color?: string }>

const ICON_MAP: Record<EventType, IconComponent> = {
  pee:     IconDrop,
  poop:    IconPoop,
  temp:    IconThermometer,
  breast:  IconHeart,
  formula: IconBottle,
  diary:   IconBook,
  message: IconEnvelopeHeart,
}

export function EventIcon({ type, size = 15 }: EventIconProps) {
  const { bg, color, ring } = COLOR_MAP[type] ?? { bg: 'var(--stone-100)', color: 'var(--stone-500)', ring: 'var(--stone-200)' }
  const Icon = ICON_MAP[type] ?? IconDrop

  return (
    <div
      className="timeline-icon"
      style={{
        background: bg,
        boxShadow: `0 0 0 2px ${ring}`,
      }}
    >
      <Icon size={size} color={color} />
    </div>
  )
}

export function eventLabel(type: EventType): string {
  const t = i18n.t.bind(i18n)
  const KEY_MAP: Record<EventType, string> = {
    pee:     'event.pee',
    poop:    'event.poop',
    temp:    'event.temp',
    breast:  'event.breast',
    formula: 'event.formula',
    diary:   'event.diary',
    message: 'event.message',
  }
  return t(KEY_MAP[type] ?? type)
}
```

- [ ] **Step 3: Add deeper accent CSS variables to index.css**

In `src/index.css` under the `:root { }` block, after the existing `--rose-500` line, add:

```css
  /* Deeper accent text shades for contrast on pastel bg */
  --sage-600: #3d7535;
  --peach-600: #c55c30;
  --amber-600: #b07208;
  --rose-500: #d44060;

  /* RGB values for tinted shadows */
  --sage-shadow: rgba(90,146,80,0.14);
  --peach-shadow: rgba(232,116,74,0.14);
  --amber-shadow: rgba(217,146,10,0.14);
  --rose-shadow: rgba(212,64,96,0.14);
```

- [ ] **Step 4: Verify TypeScript**

```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 5: Commit**

```
git add src/components/icons.tsx src/components/EventIcon.tsx src/index.css
git commit -m "feat(design): custom SVG icon set, replace lucide in EventIcon

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: CSS Motion System + Design Token Refresh

**Files:**
- Modify: `src/index.css` — motion block, sidebar tokens, card tokens, quick-btn reskin

**Interfaces:**
- Consumes: existing CSS variable names (unchanged)
- Produces: `.nav-item.active` with `--accent-bar` left border; `.quick-btn-circle` new class; `@keyframes mountIn` for stagger

- [ ] **Step 1: Add motion system keyframes to index.css**

In `src/index.css`, find the `@keyframes toastIn` block and add AFTER it:

```css
/* Mount stagger animation */
@keyframes mountIn {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.stagger-mount {
  animation: mountIn 0.32s cubic-bezier(0.16,1,0.3,1) both;
  animation-delay: calc(var(--i, 0) * 40ms);
}

@media (prefers-reduced-motion: reduce) {
  .stagger-mount {
    animation: none;
  }
  * {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 2: Reskin .nav-item.active in index.css**

Find the `.nav-item.active` block and replace it:

```css
.nav-item.active {
  background: var(--cream-200);
  color: var(--stone-800);
  font-weight: 600;
  position: relative;
}

.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 60%;
  background: var(--peach-400);
  border-radius: 0 3px 3px 0;
}
```

- [ ] **Step 3: Add new .quick-btn-circle class to index.css**

Find the `.quick-btn { ... }` block. AFTER it (before `.quick-btn:hover`), add:

```css
/* Circular icon buttons (new design) */
.quick-btn-circle {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 0;
  width: 72px;
  height: 72px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  transition: transform 0.22s cubic-bezier(0.16,1,0.3,1),
              box-shadow 0.22s cubic-bezier(0.16,1,0.3,1),
              background 0.15s ease;
  font-family: 'Pretendard', sans-serif;
  font-size: 11px;
  font-weight: 600;
  position: relative;
  flex-shrink: 0;
}

.quick-btn-circle:hover {
  transform: translateY(-3px);
}

.quick-btn-circle:active {
  transform: scale(0.97) translateY(0);
}

@media (prefers-reduced-motion: reduce) {
  .quick-btn-circle {
    transition: background 0.15s ease;
  }
  .quick-btn-circle:hover,
  .quick-btn-circle:active {
    transform: none;
    box-shadow: none !important;
  }
}

.quick-btn-circle-pee {
  background: var(--sage-100);
  color: var(--sage-600);
}
.quick-btn-circle-pee:hover {
  background: var(--sage-200);
  box-shadow: 0 8px 20px var(--sage-shadow);
}

.quick-btn-circle-poop {
  background: var(--sage-100);
  color: var(--sage-600);
}
.quick-btn-circle-poop:hover {
  background: var(--sage-200);
  box-shadow: 0 8px 20px var(--sage-shadow);
}

.quick-btn-circle-temp {
  background: var(--amber-100);
  color: var(--amber-600);
}
.quick-btn-circle-temp:hover {
  background: var(--amber-200);
  box-shadow: 0 8px 20px var(--amber-shadow);
}

.quick-btn-circle-breast {
  background: var(--peach-100);
  color: var(--peach-600);
}
.quick-btn-circle-breast:hover {
  background: var(--peach-200);
  box-shadow: 0 8px 20px var(--peach-shadow);
}

.quick-btn-circle-formula {
  background: var(--peach-100);
  color: var(--peach-500);
}
.quick-btn-circle-formula:hover {
  background: var(--peach-200);
  box-shadow: 0 8px 20px var(--peach-shadow);
}

/* Label below circle button */
.quick-btn-circle-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--stone-600);
  text-align: center;
  margin-top: 6px;
  line-height: 1.2;
}

/* Quick-record row wrapper */
.quick-record-row {
  display: flex;
  justify-content: space-around;
  align-items: flex-start;
  gap: 4px;
  margin-bottom: 4px;
}

/* Individual slot (circle + label) */
.quick-record-slot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
}
```

- [ ] **Step 4: Add today mini-stat tile styles to index.css**

After `.quick-record-slot` block, add:

```css
/* Today mini-stat tiles (home hero right side) */
.stat-tile-grid {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr;
  gap: 8px;
  min-width: 200px;
}

.stat-tile {
  border-radius: 12px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-tile-featured {
  grid-row: 1 / 3;
  padding: 14px 12px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.stat-tile-num {
  font-size: 28px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}

.stat-tile-featured .stat-tile-num {
  font-size: 36px;
}

.stat-tile-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--stone-500);
  letter-spacing: 0.04em;
  margin-top: 2px;
}

.stat-tile-unit {
  font-size: 12px;
  font-weight: 500;
  color: var(--stone-400);
  margin-top: 1px;
}

/* Breathing dot (last feeding status) */
.breathing-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--peach-400);
  margin-right: 6px;
  animation: breathe 2s ease-in-out infinite;
  flex-shrink: 0;
}

@keyframes breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.75); }
}

@media (prefers-reduced-motion: reduce) {
  .breathing-dot { animation: none; }
}
```

- [ ] **Step 5: Reskin .home-hero to asymmetric split**

Find and replace the `.home-hero` block in index.css:

```css
/* Home hero header strip — asymmetric split */
.home-hero {
  background: var(--cream-100);
  border: 1px solid var(--stone-200);
  border-radius: 20px;
  padding: 20px 24px;
  margin-bottom: 20px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.home-hero-left {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
}

.home-hero-date {
  font-size: 12px;
  font-weight: 500;
  color: var(--stone-400);
  letter-spacing: 0.04em;
}

.home-hero-baby-name {
  font-size: 32px;
  font-weight: 700;
  color: var(--stone-800);
  letter-spacing: -0.03em;
  line-height: 1;
}

.home-hero-dday {
  display: inline-flex;
  align-items: center;
  background: var(--cream-200);
  color: var(--stone-600);
  border-radius: 99px;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 600;
  width: fit-content;
  margin-top: 2px;
}

.home-hero-dday-btn {
  font-size: 12px;
  font-weight: 500;
  color: var(--peach-500);
  background: var(--peach-100);
  border: 1px solid var(--peach-200);
  border-radius: 99px;
  padding: 2px 10px;
  cursor: pointer;
  font-family: 'Pretendard', sans-serif;
  transition: background 0.15s ease;
  width: fit-content;
  margin-top: 2px;
}

.home-hero-dday-btn:hover {
  background: var(--peach-200);
}

.home-hero-right {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.badge-feeding {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--peach-100);
  color: var(--peach-600);
  border: 1px solid var(--peach-200);
  border-radius: 12px;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.badge-feeding-empty {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--stone-100);
  color: var(--stone-400);
  border: 1px solid var(--stone-200);
  border-radius: 12px;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
}
```

- [ ] **Step 6: Add timeline rail styles**

Find the `.timeline-item` block and replace it:

```css
/* Timeline — vertical rail design */
.timeline-rail {
  position: relative;
  padding-left: 28px;
}

.timeline-rail::before {
  content: '';
  position: absolute;
  left: 10px;
  top: 8px;
  bottom: 8px;
  width: 2px;
  background: var(--stone-200);
  border-radius: 1px;
}

.timeline-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 0;
  position: relative;
}

.timeline-item:last-child {
  /* no border-bottom in rail design */
}

/* Rail dot */
.timeline-dot {
  position: absolute;
  left: -24px;
  top: 14px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--stone-300);
  border: 2px solid var(--stone-50);
  flex-shrink: 0;
  z-index: 1;
}

.timeline-time {
  font-size: 11px;
  font-weight: 500;
  color: var(--stone-400);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  min-width: 40px;
  padding-top: 2px;
}

.timeline-icon {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* Author avatar circle */
.author-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
  color: white;
}
```

- [ ] **Step 7: Add section header accent bar styles**

After `.settings-section-title`, add:

```css
/* Section header with accent underline bar */
.section-header-accent {
  position: relative;
  font-size: 13px;
  font-weight: 700;
  color: var(--stone-700);
  padding-bottom: 8px;
  margin-bottom: 14px;
}

.section-header-accent::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: 0;
  width: 24px;
  height: 3px;
  border-radius: 2px;
  background: var(--peach-300);
}
```

- [ ] **Step 8: Reskin .letter-card for stationery feel**

Find and replace the `.letter-card` and `.letter-card::before` blocks:

```css
.letter-card {
  background: var(--cream-50);
  border: 1px solid var(--stone-200);
  border-radius: 14px;
  padding: 20px 22px;
  position: relative;
  overflow: hidden;
  line-height: 1.85;
}

.letter-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 4px;
  background: var(--rose-200);
  border-radius: 14px 14px 0 0;
}

/* Ruled line spacing inside letter */
.letter-card .letter-body {
  font-size: 14px;
  color: var(--stone-700);
  line-height: 1.85;
  white-space: pre-line;
  background-image: repeating-linear-gradient(
    to bottom,
    transparent,
    transparent calc(1.85em - 1px),
    var(--stone-200) calc(1.85em - 1px),
    var(--stone-200) 1.85em
  );
}
```

- [ ] **Step 9: Calendar today cell as filled warm circle**

Find `.cal-day-cell.cal-day-today` and replace:

```css
.cal-day-cell.cal-day-today .cal-day-num {
  background: var(--stone-700);
  color: var(--cream-50);
  border-radius: 50%;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.cal-day-cell.cal-day-today {
  /* Remove the outline, use the number circle instead */
}
```

- [ ] **Step 10: Verify TypeScript and commit**

```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit
```

Expected: 0 errors

```
git add src/index.css
git commit -m "feat(design): CSS motion system, circular quick-btn, timeline rail, stationery card tokens

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Sidebar Redesign

**Files:**
- Modify: `src/components/Sidebar.tsx` (full rewrite)

**Interfaces:**
- Consumes: `IconHome`, `IconCalendar`, `IconChart`, `IconBook`, `IconMail`, `IconGear` from `./icons`
- Consumes: `useAppStore`, `getDDay`, `useTranslation` (unchanged)
- Produces: same `SidebarProps` interface, same `Page` type export

- [ ] **Step 1: Rewrite Sidebar.tsx**

```tsx
import React from 'react'
import { IconHome, IconCalendar, IconChart, IconBook, IconMail, IconGear } from './icons'
import { useAppStore, getDDay } from '../store/useAppStore'
import { useTranslation } from 'react-i18next'

export type Page = 'home' | 'history' | 'stats' | 'diary' | 'messages' | 'settings'

interface NavItem {
  id: Page
  labelKey: string
  Icon: React.ComponentType<{ size?: number; color?: string }>
}

const NAV_ITEMS: NavItem[] = [
  { id: 'home',     labelKey: 'nav.home',     Icon: IconHome },
  { id: 'history',  labelKey: 'nav.history',  Icon: IconCalendar },
  { id: 'stats',    labelKey: 'nav.stats',    Icon: IconChart },
  { id: 'diary',    labelKey: 'nav.diary',    Icon: IconBook },
  { id: 'messages', labelKey: 'nav.messages', Icon: IconMail },
  { id: 'settings', labelKey: 'nav.settings', Icon: IconGear },
]

interface SidebarProps {
  currentPage: Page
  onNavigate: (page: Page) => void
}

/** Deterministic hue from name string (0-360) */
function nameToHue(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return Math.abs(hash) % 360
}

export function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const settings = useAppStore(s => s.settings)
  const { t } = useTranslation()

  const babyName = settings?.baby?.name || t('sidebar.defaultBabyName')
  const birthdate = settings?.baby?.birthdate
  const dday = birthdate ? getDDay(birthdate) : null

  const initial = babyName.charAt(0).toUpperCase()
  const hue = nameToHue(babyName)
  const avatarBg = `hsl(${hue}, 55%, 70%)`
  const avatarFg = `hsl(${hue}, 35%, 30%)`

  return (
    <nav className="sidebar">
      <div className="sidebar-header">
        {/* Baby avatar circle */}
        <div
          className="sidebar-avatar"
          style={{
            background: avatarBg,
            color: avatarFg,
          }}
          aria-hidden="true"
        >
          {initial}
        </div>
        <div className="sidebar-baby-name">{babyName}</div>
        {dday != null ? (
          <div className="sidebar-dday">{t('dday', { days: dday })}</div>
        ) : (
          <div className="sidebar-dday" style={{ opacity: 0.5 }}>{t('sidebar.birthdatePlaceholder')}</div>
        )}
      </div>

      <div className="sidebar-nav">
        {NAV_ITEMS.map(({ id, labelKey, Icon }) => (
          <button
            key={id}
            className={`nav-item${currentPage === id ? ' active' : ''}`}
            onClick={() => onNavigate(id)}
          >
            <Icon
              size={16}
              color={currentPage === id ? 'var(--stone-700)' : 'var(--stone-500)'}
            />
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
```

- [ ] **Step 2: Add sidebar-avatar CSS to index.css**

After `.sidebar-dday` block, add:

```css
.sidebar-avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 8px;
  flex-shrink: 0;
}
```

Also update `.sidebar-baby-name`:

```css
.sidebar-baby-name {
  font-size: 14px;
  font-weight: 700;
  color: var(--stone-800);
  letter-spacing: -0.02em;
  margin-top: 0;
}
```

- [ ] **Step 3: Verify TypeScript**

```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```
git add src/components/Sidebar.tsx src/index.css
git commit -m "feat(design): sidebar baby avatar, custom icons, warm pill active state

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Home Hero + Quick-Record Row Redesign

**Files:**
- Modify: `src/pages/HomePage.tsx` — `HomeHero`, `TodaySummary`, and the quick-record grid

**Interfaces:**
- Consumes: `IconDrop`, `IconPoop`, `IconThermometer`, `IconHeart`, `IconBottle`, `IconClock` from `../components/icons`
- Consumes: `useAppStore` selectors: `todayPeeCount`, `todayPoopCount`, `todayFeedingCount`, `todayFormulaTotalMl`, `lastFeeding`, `settings`
- Produces: same `HomeHeroProps`, same `HomePageProps` — no behavior changes

- [ ] **Step 1: Rewrite HomeHero component in HomePage.tsx**

Find the `function HomeHero` block (lines 20-81) and replace:

```tsx
function HomeHero({ onNavigateSettings }: HomeHeroProps) {
  const lastFeeding = useAppStore(s => s.lastFeeding())
  const settings = useAppStore(s => s.settings)
  const peeCount = useAppStore(s => s.todayPeeCount())
  const poopCount = useAppStore(s => s.todayPoopCount())
  const feedCount = useAppStore(s => s.todayFeedingCount())
  const formulaMl = useAppStore(s => s.todayFormulaTotalMl())
  const [, setTick] = useState(0)
  const { t, i18n: i18nInstance } = useTranslation()

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const dateFnsLocale = i18nInstance.language === 'ja' ? ja : ko
  const dateStr = format(new Date(), t('date.formatLong'), { locale: dateFnsLocale })

  const birthdate = settings?.baby?.birthdate
  const dday = birthdate ? getDDay(birthdate) : null
  const babyName = settings?.baby?.name || t('sidebar.defaultBabyName')

  let feedingBadgeContent: React.ReactNode
  if (lastFeeding) {
    const minutes = differenceInMinutes(new Date(), parseISO(lastFeeding.at))
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    const timeStr = hours > 0
      ? t('home.durationHoursMins', { hours, mins })
      : t('home.durationMins', { mins })
    const feedingType = lastFeeding.type === 'breast'
      ? t('home.breastMilk')
      : t('home.formula')
    feedingBadgeContent = (
      <div className="badge-feeding">
        <span className="breathing-dot" />
        {t('home.lastFeedingAgo', { type: feedingType, time: timeStr })}
      </div>
    )
  } else {
    feedingBadgeContent = (
      <div className="badge-feeding-empty">
        <IconClock size={12} color="var(--stone-400)" />
        {t('home.noFeedingYet')}
      </div>
    )
  }

  const statTiles = [
    { key: 'formula', num: formulaMl > 0 ? formulaMl : '-', unit: formulaMl > 0 ? 'ml' : '', label: t('stat.formulaLabel'), bg: 'var(--peach-100)', color: 'var(--peach-600)', featured: true },
    { key: 'pee', num: peeCount, unit: '', label: t('stat.peeLabel'), bg: 'var(--sage-100)', color: 'var(--sage-600)', featured: false },
    { key: 'poop', num: poopCount, unit: '', label: t('stat.poopLabel'), bg: 'var(--sage-100)', color: 'var(--sage-500)', featured: false },
    { key: 'feed', num: feedCount, unit: '', label: t('stat.feedLabel'), bg: 'var(--cream-200)', color: 'var(--stone-700)', featured: false },
  ]

  return (
    <div className="home-hero">
      <div className="home-hero-left">
        <div className="home-hero-date">{dateStr}</div>
        <div className="home-hero-baby-name">{babyName}</div>
        {dday != null ? (
          <div className="home-hero-dday">{t('dday', { days: dday })}</div>
        ) : (
          <button
            className="home-hero-dday-btn"
            onClick={onNavigateSettings}
          >
            {t('home.setBirthday')}
          </button>
        )}
        <div style={{ marginTop: 8 }}>
          {feedingBadgeContent}
        </div>
      </div>

      <div className="home-hero-right">
        <div className="stat-tile-grid">
          {statTiles.map(tile => (
            <div
              key={tile.key}
              className={`stat-tile${tile.featured ? ' stat-tile-featured' : ''}`}
              style={{ background: tile.bg }}
            >
              <div className="stat-tile-num" style={{ color: tile.color }}>
                {tile.num}
              </div>
              {tile.unit && <div className="stat-tile-unit">{tile.unit}</div>}
              <div className="stat-tile-label">{tile.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Add i18n keys for stat labels to ko.json**

In `src/i18n/ko.json`, inside the `"home"` object, add after `"formula"`:

```json
"stat": {
  "formulaLabel": "분유 총량",
  "peeLabel": "소변",
  "poopLabel": "대변",
  "feedLabel": "수유 횟수"
}
```

Note: add this as a top-level key (sibling of `"home"`, not inside it).

- [ ] **Step 3: Add i18n keys to ja.json**

In `src/i18n/ja.json`, at the same level:

```json
"stat": {
  "formulaLabel": "ミルク合計",
  "peeLabel": "おしっこ",
  "poopLabel": "うんち",
  "feedLabel": "授乳回数"
}
```

- [ ] **Step 4: Rewrite the quick-record grid in HomePage.tsx**

Find the `{/* Quick record buttons */}` block (roughly lines 640-683) and replace with:

```tsx
      {/* Quick record buttons — circular icon design */}
      <div className="quick-record-row">
        {[
          {
            cls: 'quick-btn-circle quick-btn-circle-pee',
            Icon: IconDrop,
            label: t('quickBtn.pee'),
            badge: '1',
            onClick: handlePee,
          },
          {
            cls: 'quick-btn-circle quick-btn-circle-poop',
            Icon: IconPoop,
            label: t('quickBtn.poop'),
            badge: '2',
            onClick: handlePoop,
          },
          {
            cls: 'quick-btn-circle quick-btn-circle-temp',
            Icon: IconThermometer,
            label: t('quickBtn.temp'),
            badge: '3',
            onClick: (e: React.MouseEvent) => openPopover('temp', e),
          },
          {
            cls: 'quick-btn-circle quick-btn-circle-breast',
            Icon: IconHeart,
            label: t('quickBtn.breast'),
            badge: '4',
            onClick: (e: React.MouseEvent) => openPopover('breast', e),
          },
          {
            cls: 'quick-btn-circle quick-btn-circle-formula',
            Icon: IconBottle,
            label: t('quickBtn.formula'),
            badge: '5',
            onClick: (e: React.MouseEvent) => openPopover('formula', e),
          },
        ].map(({ cls, Icon, label, badge, onClick }, i) => (
          <div
            key={badge}
            className="quick-record-slot stagger-mount"
            style={{ '--i': i } as React.CSSProperties}
          >
            <button
              className={cls}
              onClick={onClick as React.MouseEventHandler}
              style={{ position: 'relative' }}
            >
              <span className="quick-btn-badge">{badge}</span>
              <Icon size={24} />
            </button>
            <span className="quick-btn-circle-label">{label}</span>
          </div>
        ))}
      </div>
```

- [ ] **Step 5: Update imports in HomePage.tsx**

At the top of `src/pages/HomePage.tsx`, replace the lucide import line:
```tsx
import { Droplets, Wind, Thermometer, Heart, Baby, Clock } from 'lucide-react'
```
with:
```tsx
import { IconDrop, IconPoop, IconThermometer, IconHeart, IconBottle, IconClock } from '../components/icons'
```

Also remove `TodaySummary` rendering from its current location (it's now embedded in the hero):

Find `{/* Today summary */}` block (lines 689-692):
```tsx
      {/* Today summary */}
      <div style={{ marginBottom: 20, marginTop: 10 }}>
        <TodaySummary />
      </div>
```
Remove it entirely (the summary is now shown as stat tiles in the hero).

- [ ] **Step 6: Verify TypeScript**

```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 7: Commit**

```
git add src/pages/HomePage.tsx src/i18n/ko.json src/i18n/ja.json
git commit -m "feat(design): asymmetric home hero, circular quick-btn, today stat tiles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Timeline Rail Design + Author Avatar

**Files:**
- Modify: `src/components/EventTimeline.tsx` (full rewrite)

**Interfaces:**
- Consumes: `IconPencil`, `IconTrash` from `./icons`
- Consumes: `EventIcon`, `eventLabel` from `./EventIcon` (unchanged)
- Produces: same `EventTimelineProps` interface (no behavior changes)

- [ ] **Step 1: Rewrite EventTimeline.tsx**

```tsx
import React, { useState } from 'react'
import { IconPencil, IconTrash } from './icons'
import { DiaryEvent } from '../../shared/types'
import { EventIcon, eventLabel } from './EventIcon'
import { formatEventValue, formatTime } from '../store/useAppStore'
import { TimeEditModal } from './TimeEditModal'
import { useAppStore } from '../store/useAppStore'
import { useToast } from './Toast'
import { useTranslation } from 'react-i18next'

interface EventTimelineProps {
  events: DiaryEvent[]
  showAuthor?: boolean
  editable?: boolean
}

/** Deterministic hue 0-360 from name string */
function nameToHue(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return Math.abs(hash) % 360
}

export function EventTimeline({ events, showAuthor = true, editable = true }: EventTimelineProps) {
  const { editEvent, softDeleteEvent } = useAppStore()
  const { showToast } = useToast()
  const { t } = useTranslation()
  const [editingAt, setEditingAt] = useState<DiaryEvent | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const handleTimeEdit = async (event: DiaryEvent, newAt: string) => {
    await editEvent(event, { at: newAt })
    setEditingAt(null)
    showToast({ message: t('toast.timeEdited') })
  }

  const handleDelete = async (event: DiaryEvent) => {
    if (confirmDelete === event.id) {
      await softDeleteEvent(event)
      setConfirmDelete(null)
      showToast({ message: t('toast.deleted') })
    } else {
      setConfirmDelete(event.id)
      setTimeout(() => setConfirmDelete(null), 3000)
    }
  }

  if (events.length === 0) {
    return (
      <div className="empty-state">
        <svg width="56" height="48" viewBox="0 0 56 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M22 36C22 27.163 29.163 20 38 20C39.4 20 40.76 20.18 42.06 20.52C40.14 14.42 34.54 10 28 10C19.716 10 13 16.716 13 25C13 33.284 19.716 40 28 40C29.14 40 30.26 39.87 31.32 39.62C25.8 38.3 22 32.58 22 36Z" stroke="var(--stone-300)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="42" cy="9" r="2" stroke="var(--stone-300)" strokeWidth="2.5"/>
          <circle cx="50" cy="18" r="1.5" stroke="var(--stone-300)" strokeWidth="2.5"/>
          <circle cx="46" cy="3" r="1" stroke="var(--stone-300)" strokeWidth="2.5"/>
        </svg>
        <div className="empty-state-title">{t('timeline.emptyTitle')}</div>
        <div className="empty-state-sub">{t('timeline.emptySub')}</div>
      </div>
    )
  }

  return (
    <>
      <div className="timeline-rail">
        {events.map((event, i) => {
          const authorName = event.author?.name ?? ''
          const initial = authorName ? authorName.charAt(0).toUpperCase() : ''
          const hue = nameToHue(authorName)
          const avatarBg = `hsl(${hue}, 50%, 68%)`
          const avatarFg = `hsl(${hue}, 35%, 28%)`

          return (
            <div
              key={`${event.id}-${event.rev}`}
              className="timeline-item stagger-mount"
              style={{ '--i': i } as React.CSSProperties}
            >
              {/* Rail dot */}
              <span className="timeline-dot" />

              {/* Time */}
              <span className="timeline-time">{formatTime(event.at)}</span>

              {/* Icon chip */}
              <EventIcon type={event.type} size={14} />

              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-800)' }}>
                    {eventLabel(event.type)}
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--stone-500)' }}>
                    {formatEventValue(event)}
                  </span>
                </div>
              </div>

              {/* Author avatar */}
              {showAuthor && initial && (
                <div
                  className="author-avatar"
                  style={{ background: avatarBg, color: avatarFg }}
                  title={authorName}
                  aria-label={authorName}
                >
                  {initial}
                </div>
              )}

              {/* Edit/delete */}
              {editable && (
                <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                  <button
                    onClick={() => setEditingAt(event)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      padding: '4px', color: 'var(--stone-400)', borderRadius: 5,
                    }}
                    title={t('timeline.editTime')}
                  >
                    <IconPencil size={13} color="var(--stone-400)" />
                  </button>
                  <button
                    onClick={() => handleDelete(event)}
                    style={{
                      background: confirmDelete === event.id ? 'var(--rose-100)' : 'none',
                      border: 'none', cursor: 'pointer',
                      padding: '4px',
                      color: confirmDelete === event.id ? 'var(--rose-500)' : 'var(--stone-400)',
                      borderRadius: 5,
                    }}
                    title={confirmDelete === event.id ? t('timeline.confirmDelete') : t('timeline.delete')}
                  >
                    <IconTrash size={13} color={confirmDelete === event.id ? 'var(--rose-500)' : 'var(--stone-400)'} />
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {editingAt && (
        <TimeEditModal
          currentAt={editingAt.at}
          onConfirm={(newAt) => handleTimeEdit(editingAt, newAt)}
          onClose={() => setEditingAt(null)}
        />
      )}
    </>
  )
}
```

- [ ] **Step 2: Verify TypeScript**

```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 3: Commit**

```
git add src/components/EventTimeline.tsx
git commit -m "feat(design): timeline rail with vertical line, dot, author avatar, stagger mount

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: HistoryPage Calendar Reskin

**Files:**
- Modify: `src/pages/HistoryPage.tsx` — `MonthDayCell`, `MonthView`, chevron icons

**Interfaces:**
- Consumes: `IconChevronLeft`, `IconChevronRight` from `../components/icons`
- Produces: same `CalendarView`, `MonthViewProps`, etc. (no behavior changes)

- [ ] **Step 1: Replace ChevronLeft/Right imports in HistoryPage.tsx**

At the top of `src/pages/HistoryPage.tsx`, find:
```tsx
import { ChevronLeft, ChevronRight } from 'lucide-react'
```
Replace with:
```tsx
import { IconChevronLeft, IconChevronRight } from '../components/icons'
```

- [ ] **Step 2: Replace lucide chevron usages in MonthView and WeekView**

In `MonthView` (around line 76-85):
```tsx
        <button className="btn-secondary cal-nav-arrow" onClick={onPrevMonth} aria-label="prev month">
          <ChevronLeft size={16} />
        </button>
```
becomes:
```tsx
        <button className="btn-secondary cal-nav-arrow" onClick={onPrevMonth} aria-label="prev month">
          <IconChevronLeft size={16} color="var(--stone-600)" />
        </button>
```

And:
```tsx
        <button className="btn-secondary cal-nav-arrow" onClick={onNextMonth} aria-label="next month">
          <ChevronRight size={16} />
        </button>
```
becomes:
```tsx
        <button className="btn-secondary cal-nav-arrow" onClick={onNextMonth} aria-label="next month">
          <IconChevronRight size={16} color="var(--stone-600)" />
        </button>
```

Do the same for WeekView's prev/next week buttons (pattern identical, find `ChevronLeft` / `ChevronRight` usages in WeekView).

- [ ] **Step 3: Update MonthDayCell — weekend tints breathe more**

In `src/index.css`, find `.cal-saturday { color: var(--peach-500); }` and update the block:

```css
/* Weekend day numbers — tinted */
.cal-day-cell.cal-sunday .cal-day-num { color: var(--rose-400); }
.cal-day-cell.cal-saturday .cal-day-num { color: var(--peach-500); }

/* Today = filled warm circle on day number (handled in .cal-day-today) */
.cal-day-cell.cal-day-today {
  /* outline removed — circle is on the number span */
}

.cal-day-cell.cal-day-today .cal-day-num {
  background: var(--stone-700);
  color: var(--cream-50);
  border-radius: 50%;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

/* Breathe more space in cells */
.cal-day-cell {
  min-height: 58px;
  padding: 8px 2px;
}
```

- [ ] **Step 4: Verify TypeScript**

```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 5: Commit**

```
git add src/pages/HistoryPage.tsx src/index.css
git commit -m "feat(design): calendar today filled circle, weekend tints, custom chevrons

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: StatsPage Reskin

**Files:**
- Modify: `src/pages/StatsPage.tsx`

**Interfaces:**
- Consumes: `section-header-accent` CSS class from index.css (added in Task 2)
- Produces: same `StatsPage` component (no behavior changes)

- [ ] **Step 1: Reskin StatsPage section headers and chart cards**

In `src/pages/StatsPage.tsx`, find the four card inner header divs that look like:
```tsx
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--stone-700)', marginBottom: 12 }}>
            {t('stats.formulaTitle')}
          </div>
```

Replace ALL FOUR of them with:
```tsx
          <div className="section-header-accent">
            {t('stats.formulaTitle')}
          </div>
```
(use the correct translation key for each: `stats.formulaTitle`, `stats.feedingTitle`, `stats.diaperTitle`, `stats.tempTitle`)

- [ ] **Step 2: Update Recharts bar radius and gridline style in StatsPage**

For each `<Bar>` element, update radius to `[6,6,0,0]`:
```tsx
<Bar dataKey="formulaMl" fill="var(--peach-300)" radius={[6,6,0,0]} name={t('stats.formulaTooltip')} />
```
And for stacked bars:
```tsx
<Bar dataKey="peeCount"  stackId="a" fill="var(--sage-200)"  radius={[0,0,0,0]} name={t('stats.peeLabel')} />
<Bar dataKey="poopCount" stackId="a" fill="var(--sage-400)"  radius={[6,6,0,0]} name={t('stats.poopLabel')} />
```

For each `<CartesianGrid>`, update to:
```tsx
<CartesianGrid strokeDasharray="2 4" stroke="var(--stone-200)" strokeOpacity={0.6} />
```

Update the `TOOLTIP_STYLE`:
```tsx
const TOOLTIP_STYLE = {
  background: 'var(--cream-50)',
  border: '1px solid var(--stone-200)',
  borderRadius: 10,
  fontSize: 12,
  fontFamily: 'Pretendard, sans-serif',
  boxShadow: '0 4px 12px rgba(0,0,0,0.07)',
}
```

- [ ] **Step 3: Verify TypeScript**

```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```
git add src/pages/StatsPage.tsx
git commit -m "feat(design): stats section accent bars, rounder recharts, cleaner gridlines

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: DiaryPage + MessagesPage Reskin

**Files:**
- Modify: `src/pages/DiaryPage.tsx`
- Modify: `src/pages/MessagesPage.tsx`

**Interfaces:**
- Consumes: `IconPlus`, `IconPencil`, `IconTrash`, `IconX`, `IconBook`, `IconMail` from `../components/icons`
- Produces: same component APIs (no behavior changes)

- [ ] **Step 1: Replace lucide imports in DiaryPage.tsx**

Find:
```tsx
import { Plus, Pencil, Trash2, X, BookOpen } from 'lucide-react'
```
Replace with:
```tsx
import { IconPlus, IconPencil, IconTrash, IconX } from '../components/icons'
```

- [ ] **Step 2: Replace icon usages in DiaryPage.tsx**

In `DiaryEditor`, find `<X size={18} />` → `<IconX size={18} color="var(--stone-500)" />`

In `DiaryPage` header button: `<Plus size={14} />` → `<IconPlus size={14} color="white" />`

In diary card edit/delete buttons:
- `<Pencil size={13} />` → `<IconPencil size={13} color="var(--stone-400)" />`
- `<Trash2 size={13} />` → `<IconTrash size={13} color={confirmDelete === event.id ? 'var(--rose-500)' : 'var(--stone-400)'} />`

- [ ] **Step 3: Reskin diary cards to asymmetric layout**

In `DiaryPage`, find the diary card rendering block (inside `.map`):
```tsx
              <div key={`${event.id}-${event.rev}`} className="card" style={{ padding: '16px 18px' }}>
```

Replace the card's inner content with:
```tsx
              <div
                key={`${event.id}-${event.rev}`}
                className="card stagger-mount"
                style={{ padding: '16px 18px', '--i': i } as React.CSSProperties}
              >
                {/* Title row */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {data.title && (
                      <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--stone-800)', marginBottom: 4 }}>
                        {data.title}
                      </div>
                    )}
                    <div style={{ fontSize: 13, color: 'var(--stone-600)', lineHeight: 1.65, whiteSpace: 'pre-line' }}>
                      {data.text.length > 120 ? data.text.slice(0, 120) + '…' : data.text}
                    </div>
                  </div>
                </div>
                {/* Footer row: date + author chip (right-aligned) */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--stone-400)' }}>
                    {format(parseISO(event.at), t('date.formatFull'), { locale: dateFnsLocale })}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {event.author?.name && (
                      <span style={{
                        fontSize: 11, color: 'var(--stone-500)',
                        background: 'var(--stone-100)', borderRadius: 99, padding: '2px 8px',
                      }}>
                        {t(`role.${event.author.role}`)} {event.author.name}
                      </span>
                    )}
                    <button
                      onClick={() => openEditor(event)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--stone-400)', borderRadius: 5 }}
                    >
                      <IconPencil size={13} color="var(--stone-400)" />
                    </button>
                    <button
                      onClick={() => handleDelete(event)}
                      style={{
                        background: confirmDelete === event.id ? 'var(--rose-100)' : 'none',
                        border: 'none', cursor: 'pointer', padding: 4,
                        color: confirmDelete === event.id ? 'var(--rose-500)' : 'var(--stone-400)',
                        borderRadius: 5,
                      }}
                    >
                      <IconTrash size={13} color={confirmDelete === event.id ? 'var(--rose-500)' : 'var(--stone-400)'} />
                    </button>
                  </div>
                </div>
              </div>
```

Note: `i` is the map index — update the `.map(event => ...)` signature to `.map((event, i) => ...)`.

- [ ] **Step 4: Replace lucide imports in MessagesPage.tsx**

Find:
```tsx
import { Plus, Pencil, Trash2, X, Mail } from 'lucide-react'
```
Replace with:
```tsx
import { IconPlus, IconPencil, IconTrash, IconX } from '../components/icons'
```

- [ ] **Step 5: Replace icon usages in MessagesPage.tsx**

- `<X size={18} />` → `<IconX size={18} color="var(--stone-500)" />`
- `<Plus size={14} />` → `<IconPlus size={14} color="white" />`
- `<Pencil size={13} />` → `<IconPencil size={13} color="var(--stone-400)" />`
- `<Trash2 size={13} />` → `<IconTrash size={13} color={...} />`

- [ ] **Step 6: Apply stationery letter body class in MessagesPage.tsx**

Find the letter card text div:
```tsx
                    <div style={{
                      fontSize: 14, color: 'var(--stone-700)', lineHeight: 1.8,
                      whiteSpace: 'pre-line',
                    }}>
                      {data.text}
                    </div>
```
Replace with:
```tsx
                    <div className="letter-body">
                      {data.text}
                    </div>
```

Also add `stagger-mount` class and `--i` index to the `.map` in MessagesPage (same pattern as DiaryPage step 3).

Update map signature: `.map(event => ...)` → `.map((event, i) => ...)`.

- [ ] **Step 7: Verify TypeScript**

```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 8: Commit**

```
git add src/pages/DiaryPage.tsx src/pages/MessagesPage.tsx
git commit -m "feat(design): diary asymmetric cards, letter stationery feel, custom icons

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Final Verification + Cleanup Commit

**Files:**
- Read: `src/pages/SettingsPage.tsx` (verify no lucide imports remain)
- Run: full test + build

**Interfaces:**
- Consumes: all previous tasks' outputs

- [ ] **Step 1: Scan for remaining lucide-react imports in UI files**

Run:
```
cd "D:\BABY DIARY MAC" && npx tsc --noEmit 2>&1
```

Also scan manually for any remaining lucide imports in UI files (not needed functionally since lucide stays installed):
```
grep -r "from 'lucide-react'" src/pages src/components
```

If SettingsPage.tsx imports lucide icons, replace them with the equivalent from `../components/icons`. Common replacements:
- `Settings` → `IconGear`
- `ChevronLeft/Right` → `IconChevronLeft/Right`

- [ ] **Step 2: Verify prefers-reduced-motion block is comprehensive**

In `src/index.css`, ensure the `@media (prefers-reduced-motion: reduce)` block includes all animated elements:

```css
@media (prefers-reduced-motion: reduce) {
  .stagger-mount {
    animation: none;
  }
  .breathing-dot {
    animation: none;
  }
  .quick-btn-circle,
  .quick-btn {
    transition: background 0.15s ease;
  }
  .quick-btn-circle:hover,
  .quick-btn-circle:active,
  .quick-btn:hover,
  .quick-btn:active {
    transform: none !important;
    box-shadow: none !important;
  }
  .cal-week-row:hover {
    transform: none;
    box-shadow: none;
  }
}
```

- [ ] **Step 3: Run full test suite**

```
cd "D:\BABY DIARY MAC" && npm test -- --run
```

Expected: 58 tests passing, 0 failures

- [ ] **Step 4: Run build**

```
cd "D:\BABY DIARY MAC" && npm run build
```

Expected: build completes with no errors

- [ ] **Step 5: Final commit**

```
git add -A
git commit -m "feat(design): complete design overhaul — warm hand-crafted baby app aesthetic

- Custom SVG icon set (icons.tsx) replaces all lucide-react usages
- Asymmetric home hero: baby name big, D+N pill, stat tile grid
- Circular 72px quick-record buttons with tinted shadows
- Timeline rail design: vertical 2px line, dot, tabular time, author avatar
- Sidebar: baby initial avatar, warm pill active state with left accent bar
- Stats: section accent underline bars, rounder chart bars, cleaner gridlines
- Diary: asymmetric cards with author chip right-aligned
- Letters: stationery top band, ruled-line spacing (CSS background-image)
- Calendar: today as filled warm circle, breathier cells
- CSS motion: cubic-bezier(0.16,1,0.3,1), stagger @keyframes mountIn, breathing dot
- prefers-reduced-motion respected throughout

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

### Spec Coverage

| Requirement | Covered by |
|---|---|
| Custom SVG icon set (8 chunky icons + small set) | Task 1 |
| Replace all lucide usages | Task 1, 3, 5, 6, 7, 8, 9 |
| Icons in soft colored circles w/ 2px lighter ring | Task 1 (ring via `boxShadow` on `timeline-icon`) |
| Asymmetric home hero: LEFT name+dday, RIGHT stat tiles | Task 4 |
| Stat tiles: 3 asymmetric columns (`1.4fr 1fr 1fr`) | Task 4 / index.css |
| Featured tile (수유 총량) larger | Task 4 `stat-tile-featured` |
| Last feeding status as large soft chip with breathing dot | Task 4 |
| Circular 72px quick-record buttons | Task 2, 4 |
| Circular hover: -3px lift + tinted shadow | Task 2 |
| Keep popovers/Enter/timer behavior | Not touched |
| Timeline: vertical 2px line, dot, tabular time, icon chip, content, author avatar | Task 5 |
| Stagger mount animation | Task 2 (`.stagger-mount`) |
| Sidebar: 200px, baby avatar, custom icons, warm pill + 3px left bar | Task 3 |
| Stats: section header accent underline, rounded recharts bars, lighter gridlines, themed tooltips | Task 7 |
| Diary: asymmetric card, author chip right-aligned | Task 8 |
| Letters: top color band + ruled-line spacing | Task 2 (CSS), Task 8 (usage) |
| Calendar: breathier cells, today filled circle, weekend tints | Task 6 |
| Empty states: update stroke to match 2.5 stroke language | Task 5 (timeline), others use existing SVGs |
| CSS-only motion: cubic-bezier, stagger, :active scale, reduced-motion | Task 2, 4 |
| `font-variant-numeric: tabular-nums` on times/numbers | Task 5 (timeline-time), Task 4 (stat-tile-num) |
| Big stats 28-40px semibold | Task 2 (`.stat-tile-num`, `.stat-tile-featured`) |
| Labels 11-12px with tracking | Task 2 (`.stat-tile-label`) |
| Deeper accent text shades | Task 1 (`--sage-600`, etc.) |
| Tinted shadows (not pure black) | Task 2 (`--sage-shadow`, etc.) |
| NO emojis | Confirmed — none in any code |
| NO pure #000 | Confirmed — darkest is `--stone-900: #1a140e` |
| NO purple/neon/text gradients | Confirmed |
| NO 3-equal-column rows | Confirmed (stat grid is `1.4fr 1fr 1fr`) |
| i18n: new strings in ko.json + ja.json | Task 4 (`stat.*` keys) |
| `npx tsc --noEmit` after each task | Specified in each task |
| `npm test` 58 green + `npm run build` | Task 9 |
| Git commit at end | Task 9 |

### Placeholder Scan

- No TBD or TODO in any task step.
- All code blocks contain complete implementations.
- Type consistency: `IconProps` defined in Task 1 Step 1, consumed identically in Tasks 3/4/5/6/8.

### Type Consistency

- `EventIcon` in Task 1 uses `IconComponent = React.ComponentType<{ size?: number; color?: string }>` — consistent with how all icons are called in Tasks 4/5/8.
- `nameToHue` helper duplicated in Sidebar (Task 3) and EventTimeline (Task 5) — intentional (they're different files with no shared utility layer; YAGNI says no new util file).
- `.stagger-mount` class added in Task 2 CSS, consumed with `--i` style prop in Tasks 4, 5, 8 — consistent.
