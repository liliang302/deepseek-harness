/** Render layer: usage labels, snapshot/recall/nudge/status text, tool rendering, clamps. */
import { describe, expect, it } from 'vitest'
import { DEFAULTS, normalizeConfig } from '../src/config.ts'
import {
  clampText, estimateTokens, formatEntryList, formatNudge, formatRecall, formatSnapshot, formatStatus, renderToolValue, usageLabel,
} from '../src/render.ts'

/** First text block of a rendered tool result, as a plain string for assertions. */
function renderText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks[0]?.text ?? ''
}

const config = normalizeConfig({})

function loaded(userContents: readonly string[], memoryContents: readonly string[]) {
  const mk = (contents: readonly string[]) => contents.map((content, index) => ({
    id: `d${index}`, content, chars: content.length, createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
  }))
  const user = mk(userContents)
  const memory = mk(memoryContents)
  return {
    user,
    memory,
    usage: {
      user: { chars: user.reduce((t, e) => t + e.chars, 0), limit: config.userCharLimit, count: user.length },
      memory: { chars: memory.reduce((t, e) => t + e.chars, 0), limit: config.memoryCharLimit, count: memory.length },
    },
  }
}

describe('UT-R1 tokens and usage label', () => {
  it('estimateTokens divides by 2.75 rounded up', () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(3)).toBe(2)
    expect(estimateTokens(275)).toBe(100)
  })

  it('usageLabel formats chars/limit/percent/tokens/count', () => {
    expect(usageLabel({ chars: 123, limit: 1375, count: 8 })).toBe('123/1375 字符 · 9% · 约 45 tokens · 8 条')
    expect(usageLabel({ chars: 5, limit: 0, count: 1 })).toContain('0%')
  })
})

describe('UT-R2 snapshot', () => {
  it('empty stores render the bootstrap guidance', () => {
    const text = formatSnapshot(loaded([], []), config)
    expect(text).toContain('[Hindsight 长期记忆] 记忆库中还没有 curated 条目。')
    expect(text).toContain('memory 工具写入')
  })

  it('populated stores render both sections with budgets', () => {
    const text = formatSnapshot(loaded(['偏好中文'], ['NAS=192.168.2.253']), config)
    expect(text).toContain('=== USER PROFILE (who the user is)')
    expect(text).toContain('=== MEMORY (your personal notes)')
    expect(text).toContain('1. 偏好中文')
    expect(text).toContain('写入规则：一条事实只进一个库')
  })

  it('clamps at maxInjectedChars with ellipsis', () => {
    const tiny = normalizeConfig({ maxInjectedChars: 20 })
    const text = formatSnapshot(loaded(['a'.repeat(50)], ['b'.repeat(50)]), tiny)
    expect(text.length).toBe(21)
    expect(text.endsWith('…')).toBe(true)
  })
})

it('UT-R3 recall/nudge/entry-list rendering', () => {
  const recall = formatRecall([{ text: '旧决策 A' }, { text: 'x'.repeat(1300) }], config)
  expect(recall).toContain('[Hindsight 长期记忆 · 相关召回]')
  expect(recall).toContain('1. 旧决策 A')
  expect(recall).toContain('…') // long fact clamped
  expect(recall).toContain('若与当前对话冲突，以当前事实为准')

  const nudge = formatNudge(20, config)
  expect(nudge).toContain('本会话已进行 20 轮')
  expect(nudge).toContain(`USER ${DEFAULTS.userCharLimit}`)

  expect(formatEntryList([])).toBe('（空）')
  expect(formatEntryList([{ content: 'x'.repeat(10) }], 4)).toBe(`1. ${'x'.repeat(4)}…`)
})

it('renderToolValue covers every action branch plus failures', () => {
  const block = (value: unknown): string => renderText(renderToolValue(value))
  expect(renderText(renderToolValue(null))).toBe('无结果')
  expect(block({ ok: false, reason: '超预算', usage: { chars: 9, limit: 10, count: 1 }, entries: [{ content: 'e' }] }))
    .toContain('占用：9/10 字符')
  expect(block({ ok: false, reason: '失败' })).toContain('记忆操作失败：失败')

  expect(block({ ok: true, action: 'list', target: 'user', entries: [{ content: 'c' }], usage: { chars: 1, limit: 2, count: 1 } }))
    .toContain('记忆条目（user')
  expect(block({ ok: true, action: 'add', target: 'memory', entries: [] })).toContain('已写入 memory 库')
  expect(block({ ok: true, action: 'replace', target: 'memory', entries: [] })).toContain('已替换')
  expect(block({ ok: true, action: 'remove', target: 'user', entries: [] })).toContain('已删除')
  expect(block({ ok: true, action: 'batch', summary: '2/2 成功', entries: [] })).toContain('批量操作完成：2/2 成功')
  expect(block({ ok: true, action: 'weird' })).toContain('"weird"')
})

it('formatStatus lists bank header and recent entries', () => {
  const text = formatStatus(loaded(['u1'], ['m1', 'm2']), config)
  expect(text).toContain(`Hindsight 记忆库：${config.bank} @ ${config.url}`)
  expect(text).toContain('• [memory] m2')
  expect(text).toContain('• [user] u1')
  expect(text).toContain('/memory search <query>')
})

it('clampText boundary', () => {
  expect(clampText('abc', 3)).toBe('abc')
  expect(clampText('abcd', 3)).toBe('abc…')
})

it('render branches tolerate missing fields (render 153..165 paths)', () => {
  const block = (value: unknown): string => renderText(renderToolValue(value))
  expect(block({ ok: true, action: 'list' })).toContain('（空）') // entries/usage absent
  expect(block({ ok: true, action: 'batch' })).toContain('批量操作完成：')
  expect(block({ ok: false, reason: 'r', usage: { chars: 1, limit: 2, count: 3 }, entries: [] })).toContain('占用')
})

it('formatRecall clamps at maxInjectedChars (render 105)', () => {
  const tiny = normalizeConfig({ maxInjectedChars: 30 })
  const out = formatRecall([{ text: 'x'.repeat(100) }], tiny)
  expect(out.length).toBe(31)
})

it('render success branches survive absent entries arrays (paths at 157..161)', () => {
  const block = (value: unknown): string => renderText(renderToolValue(value))
  for (const action of ['add', 'replace', 'remove']) {
    expect(block({ ok: true, action, target: 'memory' })).toContain('库')
  }
})
