/**
 * CuratedStore — Hermes-style memory over Hindsight documents.
 *
 * One memory = one document: the fact layer is split/merged by the extractor
 * and cannot address "one memory", while documents keep `original_text`,
 * tags, caller-chosen ids, and `created_at` — exactly what add /
 * replace(old_text) / remove need. Derived facts still participate in recall.
 *
 * The two libraries are tag-separated like MEMORY.md / USER.md:
 *   - user   → mem:user   (who the user is)
 *   - memory → mem:memory (working environment and experience)
 *
 * @module @deepseek-ai/dsh-hindsight-memory/curated
 */

import { charLimitFor } from './config.ts'
import type { HindsightClient } from './hindsight.ts'
import { randomId } from './hindsight.ts'
import { inspectContent, inspectLength } from './security.ts'
import type {
  HindsightMemoryConfig,
  LoadedStores,
  MatchResult,
  MemoryEntry,
  MemoryTarget,
  RemoveOutcome,
  StoreFailure,
  StoreResult,
  UsagePair,
} from './types.ts'

/** The curated target libraries. */
export const TARGETS: readonly MemoryTarget[] = Object.freeze(['user', 'memory'])

/** Every curated document carries this tag, separating it from auto-retained mem:session notes. */
export const CURATED_TAG = 'curated'

/** Session-retention tag on auto-written turn documents. */
export const SESSION_TAG = 'mem:session'

/**
 * Tag naming one curated library.
 * @param target - curated library.
 * @returns its `mem:<target>` tag.
 */
export function targetTag(target: MemoryTarget): string {
  return `mem:${target}`
}

/**
 * Normalize a target value; anything but `user` falls back to `memory`.
 * @param target - raw model/user-supplied target.
 * @returns the resolved library.
 */
export function normalizeTarget(target: unknown): MemoryTarget {
  return target === 'user' ? 'user' : 'memory'
}

/**
 * Fold quotes, dashes, and whitespace for tolerant old_text matching.
 * @param text - candidate fragment.
 * @returns the folded comparison form.
 */
