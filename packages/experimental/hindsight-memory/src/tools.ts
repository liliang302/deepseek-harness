/**
 * Tool definitions: the Hermes-style single `memory` tool plus semantic
 * recall and quick-retain entry points. Names, descriptions, parameters, and
 * rendered results are a verbatim port of the baseline plugin so model-facing
 * text does not drift. Parameters stay raw JSON Schema (D2): the registry
 * validates `output.schema` only, and execute() checks argument ranges itself.
 *
 * @module @deepseek-ai/dsh-hindsight-memory/tools
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { HindsightClient } from './hindsight.ts'
import { normalizeTarget, SESSION_TAG, TARGETS, type CuratedStore, type OpOptions } from './curated.ts'
import { renderToolValue } from './render.ts'
import type { HindsightMemoryConfig, MemoryEntry, MemoryTarget, StoreResult } from './types.ts'

const ACTION_VALUES = ['add', 'replace', 'remove', 'batch', 'list'] as const
/** Client failures reach tools as Error instances; `unknown` keeps the catch clause honest. */
function failureMessage(error: unknown): string {
  // HindsightClient.request wraps every fetch rejection into HindsightError, so a tool-visible
  // failure is always an Error carrying the transport or HTTP message.
  return (error as Error).message
}

/** Read one string argument; non-strings become ''. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Read one record argument; non-objects become {}. */
function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** Lossless view of an entry list (id + content only). */
function toEntryViews(entries: readonly MemoryEntry[] | undefined): { id: string; content: string }[] {
  return entries === undefined ? [] : entries.map(entry => ({ id: entry.id, content: entry.content }))
}

/** Usage pair side flattened for tool output. */
interface FlatUsage {
  chars: number
  limit: number
  count: number
}

/** Assemble one store result into the canonical tool value, attaching fields only when present. */
function finalize(store: CuratedStore, result: StoreResult, target: MemoryTarget): Record<string, JsonValue> {
  const entries = toEntryViews(result.entries)
  if (!result.ok) {
    const value: Record<string, JsonValue> = {
      ok: false,
      action: 'unknown',
      target,
      reason: result.reason,
    }
    if (entries.length > 0) value.entries = entries
    if (result.usage !== undefined) {
      value.usage = { chars: result.usage.chars, limit: result.usage.limit, count: result.usage.count }
    }
    return value
  }
  const chars = result.entries.reduce((total, entry) => total + entry.chars, 0)
  const limit = target === 'user' ? store.config.userCharLimit : store.config.memoryCharLimit
  return {
    ok: true,
    action: result.action,
    target,
    entries,
    usage: { chars, limit, count: entries.length },
  }
}

/** Execute action=list over one library. */
async function runList(store: CuratedStore, args: Record<string, unknown>, options: OpOptions) {
  const target = normalizeTarget(args.target)
  const entries = await store.list(target, options)
  const chars = entries.reduce((total, entry) => total + entry.chars, 0)
  const limit = target === 'user' ? store.config.userCharLimit : store.config.memoryCharLimit
  return {
    ok: true,
    action: 'list',
    target,
    entries: toEntryViews(entries),
    usage: { chars, limit, count: entries.length } satisfies FlatUsage,
  }
}

