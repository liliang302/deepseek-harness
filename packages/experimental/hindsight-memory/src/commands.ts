/**
 * `/memory` human command: status, listing, search, and deletion. Commands
 * bypass the model and operate on Hindsight directly. Handler text is a
 * verbatim port of the baseline plugin.
 *
 * @module @deepseek-ai/dsh-hindsight-memory/commands
 */

import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { HindsightClient } from './hindsight.ts'
import { normalizeTarget, type CuratedStore } from './curated.ts'
import { formatEntryList, formatStatus, usageLabel } from './render.ts'
import type { HindsightMemoryConfig } from './types.ts'

/** Render one stats field as text; non-scalars fall back to the placeholder. */
function scalarOf(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return String(value ?? fallback)
  return fallback
}

/** Dependencies for the `/memory` command. */
export interface MemoryCommandDeps {
  /** Curated store. */
  store: CuratedStore
  /** Hindsight client. */
  client: HindsightClient
  /** Runtime configuration. */
  config: HindsightMemoryConfig
}

/**
 * Build the `/memory` command definition.
 * @param deps - store, client, and runtime configuration.
 * @returns a registrable command definition (name `memory`, no attachments).
 */
export function createMemoryCommand({ store, client, config }: MemoryCommandDeps): CommandDefinition {
  return {
    name: 'memory',
    description: '查看 / 检索 / 删除 Hindsight 长期记忆',
    input: {
      hint: '[list [user|memory] | search <关键词> | forget <user|memory> <片段> | stats]',
      attachments: false,
    },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const raw = invocation.rawInput.trim()
      const [verb = 'status', ...rest] = raw.split(/\s+/).filter(Boolean)
      const signal = invocation.signal
      try {
        if (verb === 'stats') {
          const stats = await client.stats(signal)
          return {
            kind: 'success',
            text: [
              `bank=${typeof stats.bank_id === 'string' ? stats.bank_id : config.bank}`,
              `事实 ${scalarOf(stats.total_nodes, '?')} 条 · 链接 ${scalarOf(stats.total_links, '?')} · 文档 ${scalarOf(stats.total_documents, '?')}`,
              `最近写入：${scalarOf(stats.last_memory_write_at, '未知')}`,
            ].join('\n'),
          }
        }

        if (verb === 'list') {
          const target = normalizeTarget(rest[0])
          const entries = await store.list(target, { signal })
          const chars = entries.reduce((total, entry) => total + entry.chars, 0)
          const limit = target === 'user' ? config.userCharLimit : config.memoryCharLimit
          return {
            kind: 'success',
            text: `${target} 共 ${entries.length} 条（${usageLabel({ chars, limit, count: entries.length })}）：\n${formatEntryList(entries)}`,
          }
        }

        if (verb === 'search') {
          const query = rest.join(' ').trim()
          if (query.length === 0) return { kind: 'error', text: '用法：/memory search <关键词>' }
          const results = await client.recall(query, { maxTokens: config.recallTokens, signal })
          if (results.length === 0) return { kind: 'success', text: '记忆库中没有匹配项。' }
          return {
            kind: 'success',
            text: `命中 ${results.length} 条：\n${results.map((item, index) => `${index + 1}. ${item.text}`).join('\n')}`,
          }
        }

        if (verb === 'forget') {
          const target = normalizeTarget(rest[0])
          const oldText = rest.slice(1).join(' ').trim()
          if (oldText.length === 0) return { kind: 'error', text: '用法：/memory forget <user|memory> <条目片段>' }
          const result = await store.remove(target, oldText, { signal })
          if (!result.ok) {
            return {
              kind: 'error',
              text: `${result.reason}\n\n当前 ${target} 条目：\n${formatEntryList(result.entries ?? [])}`,
            }
          }
          return { kind: 'success', text: `已从 ${target} 删除：${result.removed.content.slice(0, 120)}` }
        }

        const loaded = await store.loadAll({ signal })
        return { kind: 'success', text: formatStatus(loaded, config) }
      } catch (error) {
        return { kind: 'error', text: `记忆服务不可用：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}
