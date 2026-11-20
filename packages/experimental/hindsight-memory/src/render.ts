/**
 * Rendering layer: session snapshot, recall block, nudge, tool results, and
 * command output. All model-facing text lives here so wording and length
 * control stay in one place. Copy is a verbatim port of the baseline plugin.
 *
 * @module @deepseek-ai/dsh-hindsight-memory/render
 */

import { charLimitFor } from './config.ts'
import type { HindsightMemoryConfig, LoadedStores, MemoryEntry, UsageSide } from './types.ts'

/** Estimated chars per token, aligned with the Hermes config_defaults note (2.75 chars/token). */
const CHARS_PER_TOKEN = 2.75

/**
 * Estimate a token count from a char count.
 * @param chars - character count.
 * @returns tokens, rounded up.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Render `123/1375 字符 · 9% · 约 45 tokens · 8 条`.
 * @param usage - one side's occupancy.
 * @returns the occupancy label.
 */
export function usageLabel(usage: UsageSide): string {
  const percent = usage.limit > 0 ? Math.round((usage.chars / usage.limit) * 100) : 0
  return `${usage.chars}/${usage.limit} 字符 · ${percent}% · 约 ${estimateTokens(usage.chars)} tokens · ${usage.count} 条`
}

/**
 * Numbered entry list; each entry is clamped so one long line cannot crowd out the rest.
 * @param entries - entries to render.
 * @param maxChars - per-entry char cap before ellipsis.
 * @returns the rendered list, or the empty-store placeholder.
 */
export function formatEntryList(entries: readonly Pick<MemoryEntry, 'content'>[] | undefined, maxChars = 2200): string {
  if (entries === undefined || entries.length === 0) return '（空）'
  return entries
    .map((entry, index) => {
      const content = entry.content
      const text = content.length > maxChars ? `${content.slice(0, maxChars)}…` : content
      return `${index + 1}. ${text}`
    })
    .join('\n')
}

/**
 * Render the frozen session-start snapshot of both curated stores.
 * @param loaded - both stores with their occupancy.
 * @param config - runtime configuration (budgets for labels and truncation).
 * @returns the snapshot text, clamped to `maxInjectedChars`.
 */
export function formatSnapshot(loaded: LoadedStores, config: HindsightMemoryConfig): string {
  const { user, memory, usage } = loaded
  if (user.length === 0 && memory.length === 0) {
    return [
      '[Hindsight 长期记忆] 记忆库中还没有 curated 条目。',
      '当出现值得跨会话保留的事实（用户画像、环境约定、重要结论）时，调用 memory 工具写入；',
      'action=add、target=user 记录「用户是谁」，target=memory 记录「工作环境与经验」。',
    ].join('\n')
  }
  const lines = [
    '[Hindsight 长期记忆 · 会话快照]',
    '以下是你跨会话积累的记忆。USER 描述用户本身，MEMORY 描述工作环境与经验。',
    '会话中可用 memory 工具增删改：改动立即写入 Hindsight，但这份快照在本会话内保持不变。',
    '',
    `=== USER PROFILE (who the user is) [${usageLabel(usage.user)}] ===`,
    formatEntryList(user),
    '',
    `=== MEMORY (your personal notes) [${usageLabel(usage.memory)}] ===`,
    formatEntryList(memory),
    '',
    '写入规则：一条事实只进一个库；用户偏好/个人事实进 USER，工具怪癖/项目约定/路径端点进 MEMORY。',
    '首次遇到新信息就记下来；重复或过时的条目用 replace/remove 整理，不要让同一个事实出现两份。',
  ]
  const rendered = lines.join('\n')
  return rendered.length > config.maxInjectedChars
    ? `${rendered.slice(0, config.maxInjectedChars)}…`
    : rendered
}

/**
 * Render one turn's semantic recall block.
 * @param memories - recalled facts (curated-tagged facts are filtered by the caller).
 * @param config - runtime configuration (injection budget).
 * @returns the recall text, clamped to `maxInjectedChars`.
 */