export function normalizeForMatch(text: string): string {
  const folded = text
    .replace(/\\n/g, ' ')
    .replace(/["`\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f]/gu, "'")
    .replace(/[\u2010-\u2015\u2212]/g, '-')
  return folded.split(/\s+/).filter(Boolean).join(' ')
}

/**
 * Find the single entry containing a fragment: exact first, then folded.
 * @param entries - current library entries.
 * @param oldText - unique fragment locating the entry.
 * @returns the matched entry, or an ambiguity/no-match reason.
 */
export function findUniqueEntry(entries: readonly MemoryEntry[], oldText: string): MatchResult {
  const needle = oldText.trim()
  if (needle.length === 0) {
    return { reason: 'old_text 不能为空：请给出目标条目中的一个唯一片段。' }
  }
  const exact = entries.filter(entry => entry.content.includes(needle))
  if (exact.length === 1 && exact[0] !== undefined) return { entry: exact[0] }
  const folded = entries.filter(entry => normalizeForMatch(entry.content).includes(normalizeForMatch(needle)))
  if (folded.length === 1 && folded[0] !== undefined) return { entry: folded[0] }
  if (exact.length === 0 && folded.length === 0) {
    return { reason: `没有条目包含「${needle}」。请改用条目中的一段原文。` }
  }
  const candidates = (exact.length > 1 ? exact : folded).map(entry => entry.content.slice(0, 80))
  return {
    reason: `「${needle}」匹配到 ${Math.max(exact.length, folded.length)} 条记忆，无法确定目标。请给出更长的唯一片段：${candidates
      .map(text => `「${text}」`)
      .join('、')}`,
  }
}

/** Per-operation options. */
export interface OpOptions {
  /** Caller cancellation forwarded to every HTTP call. */
  readonly signal?: AbortSignal | undefined
}

/**
 * Read document details with bounded concurrency; a failed read skips that
 * entry instead of failing the whole load.
 * @param client - Hindsight client.
 * @param ids - document ids to read.
 * @param signal - caller cancellation.
 * @param concurrency - max in-flight reads.
 * @returns id → detail for the documents that read successfully.
 */
async function readDetails(
  client: HindsightClient,
  ids: readonly string[],
  signal: AbortSignal | undefined,
  concurrency = 8,
): Promise<Map<string, Awaited<ReturnType<HindsightClient['getDocument']>>>> {
  const results = new Map()
  let index = 0
  async function worker(): Promise<void> {
    while (index < ids.length) {
      /* v8 ignore next 2 -- `ids` is compacted to strings before the fan-out, so an
       * out-of-range read is unreachable; the guard documents the worker contract. */
      const id = ids[index] ?? ''
      index += 1
      try {
        results.set(id, await client.getDocument(id, { signal }))
      } catch (_documentReadFailed) {
        // A single failed read skips that entry rather than failing the whole load.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()))
  return results
}

/** Curated store over one Hindsight bank. */
export class CuratedStore {
  /** Underlying HTTP client. */
  readonly client: HindsightClient
  /** Runtime configuration. */
  readonly config: HindsightMemoryConfig

  /**
   * @param client - Hindsight client.
   * @param config - runtime configuration.
   */
  constructor(client: HindsightClient, config: HindsightMemoryConfig) {
    this.client = client
    this.config = config
  }

  /**
   * Read one library's entries, oldest first.
   * @param target - curated library.
   * @param options - caller signal.
   * @returns entries with non-empty trimmed text.
   */
  async list(target: MemoryTarget, options: OpOptions = {}): Promise<MemoryEntry[]> {
    const tags = [...this.config.tags, CURATED_TAG, targetTag(target)]
    const { items } = await this.client.listDocuments({
      tags,
      tagsMatch: 'all_strict',
      limit: this.config.maxEntries,
      signal: options.signal,
    })
    const ids = items.map(item => item.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
    const details = await readDetails(this.client, ids, options.signal)
    const entries: MemoryEntry[] = []
    for (const id of ids) {
      const detail = details.get(id)
      if (!detail || detail.originalText.trim().length === 0) continue
      const content = detail.originalText.trim()
      entries.push({ id, content, chars: content.length, createdAt: detail.createdAt })
    }
    entries.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
    return entries
  }

  /**
   * Read both libraries concurrently.
   * @param options - caller signal.
   * @returns both stores plus combined occupancy.
   */
  async loadAll(options: OpOptions = {}): Promise<LoadedStores> {
    const [user, memory] = await Promise.all([this.list('user', options), this.list('memory', options)])
    return { user, memory, usage: this.usage(user, memory) }
  }

  /**
   * Compute both libraries' char occupancy.
   * @param user - USER entries.
   * @param memory - MEMORY entries.
   * @returns per-side usage against configured budgets.
   */
  usage(user: readonly MemoryEntry[], memory: readonly MemoryEntry[]): UsagePair {
    const sum = (entries: readonly MemoryEntry[]) => entries.reduce((total, entry) => total + entry.chars, 0)
    return {
      user: { chars: sum(user), limit: this.config.userCharLimit, count: user.length },
      memory: { chars: sum(memory), limit: this.config.memoryCharLimit, count: memory.length },
    }
  }

  /**
   * Append one curated entry after security screening and budget checks.
   * @param target - curated library.
   * @param content - entry text (trimmed before storage).
   * @param options - caller signal.
   * @returns success view, or a failure with the current entries for follow-up.
   */
  async add(target: MemoryTarget, content: string, options: OpOptions = {}): Promise<StoreResult> {
    const text = content.trim()
    const checked = inspectContent(text, { protectSecrets: this.config.protectSecrets })
    if (!checked.ok) return { ok: false, kind: checked.kind, reason: checked.reason }
    const limit = charLimitFor(this.config, target)
    const length = inspectLength(text, Math.min(this.config.maxEntryChars, limit))
    if (!length.ok) return { ok: false, kind: length.kind, reason: length.reason }

    const entries = await this.list(target, options)
    const current = entries.reduce((total, entry) => total + entry.chars, 0)
    if (current + text.length > limit) {
      return {
        ok: false,
        kind: 'over_budget',
        reason:
          `加入这条记忆后 ${target} 库会占用 ${current + text.length}/${limit} 字符，超出预算。` +
          '请先合并、压缩或删除旧条目（action=replace / remove），再重试。',
        entries,
        usage: { chars: current + text.length, limit, count: entries.length + 1 },
      }
    }

    const id = randomId('dsh-mem')
    await this.retainCurated(target, id, text, options)
    const next: MemoryEntry[] = [...entries, { id, content: text, chars: text.length, createdAt: new Date().toISOString() }]
    return { ok: true, action: 'add', target, entry: { id, content: text }, entries: next }
  }

  /**
   * Replace one entry wholesale (old_text only locates it). The new document
   * is written before the old one is deleted, so a failed write leaves the
   * original intact.
   * @param target - curated library.
   * @param oldText - unique fragment of the entry to replace.
   * @param content - the entry's complete new text.
   * @param options - caller signal.
   * @returns success view with the replaced entry, or a failure.
   */
  async replace(target: MemoryTarget, oldText: string, content: string, options: OpOptions = {}): Promise<StoreResult> {
    const text = content.trim()
    const checked = inspectContent(text, { protectSecrets: this.config.protectSecrets })
    if (!checked.ok) return { ok: false, kind: checked.kind, reason: checked.reason }

    const entries = await this.list(target, options)
    const matched = findUniqueEntry(entries, oldText)
    if ('reason' in matched) {
      return { ok: false, kind: 'no_match', reason: matched.reason, entries } satisfies StoreFailure
    }
    const limit = charLimitFor(this.config, target)
    const length = inspectLength(text, Math.min(this.config.maxEntryChars, limit))
    if (!length.ok) return { ok: false, kind: length.kind, reason: length.reason }

    const current = entries.reduce((total, entry) => total + entry.chars, 0)
    const nextTotal = current - matched.entry.chars + text.length
    if (nextTotal > limit) {
      return {
        ok: false,
        kind: 'over_budget',
        reason: `替换后 ${target} 库会占用 ${nextTotal}/${limit} 字符，超出预算。请再压缩一些。`,
        entries,
        usage: { chars: nextTotal, limit, count: entries.length },
      }
    }

    const id = randomId('dsh-mem')
    await this.retainCurated(target, id, text, options)
    await this.client.deleteDocument(matched.entry.id, options)

    const next: MemoryEntry[] = entries.map(entry =>
      entry.id === matched.entry.id
        ? { id, content: text, chars: text.length, createdAt: new Date().toISOString() }
        : entry,
    )
    return {
      ok: true,
      action: 'replace',
      target,
      entry: { id, content: text },
      replaced: matched.entry,
      entries: next,
    }
  }

  /**
   * Delete one located entry.
   * @param target - curated library.
   * @param oldText - unique fragment of the entry to delete.
   * @param options - caller signal.
   * @returns success view with the deleted units count, or a no-match failure.
   */
  async remove(target: MemoryTarget, oldText: string, options: OpOptions = {}): Promise<RemoveOutcome> {
    const entries = await this.list(target, options)
    const matched = findUniqueEntry(entries, oldText)
    if ('reason' in matched) {
      return { ok: false, kind: 'no_match', reason: matched.reason, entries } satisfies StoreFailure
    }
    const deleted = await this.client.deleteDocument(matched.entry.id, options)
    const next = entries.filter(entry => entry.id !== matched.entry.id)
    return { ok: true, action: 'remove', target, removed: matched.entry, deletedUnits: deleted, entries: next }
  }

  /** Write one curated document with the standard tag/metadata set. */
  private async retainCurated(target: MemoryTarget, id: string, text: string, options: OpOptions): Promise<void> {
    await this.client.retainDocument(
      {
        id,
        content: text,
        tags: [...this.config.tags, CURATED_TAG, targetTag(target)],
        context: `curated memory (${target})`,
        metadata: { source: 'dsh-memory', target, schema: 'curated-v1' },
      },
      options,
    )
  }
}