/** Execute action=batch sequentially; aggregates both libraries afterwards. */
async function runBatch(store: CuratedStore, args: Record<string, unknown>, options: OpOptions) {
  // The parameters schema declares `operations` as an array of objects; the
  // executor losslessly snapshots model arguments before this point.
  const operations: readonly unknown[] = args.operations as readonly unknown[]
  if (operations.length === 0) {
    return { ok: false, action: 'batch', reason: 'operations 不能为空。' }
  }
  const lines: string[] = []
  let failures = 0
  for (const [index, raw] of operations.entries()) {
    const op = rec(raw)
    const action = str(op.action)
    const target = normalizeTarget(op.target ?? args.target)
    let result: StoreResult | { ok: false; reason: string }
    if (action === 'add') result = await store.add(target, str(op.content), options)
    else if (action === 'replace') result = await store.replace(target, str(op.old_text), str(op.content), options)
    else if (action === 'remove') result = await store.remove(target, str(op.old_text), options)
    else result = { ok: false, reason: `第 ${index + 1} 条操作 action 非法：${action}` }
    if (result.ok) {
      lines.push(`✓ ${index + 1}. ${action} ${target}`)
    } else {
      failures += 1
      lines.push(`✗ ${index + 1}. ${action} ${target}：${result.reason}`)
    }
  }
  const loaded = await store.loadAll(options)
  const value: Record<string, JsonValue> = {
    ok: failures === 0,
    action: 'batch',
    summary: `${operations.length - failures}/${operations.length} 成功${failures > 0 ? '，失败项见下' : ''}`,
    entries: toEntryViews([...loaded.user, ...loaded.memory]),
    usage: {
      chars: loaded.usage.user.chars + loaded.usage.memory.chars,
      limit: loaded.usage.user.limit + loaded.usage.memory.limit,
      count: loaded.usage.user.count + loaded.usage.memory.count,
    } satisfies FlatUsage,
  }
  // reason attaches only on failure: an undefined-valued field would fail the lossless-JSON check.
  if (failures > 0) value.reason = lines.join('\n')
  return value
}

/** Dependencies for the curated `memory` tool. */
export interface MemoryToolDeps {
  /** Curated store. */
  store: CuratedStore
  /** Runtime configuration. */
  config: HindsightMemoryConfig
}

/**
 * Build the `memory` tool definition.
 * @param deps - curated store and runtime configuration.
 * @returns a registrable tool definition with the cooperative timeout budget.
 */
export function createMemoryTool({ store, config }: MemoryToolDeps): ToolDefinition {
  return {
    name: 'memory',
    description: [
      '读写跨会话长期记忆（存储：Hindsight）。两个库：',
      'target=user —— 用户是谁：偏好、沟通/工作风格、个人事实、对助手行为的期待；',
      'target=memory —— 工作环境：工具怪癖、项目约定、配置坑、重要路径与端点、可复用结论。',
      '一条事实只写一个库。',
      'action=add 新增；replace 用 old_text 定位后整条覆盖；remove 用 old_text 定位后删除；',
      'batch 一次提交多个操作；list 查看当前条目与预算占用。',
      'replace/remove 需要 old_text（条目中的唯一片段）。写入前先 list，避免重复；',
      '超出字符预算时先压缩或删除旧条目。不要写入密码、密钥等凭据。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [...ACTION_VALUES],
          description: 'add 新增 / replace 整条替换 / remove 删除 / batch 批量 / list 查看。',
        },
        target: {
          type: 'string',
          enum: [...TARGETS],
          description: 'user=用户画像，memory=环境与经验。默认 memory。batch 中可逐条覆盖。',
        },
        content: {
          type: 'string',
          description: 'add/replace 的新内容。replace 时这是整条记忆的新全文，不是片段。',
        },
        old_text: {
          type: 'string',
          description: 'replace/remove 的定位片段：目标条目中一段唯一、可识别的原文。',
        },
        operations: {
          type: 'array',
          description: 'batch 的操作列表，按顺序执行。',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: ['add', 'replace', 'remove'] },
              target: { type: 'string', enum: [...TARGETS] },
              content: { type: 'string' },
              old_text: { type: 'string' },
            },
            required: ['action'],
          },
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          target: { type: 'string' },
          reason: { type: 'string' },
          summary: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, content: { type: 'string' } },
            },
          },
          usage: {
            type: 'object',
            properties: {
              chars: { type: 'integer' },
              limit: { type: 'integer' },
              count: { type: 'integer' },
            },
          },
        },
        required: ['ok', 'action'],
      },
      render: (_args: unknown, value: JsonValue): ContentBlock[] => renderToolValue(value),
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<JsonValue> {
      const input = rec(args)
      const action = str(input.action)
      const options: OpOptions = { signal: exec.signal }
      try {
        if (!ACTION_VALUES.includes(action as (typeof ACTION_VALUES)[number])) {
          return { ok: false, action: action || 'unknown', reason: `未知 action：${action}` }
        }

        if (action === 'list') return await runList(store, input, options)
        if (action === 'batch') return await runBatch(store, input, options)

        const target = normalizeTarget(input.target)
        if (action === 'add') return finalize(store, await store.add(target, str(input.content), options), target)
        if (action === 'replace') {
          return finalize(store, await store.replace(target, str(input.old_text), str(input.content), options), target)
        }
        return finalize(store, await store.remove(target, str(input.old_text), options), target)
      } catch (error) {
        return {
          ok: false,
          action,
          reason: `记忆服务不可用：${failureMessage(error)}`,
        }
      }
    },
    timeoutMs: Math.max(config.retainTimeoutMs, config.timeoutMs) + 5000,
  }
}

