import { ko } from 'date-fns/locale'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DisclosureSection, resolveDisclosureOpenState } from '../src/components/DisclosureSection'
import { getDataDisclosurePresentation } from '../src/lib/settingsPresentation'

describe('DisclosureSection', () => {
  it('uses native details and exposes a readable summary', () => {
    const html = renderToStaticMarkup(
      <DisclosureSection title="Data" summary="12 records" defaultOpen={false}>
        <button>Export</button>
      </DisclosureSection>,
    )
    expect(html).toContain('<details')
    expect(html).toContain('<summary')
    expect(html).toContain('Data')
    expect(html).toContain('12 records')
    expect(html).not.toContain(' open=""')
  })

  it('renders initially open when defaultOpen is true', () => {
    const html = renderToStaticMarkup(
      <DisclosureSection title="Sync" defaultOpen>
        <button>Retry</button>
      </DisclosureSection>,
    )

    expect(html).toContain(' open=""')
  })

  it('auto-opens only when attention changes from false to true', () => {
    expect(resolveDisclosureOpenState(false, false, true)).toBe(true)
    expect(resolveDisclosureOpenState(false, true, true)).toBe(false)
    expect(resolveDisclosureOpenState(true, true, false)).toBe(true)
    expect(resolveDisclosureOpenState(false, true, false)).toBe(false)
  })
})

describe('Settings data disclosure presentation', () => {
  it('omits the summary while data info is loading', () => {
    expect(getDataDisclosurePresentation(null, {
      formatPattern: 'yyyy-MM-dd',
      locale: ko,
      noBackup: '없음',
    })).toBeNull()
  })

  it('uses a safe fallback for an invalid backup time', () => {
    expect(getDataDisclosurePresentation({ eventCount: 4, lastBackupTime: 'invalid' }, {
      formatPattern: 'yyyy-MM-dd',
      locale: ko,
      noBackup: '없음',
    })).toEqual({ count: 4, backup: '없음' })
  })

  it('formats a valid backup time', () => {
    expect(getDataDisclosurePresentation({ eventCount: 4, lastBackupTime: '2026-07-13' }, {
      formatPattern: 'yyyy-MM-dd',
      locale: ko,
      noBackup: '없음',
    })).toEqual({ count: 4, backup: '2026-07-13' })
  })
})
