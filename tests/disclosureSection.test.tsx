import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DisclosureSection } from '../src/components/DisclosureSection'

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
})