/** Dependencies for the client-backed tools. */
export interface ClientToolDeps {
  /** Hindsight client. */
  client: HindsightClient
  /** Runtime configuration. */
  config: HindsightMemoryConfig
}

/**
 * Build the `memory_recall` tool (semantic search across the whole bank).
 * @param deps - Hindsight client and runtime configuration.
 * @returns a registrable tool definition.
 */
export function createRecallTool({ client, config }: ClientToolDeps): ToolDefinition {
  return {
    name: 'memory_recall',
    description:
      `语义检索 Hindsight 记忆库（bank=${config.bank}）。当需要用户背景、历史决策、项目细节，` +
      '或用户提到「之前 / 上次 / 我记得 / 以前 / 我们讨论过」时调用。返回按相关度排序的事实。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: '自然语言检索查询。' },
        max_tokens: {
          type: 'integer',
          minimum: 1,
          maximum: 8000,
          description: `返回预算，默认 ${config.recallTokens}。`,
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          results: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
        required: ['count', 'results'],
      },
      render: (_args: unknown, value: JsonValue): ContentBlock[] => {
        const raw: readonly unknown[] = Array.isArray(rec(value).results) ? rec(value).results as readonly unknown[] : []
        // The wire schema declares strings; non-strings degrade to their JSON form.
        const results = raw.map(item => typeof item === 'string' ? item : JSON.stringify(item))
        if (results.length === 0) return [{ type: 'text', text: 'Hindsight 未命中相关记忆。' }]
        return [{
          type: 'text',
          text: `Hindsight 命中 ${results.length} 条记忆：\n${results.map((text, index) => `${index + 1}. ${text}`).join('\n')}`,
        }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<JsonValue> {
      const input = rec(args)
      const maxTokens = typeof input.max_tokens === 'number' && Number.isFinite(input.max_tokens)
        ? input.max_tokens
        : config.recallTokens
      try {
        const results = await client.recall(str(input.query), { maxTokens, signal: exec.signal })
        return { count: results.length, results: results.map(item => item.text) }
      } catch (error) {
        return { count: 0, results: [], error: failureMessage(error) }
      }
    },
  }
}

/**
 * Build the `memory_retain` tool (write one raw note into semantic memory,
 * outside the curated layer).
 * @param deps - Hindsight client and runtime configuration.
 * @returns a registrable tool definition.
 */
export function createRetainTool({ client, config }: ClientToolDeps): ToolDefinition {
  return {
    name: 'memory_retain',
    description:
      '把一条结论、事件或环境事实写入 Hindsight 语义记忆（不进 curated 快照）。' +
      '适合记录一次性但值得检索的过程结论；稳定的用户画像/环境约定请用 memory 工具。不要写入凭据。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content: { type: 'string', description: '要记住的内容，一句到一段，写清上下文。' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: `额外标签，与默认标签（${config.tags.join(', ')}）合并。`,
        },
      },
      required: ['content'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args: unknown, value: JsonValue): ContentBlock[] => {
        const result = rec(value)
        return [{ type: 'text', text: result.ok === true ? '已写入 Hindsight 记忆库。' : `写入失败：${str(result.error) || '未知错误'}` }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<JsonValue> {
      const input = rec(args)
      const content = str(input.content).trim()
      if (content.length === 0) return { ok: false, error: '内容为空。' }
      const extra = Array.isArray(input.tags)
        ? input.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        : []
      const tags = [...new Set([...config.tags, SESSION_TAG, ...extra])]
      try {
        await client.retainDocument(
          { id: `dsh-note-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, content, tags, context: 'note' },
          { signal: exec.signal },
        )
        return { ok: true }
      } catch (error) {
        return { ok: false, error: failureMessage(error) }
      }
    },
  }
}
