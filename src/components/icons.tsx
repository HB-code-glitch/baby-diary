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

export function IconFolderOpen({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M3 7C3 5.895 3.895 5 5 5H10L12 7H19C20.105 7 21 7.895 21 9V17C21 18.105 20.105 19 19 19H5C3.895 19 3 18.105 3 17V7Z" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M3 12H21" stroke={color} strokeWidth={strokeWidth * 0.6} strokeLinecap="round" opacity="0.4"/>
    </svg>
  )
}

export function IconDownload({ size = defaults.size, color = 'currentColor', strokeWidth = defaults.strokeWidth, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M12 3V15M12 15L8 11M12 15L16 11" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M5 20H19" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"/>
    </svg>
  )
}