export function formatRecall(memories: readonly { text: string }[], config: HindsightMemoryConfig): string {
  const body = memories
    .map((memory, index) => {
      const text = memory.text.length > 1200 ? `${memory.text.slice(0, 1200)}…` : memory.text
      return `${index + 1}. ${text}`
    })
    .join('\n')
  const rendered = [
    '[Hindsight 长期记忆 · 相关召回]',
    '以下条目可能与本轮相关：',
    body,
    '（这些是过去的事实，可能已经过时；若与当前对话冲突，以当前事实为准。需要改写时用 memory 工具的 replace/remove。）',
  ].join('\n')
  return rendered.length > config.maxInjectedChars
    ? `${rendered.slice(0, config.maxInjectedChars)}…`
    : rendered
}

/**
 * Render the every-N-turns memory review reminder.
 * @param turn - current turn number.
 * @param config - runtime configuration (budget line).
 * @returns the nudge text.
 */
export function formatNudge(turn: number, config: HindsightMemoryConfig): string {
  return [
    `[Hindsight 记忆提醒] 本会话已进行 ${turn} 轮。`,
    '回看刚才的对话：是否出现了值得跨会话保留的用户偏好、环境事实或重要结论？',
    '有就调用 memory 工具（target=user 记录用户，target=memory 记录环境），一次只记一条，写入前先查是否已有等价条目。',
    '没有就忽略这条提醒，不要为了写而写。',
    `当前预算：USER ${config.userCharLimit} 字符，MEMORY ${config.memoryCharLimit} 字符。`,
  ].join('')
}

/** One lossless tool-result value accepted by {@link renderToolValue}. */
interface ToolResultValue {
  ok?: boolean
  action?: string
  target?: string
  reason?: string
  error?: string
  summary?: string
  entries?: readonly Pick<MemoryEntry, 'content'>[]
  usage?: UsageSide
}

/**
 * Render one memory-tool result as model-facing text blocks.
 * @param value - canonical tool result value.
 * @returns exactly one text block.
 */
export function renderToolValue(value: unknown): { type: 'text'; text: string }[] {
  if (!value || typeof value !== 'object') return [{ type: 'text', text: '无结果' }]
  const result = value as ToolResultValue
  if (result.ok === false) {
    const lines = [`记忆操作失败：${result.reason ?? result.error ?? '未知原因'}`]
    if (result.usage && typeof result.usage.chars === 'number') lines.push('', `占用：${usageLabel(result.usage)}`)
    if (Array.isArray(result.entries) && result.entries.length > 0) {
      lines.push('', '当前条目：', formatEntryList(result.entries))
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const lines: string[] = []
  if (result.action === 'list') {
    lines.push(`记忆条目（${result.target}，${usageLabel(result.usage ?? { chars: 0, limit: 0, count: 0 })}）：`, formatEntryList(result.entries ?? []))
  } else if (result.action === 'add') {
    lines.push(`已写入 ${result.target} 库。`, '', formatEntryList(result.entries ?? []))
  } else if (result.action === 'replace') {
    lines.push(`已替换 ${result.target} 库中的一条记忆。`, '', formatEntryList(result.entries ?? []))
  } else if (result.action === 'remove') {
    lines.push(`已删除 ${result.target} 库中的一条记忆。`, '', formatEntryList(result.entries ?? []))
  } else if (result.action === 'batch') {
    lines.push(`批量操作完成：${result.summary ?? ''}`, '', formatEntryList(result.entries ?? []))
  } else {
    lines.push(JSON.stringify(result))
  }
  if (result.usage) lines.push('', `占用：${usageLabel(result.usage)}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Render the `/memory status` output.
 * @param loaded - both stores with their occupancy.
 * @param config - runtime configuration (bank/url header line).
 * @returns the status text.
 */
export function formatStatus(loaded: LoadedStores, config: HindsightMemoryConfig): string {
  const { user, memory, usage } = loaded
  return [
    `Hindsight 记忆库：${config.bank} @ ${config.url}`,
    `USER   ${usageLabel(usage.user)}`,
    `MEMORY ${usageLabel(usage.memory)}`,
    '',
    '最近条目：',
    ...[...memory.slice(-3).map(entry => `  • [memory] ${entry.content.slice(0, 100)}`),
      ...user.slice(-3).map(entry => `  • [user] ${entry.content.slice(0, 100)}`)],
    '',
    '用法：/memory list [user|memory] · /memory search <query> · /memory forget <user|memory> <片段>',
  ].join('\n')
}

/**
 * Clamp a long text to a char budget with an ellipsis.
 * @param text - candidate text.
 * @param maxChars - inclusive char cap.
 * @returns the text, or its prefix plus `…` when over budget.
 */
export function clampText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

export { charLimitFor }
