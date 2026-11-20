/**
 * Hindsight HTTP client (zero runtime dependencies beyond global fetch).
 *
 * This plugin uses only the document + fact layers:
 *   - documents store curated memory originals and are the stable unit for
 *     add / replace(old_text) / remove;
 *   - auto-extracted facts participate in semantic recall and consolidation
 *     without plugin intervention.
 *
 * @module @deepseek-ai/dsh-hindsight-memory/hindsight
 */

import type { HindsightMemoryConfig, RecallFact } from './types.ts'

/** HTTP or protocol failure; callers decide between silent degradation and a reported error. */
export class HindsightError extends Error {
  /** HTTP status when the failure came from a response. */
  readonly status: number | undefined
  /** Failure class: `unreachable` (fetch threw) or `http` (non-2xx). */
  readonly code: string | undefined

  /**
   * @param message - human-facing failure text.
   * @param info - optional status and failure code.
   */
  constructor(message: string, info: { status?: number; code?: string } = {}) {
    super(message)
    this.name = 'HindsightError'
    this.status = info.status
    this.code = info.code
  }
}

/**
 * Generate a prefixed random id (crypto.randomUUID with a timestamp fallback).
 * @param prefix - id family, e.g. `dsh-mem`.
 * @returns the prefixed id.
 */
