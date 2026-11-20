/** Markdown subset renderer folds documents into React element trees without raw HTML. */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { renderInline, renderMarkdown } from '../src/client/render-markdown.tsx'

const html = (source: string): string => renderToStaticMarkup(<div>{renderMarkdown(source)}</div>)

describe('renderMarkdown', () => {
  it('renders headings by level', () => {
    expect(html('# A\n## B\n###### F')).toContain('<h1>A</h1>')
    expect(html('# A\n## B\n###### F')).toContain('<h6>F</h6>')
  })

  it('renders fenced code with the language marker and no inline parsing inside', () => {
    const out = html('```ts\nconst x = "**not bold**"\n```')
    expect(out).toContain('<pre')
    expect(out).toContain('&quot;**not bold**&quot;')
    expect(out).not.toContain('<strong>')
  })

  it('renders GFM pipe tables', () => {
    const out = html('| a | b |\n|---|---|\n| 1 | **2** |')
    expect(out).toContain('<table')
    expect(out).toContain('<th>a</th>')
    expect(out).toContain('<td><strong>2</strong></td>')
  })

  it('renders bullet and ordered lists', () => {
    expect(html('- one\n- two')).toContain('<ul><li>one</li><li>two</li></ul>')
    expect(html('1. one\n2. two')).toContain('<ol><li>one</li><li>two</li></ol>')
  })

  it('degrades links to label text with the target as title', () => {
    const out = html('[docs](../BRIEF.md)')
    expect(out).toContain('class="sddw-link"')
    expect(out).toContain('title="../BRIEF.md"')
    expect(out).not.toContain('<a ')
  })

  it('escapes raw HTML input', () => {
    expect(html('<script>alert(1)</script>')).not.toContain('<script>alert')
  })
})

it('renderInline marks code/bold/italic', () => {
  const out = renderToStaticMarkup(<p>{renderInline('`c` **b** *i*')}</p>)
  expect(out).toContain('<code>c</code> <strong>b</strong> <em>i</em>')
})
