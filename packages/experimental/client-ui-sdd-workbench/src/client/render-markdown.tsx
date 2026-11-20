/** Lightweight Markdown subset renderer: headings, lists, tables, fences, inline marks — React elements only. */
import { Fragment, type ReactNode } from 'react'

/** Render one block-level Markdown document as React children. */
export function renderMarkdown(markdown: string): ReactNode {
  return renderBlocks(splitLines(markdown))
}

interface Line { readonly text: string; readonly indent: number }

/** Cursor over the line array; every read past the end yields undefined, so no assertions are needed below. */
class Reader {
  private index = 0
  constructor(private readonly lines: readonly Line[]) {}
  get done(): boolean { return this.index >= this.lines.length }
  peek(offset = 0): Line | undefined { return this.lines[this.index + offset] }
  take(): void { this.index += 1 }
  /** Consume while `test` holds on the current line; returns the consumed run. */
  takeWhile(test: (line: Line) => boolean): Line[] {
    const run: Line[] = []
    for (;;) {
      const line = this.peek()
      if (line === undefined || !test(line)) break
      run.push(line)
      this.take()
    }
    return run
  }
}

const isFence = (line: Line | undefined): boolean => line !== undefined && /^\s*(```|~~~)/u.test(line.text)
const headingLevel = (line: Line): RegExpExecArray | null => /^(#{1,6})\s+(.*)$/u.exec(line.text)
const isTableSep = (text: string): boolean => /^\|?[\s:|-]+\|?$/u.test(text) && text.includes('-')
const isBullet = (line: Line): boolean => line.indent < 4 && /^\s*(?:[-*+]|\d+[.)])\s+/u.test(line.text)

function splitLines(source: string): Line[] {
  return source.replace(/\r\n?/gu, '\n').split('\n').map((raw) => {
    const text = raw.replace(/\s+$/u, '')
    return { text, indent: text.length - text.trimStart().length }
  })
}

function renderBlocks(lines: readonly Line[]): ReactNode {
  const out: ReactNode[] = []
  const reader = new Reader(lines)
  let key = 0
  while (!reader.done) {
    const line = reader.peek()
    if (line === undefined) break
    if (line.text.trim() === '') { reader.take(); continue }
    const fenceMatch = /^(\s*)(```|~~~)(.*)$/u.exec(line.text)
    if (fenceMatch !== null) {
      reader.take()
      const body = reader.takeWhile(candidate => !isFence(candidate))
      reader.take() // closing fence or end of document
      const lang = (fenceMatch[3] ?? '').trim()
      out.push(
        <pre key={key++} className="sddw-code">
          <code>{body.map(candidate => candidate.text).join('\n')}</code>
          {lang.length > 0 ? <span className="sddw-code-lang">{lang}</span> : null}
        </pre>,
      )
      continue
    }
    const heading = headingLevel(line)
    if (heading !== null && line.indent < 4) {
      const level = Math.min((heading[1] ?? '#').length, 6)
      const Tag = (`h${level}`) as 'h1'
      out.push(<Tag key={key++}>{renderInline(heading[2] ?? '')}</Tag>)
      reader.take()
      continue
    }
    if (line.text.trim() === '---' || line.text.trim() === '***') { out.push(<hr key={key++} />); reader.take(); continue }
    if (line.text.startsWith('>')) {
      const quote = reader.takeWhile(candidate => candidate.text.startsWith('>'))
      out.push(<blockquote key={key++}>{renderBlocks(quote.map(stripQuote))}</blockquote>)
      continue
    }
    if (isBullet(line)) {
      const items: ReactNode[][] = []
      for (;;) {
        const bullet = reader.peek()
        if (bullet === undefined || !isBullet(bullet)) break
        const marker = /^\s*(?:[-*+]|\d+[.)])\s+/u.exec(bullet.text)
        const children: ReactNode[] = [renderInline(bullet.text.slice((marker?.[0]?.length ?? 2)))]
        reader.take()
        for (;;) {
          const cont = reader.peek()
          if (cont === undefined || cont.indent < 2 || cont.text.trim() === '' || isBullet(cont) || headingLevel(cont) !== null) break
          children.push(renderInline(cont.text))
          reader.take()
        }
        items.push(children)
      }
      const rendered = items.map((children, i) => <li key={i}>{children}</li>)
      out.push(/^\s*\d+[.)]/u.test(line.text) ? <ol key={key++}>{rendered}</ol> : <ul key={key++}>{rendered}</ul>)
      continue
    }
    const next = reader.peek(1)
    if (line.text.includes('|') && next !== undefined && isTableSep(next.text)) {
      const header = splitRow(line.text)
      reader.take(); reader.take()
      const rows: string[][] = []
      for (;;) {
        const row = reader.peek()
        if (row === undefined || !row.text.includes('|') || row.text.trim() === '') break
        rows.push(splitRow(row.text))
        reader.take()
      }
      out.push(
        <table key={key++} className="sddw-table">
          <thead><tr>{header.map((cell, i) => <th key={i}>{renderInline(cell)}</th>)}</tr></thead>
          <tbody>{rows.map((row, r) => <tr key={r}>{header.map((_, c) => <td key={c}>{renderInline(row[c] ?? '')}</td>)}</tr>)}</tbody>
        </table>,
      )
      continue
    }
    const paragraph = reader.takeWhile(candidate =>
      candidate.text.trim() !== ''
      && !isFence(candidate)
      && headingLevel(candidate) === null
      && !isBullet(candidate)
      && !candidate.text.startsWith('>'))
    out.push(<p key={key++}>{renderInline(paragraph.map(candidate => candidate.text).join(' '))}</p>)
  }
  return out
}

function stripQuote(line: Line): Line {
  return { text: line.text.replace(/^>\s?/u, ''), indent: 0 }
}

function splitRow(text: string): string[] {
  return text.replace(/^\s*\|/u, '').replace(/\|\s*$/u, '').split('|').map(cell => cell.trim())
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]]+\]\([^)]*\))/gu

/** Inline marks: code, bold, italic; links degrade to their label text with the target in `title` (PRD FR-04). */
export function renderInline(text: string): ReactNode {
  const nodes: ReactNode[] = []
  let last = 0
  let key = 0
  for (const match of text.matchAll(INLINE)) {
    const start = match.index
    if (start > last) nodes.push(text.slice(last, start))
    const token = match[0]
    if (token.startsWith('`')) nodes.push(<code key={key++}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**') || token.startsWith('__')) nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]*)\)$/u.exec(token)
      nodes.push(<span key={key++} className="sddw-link" title={link?.[2]}>{link?.[1] ?? token}</span>)
    }
    else nodes.push(<em key={key++}>{token.slice(1, -1)}</em>)
    last = start + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes.length === 1 ? nodes[0] : <Fragment>{nodes}</Fragment>
}