export function randomId(prefix: string): string {
  const api = globalThis.crypto
  if (typeof api.randomUUID === 'function') return `${prefix}-${api.randomUUID()}`
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

/** Per-call options shared by read operations. */
export interface CallOptions {
  /** Caller cancellation forwarded to fetch. */
  readonly signal?: AbortSignal | undefined
}

/** One document's detail fields as read back from Hindsight. */
export interface DocumentDetail {
  /** Document id (the caller-supplied one). */
  readonly id: string
  /** Stored original text ('' when absent). */
  readonly originalText: string
  /** Document tags. */
  readonly tags: readonly string[]
  /** ISO creation timestamp ('' when absent). */
  readonly createdAt: string
  /** ISO update timestamp ('' when absent). */
  readonly updatedAt: string
  /** Custom document metadata. */
  readonly metadata: Record<string, string>
}

/** Input for {@link HindsightClient.retainDocument}. */
export interface RetainInput {
  /** Caller-chosen document id, so replace can write-before-delete. */
  readonly id: string
  /** Original text to store. */
  readonly content: string
  /** Tags attached to the document. */
  readonly tags: readonly string[]
  /** Optional context label for the extraction pipeline. */
  readonly context?: string
  /** Optional custom metadata; an empty object is not sent. */
  readonly metadata?: Record<string, string>
}

/**
 * REST client over one self-hosted Hindsight deployment.
 * `fetchImpl` is the test seam; production uses `globalThis.fetch`.
 */
export class HindsightClient {
  /** Runtime configuration used for urls, budgets, and timeouts. */
  readonly config: HindsightMemoryConfig

  private readonly fetchImpl: typeof fetch

  /**
   * @param config - runtime configuration.
   * @param deps - optional fetch replacement for tests.
   */
  constructor(config: HindsightMemoryConfig, deps: { fetchImpl?: typeof fetch } = {}) {
    this.config = config
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch
  }

  /**
   * Build one bank-scoped url.
   * @param bank - bank id (percent-encoded).
   * @param path - path starting with `/`, after the bank prefix.
   * @returns the absolute url.
   */
  url(bank: string, path: string): string {
    return `${this.config.url}/v1/default/banks/${encodeURIComponent(bank)}${path}`
  }

  /**
   * Send one JSON request and parse its payload.
   * @param method - HTTP method.
   * @param bank - target bank id.
   * @param path - bank-relative path.
   * @param options - body, caller signal, and timeout override.
   * @returns the parsed JSON payload, or undefined for an empty body.
   * @throws {HindsightError} `unreachable` when fetch rejects, `http` on non-2xx.
   */
  async request(
    method: string,
    bank: string,
    path: string,
    options: { body?: unknown; signal?: AbortSignal | undefined; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown> | undefined> {
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs
    const headers: Record<string, string> = { accept: 'application/json' }
    const init: RequestInit = { method, headers }
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
    if (options.signal !== undefined) signals.push(options.signal)
    init.signal = AbortSignal.any(signals)
    let response: Response
    try {
      response = await this.fetchImpl(this.url(bank, path), init)
    } catch (error) {
      throw new HindsightError(`无法连接 Hindsight：${error instanceof Error ? error.message : String(error)}`, {
        code: 'unreachable',
      })
    }
    const text = await response.text()
    let payload: Record<string, unknown> | undefined
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>
      } catch (_invalidJsonBody) {
        // A malformed body still classifies by status below; the raw text becomes the detail.
        payload = undefined
      }
    }
    if (!response.ok) {
      const detail = typeof payload?.detail === 'string' ? payload.detail : text.slice(0, 200)
      throw new HindsightError(`Hindsight HTTP ${response.status}：${detail || '无响应体'}`, {
        status: response.status,
        code: 'http',
      })
    }
    return payload
  }

  /**
   * Semantic recall over extracted facts (curated and auto-retained alike).
   * @param query - natural-language query; blank queries recall nothing.
   * @param options - token budget, tag filter, and caller signal.
   * @returns facts with non-empty text, in service order.
   */
  async recall(
    query: string,
    options: { maxTokens?: number | undefined; tags?: readonly string[]; tagsMatch?: string; signal?: AbortSignal | undefined } = {},
  ): Promise<RecallFact[]> {
    const text = query.trim()
    if (text.length === 0) return []
    const body: Record<string, unknown> = { query: text, max_tokens: options.maxTokens ?? this.config.recallTokens }
    if (options.tags !== undefined && options.tags.length > 0) {
      body.tags = options.tags
      body.tags_match = options.tagsMatch ?? 'any'
    }
    const payload = await this.request('POST', this.config.bank, '/memories/recall', {
      body,
      signal: options.signal,
    })
    const results = Array.isArray(payload?.results) ? payload.results : []
    return results
      .map((raw): RecallFact => {
        const item = raw as Record<string, unknown>
        return {
          id: typeof item.id === 'string' ? item.id : '',
          text: typeof item.text === 'string' ? item.text.trim() : '',
          tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
          factType: typeof item.fact_type === 'string' ? item.fact_type : '',
        }
      })
      .filter(item => item.text.length > 0)
  }

  /**
   * List documents; repeated `tags` params match Hindsight's array style.
   * @param options - tag filter, page size/offset, and caller signal.
   * @returns raw items and the total count (0 when absent or non-numeric).
   */
  async listDocuments(
    options: { tags?: string[]; tagsMatch?: string; limit?: number; offset?: number; signal?: AbortSignal | undefined } = {},
  ): Promise<{ items: Record<string, unknown>[]; total: number }> {
    const params = new URLSearchParams()
    for (const tag of options.tags ?? []) params.append('tags', tag)
    if (options.tagsMatch !== undefined) params.set('tags_match', options.tagsMatch)
    params.set('limit', String(options.limit ?? 100))
    params.set('offset', String(options.offset ?? 0))
    const payload = await this.request('GET', this.config.bank, `/documents?${params.toString()}`, {
      signal: options.signal,
    })
    return {
      items: Array.isArray(payload?.items) ? payload.items as Record<string, unknown>[] : [],
      total: typeof payload?.total === 'number' ? payload.total : 0,
    }
  }

  /**
   * Read one document's original text and metadata.
   * @param id - document id (percent-encoded into the path).
   * @param options - caller signal.
   * @returns detail fields with per-field fallbacks for missing payload members.
   */
  async getDocument(id: string, options: CallOptions = {}): Promise<DocumentDetail> {
    const payload = await this.request('GET', this.config.bank, `/documents/${encodeURIComponent(id)}`, {
      signal: options.signal,
    })
    const metadata = payload?.document_metadata
    return {
      id,
      originalText: typeof payload?.original_text === 'string' ? payload.original_text : '',
      tags: Array.isArray(payload?.tags) ? payload.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      createdAt: typeof payload?.created_at === 'string' ? payload.created_at : '',
      updatedAt: typeof payload?.updated_at === 'string' ? payload.updated_at : '',
      metadata: typeof metadata === 'object' && metadata !== null ? metadata as Record<string, string> : {},
    }
  }

  /**
   * Write one document. Uses the longer `retainTimeoutMs` because server-side
   * extraction takes seconds.
   * @param input - document id, content, tags, and optional context/metadata.
   * @param options - caller signal.
   * @returns when the service accepted the write.
   */
  async retainDocument(input: RetainInput, options: CallOptions = {}): Promise<void> {
    const item: Record<string, unknown> = {
      content: input.content,
      document_id: input.id,
      tags: input.tags,
    }
    if (input.context !== undefined) item.context = input.context
    if (input.metadata !== undefined && Object.keys(input.metadata).length > 0) item.metadata = input.metadata
    await this.request('POST', this.config.bank, '/memories', {
      body: { items: [item] },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: this.config.retainTimeoutMs,
    })
  }

  /**
   * Delete a document and its derived memories.
   * @param id - document id.
   * @param options - caller signal.
   * @returns deleted memory-unit count (0 when absent or non-numeric).
   */
  async deleteDocument(id: string, options: CallOptions = {}): Promise<number> {
    const payload = await this.request('DELETE', this.config.bank, `/documents/${encodeURIComponent(id)}`, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: this.config.retainTimeoutMs,
    })
    return typeof payload?.memory_units_deleted === 'number' ? payload.memory_units_deleted : 0
  }

  /**
   * Bank statistics for `/memory stats`.
   * @param signal - caller cancellation.
   * @returns the raw stats payload.
   */
  async stats(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return await this.request('GET', this.config.bank, '/stats', { signal }) ?? {}
  }
}
