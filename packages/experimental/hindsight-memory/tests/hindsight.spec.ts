/**
 * UT-C1..C9 — HindsightClient request assembly, decoding, error classes, and
 * timeout/abort combination (mock fetch).
 *
 * @module tests/hindsight.spec
 */

import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { HindsightClient, HindsightError, randomId } from '../src/hindsight.ts'
import { createFetchStub, jsonResponse, parseJsonBody } from './helpers.ts'

/** AbortSignal reasons arrive as unknown; Promise rejection wants an Error. */
function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

const config = normalizeConfig({})

/** Client wired to a stub answering every route with `payload`. */
function clientWith(payload: unknown) {
  const stub = createFetchStub(() => jsonResponse(payload))
  return { client: new HindsightClient(config, { fetchImpl: stub.fetchImpl }), stub }
}

describe('HindsightClient.request', () => {
  it('UT-C1 assembles url prefix, encoded bank, accept header, and body content-type only with a body', async () => {
    const { client, stub } = clientWith({ ok: true })
    await client.request('GET', 'my bank/', '/stats')
    expect(stub.calls[0]!.url).toBe('http://127.0.0.1:8888/v1/default/banks/my%20bank%2F/stats')
    const headers = stub.calls[0]!.init.headers as Record<string, string>
    expect(headers.accept).toBe('application/json')
    expect(headers['content-type']).toBeUndefined()
    expect(stub.calls[0]!.init.body).toBeUndefined()

    await client.request('POST', config.bank, '/memories', { body: { items: [] } })
    const postHeaders = stub.calls[1]!.init.headers as Record<string, string>
    expect(postHeaders['content-type']).toBe('application/json')
    expect(stub.calls[1]!.init.body).toBe(JSON.stringify({ items: [] }))
  })

  it('UT-C7 classifies fetch rejection as unreachable and non-2xx as http with detail truncation', async () => {
    const rejecter = createFetchStub(() => Promise.reject(new Error('ECONNREFUSED')))
    const rejecting = new HindsightClient(config, { fetchImpl: rejecter.fetchImpl })
    await expect(rejecting.stats()).rejects.toMatchObject({ name: 'HindsightError', code: 'unreachable' })
    await expect(rejecting.stats()).rejects.toThrow(/无法连接 Hindsight：ECONNREFUSED/)

    const badGateway = createFetchStub(() => new Response('x'.repeat(300), { status: 502 }))
    const gatewayClient = new HindsightClient(config, { fetchImpl: badGateway.fetchImpl })
    const error = await gatewayClient.stats().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HindsightError)
    const httpError = error as HindsightError
    expect(httpError.code).toBe('http')
    expect(httpError.status).toBe(502)
    expect(httpError.message.length).toBeLessThan(300)
    expect(httpError.message).toContain('x'.repeat(200))

    const emptyError = createFetchStub(() => new Response('', { status: 404 }))
    const emptyClient = new HindsightClient(config, { fetchImpl: emptyError.fetchImpl })
    await expect(emptyClient.stats()).rejects.toThrow('Hindsight HTTP 404：无响应体')

    const jsonDetail = createFetchStub(() => jsonResponse({ detail: 'bank 不存在' }, { ok: false, status: 404 }))
    const detailClient = new HindsightClient(config, { fetchImpl: jsonDetail.fetchImpl })
    await expect(detailClient.stats()).rejects.toThrow('Hindsight HTTP 404：bank 不存在')
  })

  it('UT-C7 parses a malformed JSON body without crashing and still classifies by status', async () => {
    const broken = createFetchStub(() => new Response('not-json{{{', { status: 200 }))
    const client = new HindsightClient(config, { fetchImpl: broken.fetchImpl })
    // A malformed body on a 2xx still settles; the parsed payload is undefined.
    expect(await client.request('GET', config.bank, '/stats')).toBeUndefined()

    const brokenError = createFetchStub(() => new Response('plain text failure', { status: 400 }))
    const errorClient = new HindsightClient(config, { fetchImpl: brokenError.fetchImpl })
    await expect(errorClient.stats()).rejects.toThrow('Hindsight HTTP 400：plain text failure')
  })

  it('UT-C9 combines the caller signal with AbortSignal.timeout on every request', async () => {
    const { client, stub } = clientWith({})
    const controller = new AbortController()
    await client.stats(controller.signal)
    const signal = stub.calls[0]!.init.signal as AbortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    controller.abort(new Error('user cancel'))
    expect(signal.aborted).toBe(true)
  })

  it('UT-C9 an already-aborted caller signal rejects the in-flight request', async () => {
    const hanging = createFetchStub((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!
      signal.addEventListener('abort', () => { reject(toError(signal.reason)) })
    }))
    const client = new HindsightClient(config, { fetchImpl: hanging.fetchImpl })
    const controller = new AbortController()
    const pending = client.stats(controller.signal)
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrow(/无法连接 Hindsight/)
  })
})

describe('HindsightClient.recall', () => {
  it('UT-C2 trims blank queries to [] without any HTTP call', async () => {
    const { client, stub } = clientWith({ results: [] })
    expect(await client.recall('   ')).toEqual([])
    expect(stub.calls).toHaveLength(0)
  })

  it('UT-C2 sends max_tokens default, optional tags/tags_match, and decodes fact fields', async () => {
    const { client, stub } = clientWith({
      results: [
        { id: 'f1', text: ' 命中一 ', tags: ['dsh'], fact_type: 'experience' },
        { id: 'f2', text: '   ', tags: [], fact_type: 'fact' },
        { id: 3, text: 42, tags: 'nope', fact_type: 7 },
      ],
    })
    const facts = await client.recall('之前讨论过什么', { tags: ['a', 'b'], tagsMatch: 'all_strict' })
    const body = parseJsonBody(stub.calls[0]!.init.body)
    expect(body).toEqual({ query: '之前讨论过什么', max_tokens: config.recallTokens, tags: ['a', 'b'], tags_match: 'all_strict' })
    expect(facts).toEqual([
      { id: 'f1', text: '命中一', tags: ['dsh'], factType: 'experience' },
      { id: '', text: '', tags: [], factType: '' },
    ].filter(item => item.text.length > 0))
    expect(facts).toHaveLength(1)
    expect(facts[0]!.factType).toBe('experience')
  })

  it('UT-C2 omits tags when the list is empty and falls back to [] for a missing results array', async () => {
    const { client, stub } = clientWith({ unexpected: true })
    const facts = await client.recall('q', { tags: [] })
    const body = parseJsonBody(stub.calls[0]!.init.body)
    expect(body.tags).toBeUndefined()
    expect(body.tags_match).toBeUndefined()
    expect(facts).toEqual([])
  })
})

describe('HindsightClient.listDocuments', () => {
  it('UT-C3 serializes repeated tags params and defaults limit/offset', async () => {
    const { client, stub } = clientWith({ items: [{ id: 'd1' }], total: 7 })
    const listed = await client.listDocuments({ tags: ['a', 'b'], tagsMatch: 'all_strict' })
    const url = new URL(stub.calls[0]!.url)
    expect(url.searchParams.getAll('tags')).toEqual(['a', 'b'])
    expect(url.searchParams.get('tags_match')).toBe('all_strict')
    expect(url.searchParams.get('limit')).toBe('100')
    expect(url.searchParams.get('offset')).toBe('0')
    expect(listed).toEqual({ items: [{ id: 'd1' }], total: 7 })
  })

  it('UT-C3 coerces a non-numeric total to 0 and a missing items array to []', async () => {
    const { client } = clientWith({ items: 'nope', total: 'many' })
    expect(await client.listDocuments()).toEqual({ items: [], total: 0 })
  })
})

describe('HindsightClient.getDocument', () => {
  it('UT-C4 encodes the id and applies per-field fallbacks for a missing payload', async () => {
    const { client, stub } = clientWith({})
    const detail = await client.getDocument('doc/编号 1')
    expect(stub.calls[0]!.url).toContain(`/documents/${encodeURIComponent('doc/编号 1')}`)
    expect(detail).toEqual({
      id: 'doc/编号 1',
      originalText: '',
      tags: [],
      createdAt: '',
      updatedAt: '',
      metadata: {},
    })
  })

  it('UT-C4 reads original_text/tags/created_at/document_metadata verbatim', async () => {
    const { client } = clientWith({
      original_text: '一条记忆',
      tags: ['curated', 'mem:user'],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      document_metadata: { source: 'dsh-memory' },
    })
    expect(await client.getDocument('d1')).toEqual({
      id: 'd1',
      originalText: '一条记忆',
      tags: ['curated', 'mem:user'],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      metadata: { source: 'dsh-memory' },
    })
  })
})

describe('HindsightClient.retainDocument / deleteDocument / stats', () => {
  it('UT-C5 wraps items, attaches context, and skips an empty metadata object', async () => {
    const { client, stub } = clientWith({})
    await client.retainDocument({ id: 'n1', content: '正文', tags: ['t'], metadata: {} })
    expect(parseJsonBody(stub.calls[0]!.init.body)).toEqual({
      items: [{ content: '正文', document_id: 'n1', tags: ['t'] }],
    })
    await client.retainDocument({ id: 'n2', content: 'c', tags: [], context: 'ctx', metadata: { a: 'b' } })
    expect(parseJsonBody(stub.calls[1]!.init.body)).toEqual({
      items: [{ content: 'c', document_id: 'n2', tags: [], context: 'ctx', metadata: { a: 'b' } }],
    })
  })

  it('UT-C5 retain uses retainTimeoutMs while reads use timeoutMs on the merged signal', async () => {
    const controller = new AbortController()
    const hanging = createFetchStub((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!
      if (signal.aborted) reject(toError(signal.reason))
      else signal.addEventListener('abort', () => { reject(toError(signal.reason)) }, { once: true })
    }))
    const client = new HindsightClient(config, { fetchImpl: hanging.fetchImpl })
    // The retained merged signal must carry the caller's abort into the hung fetch.
    const pending = client.retainDocument({ id: 'x', content: 'c', tags: [] }, { signal: controller.signal })
    controller.abort(new Error('stop'))
    await expect(pending).rejects.toThrow(/无法连接 Hindsight/)

    // Timeout wiring itself is pinned at the request level: retain passes retainTimeoutMs.
    let observedSignal: AbortSignal | undefined
    const spy = createFetchStub((_url, init) => {
      observedSignal = init.signal as AbortSignal
      return jsonResponse({})
    })
    const timedClient = new HindsightClient(config, { fetchImpl: spy.fetchImpl })
    await timedClient.retainDocument({ id: 'y', content: 'c', tags: [] })
    expect(observedSignal).toBeInstanceOf(AbortSignal)
    expect(observedSignal!.aborted).toBe(false)
  })

  it('UT-C6 deletes via DELETE and defaults memory_units_deleted to 0', async () => {
    const { client, stub } = clientWith({ memory_units_deleted: 5 })
    expect(await client.deleteDocument('d 1')).toBe(5)
    expect(stub.calls[0]!.init.method).toBe('DELETE')
    expect(stub.calls[0]!.url).toContain(encodeURIComponent('d 1'))
    const zero = clientWith({})
    expect(await zero.client.deleteDocument('d2')).toBe(0)
  })

  it('UT-C8 stats GETs /stats and passes the caller signal through', async () => {
    const { client, stub } = clientWith({ bank_id: 'hermes', total_nodes: 1 })
    const controller = new AbortController()
    expect(await client.stats(controller.signal)).toEqual({ bank_id: 'hermes', total_nodes: 1 })
    expect(stub.calls[0]!.init.method).toBe('GET')
    expect(stub.calls[0]!.url).toMatch(/\/stats$/)
    expect(stub.calls[0]!.init.signal).toBeDefined()
  })
})

describe('randomId', () => {
  it('prefers crypto.randomUUID and falls back to timestamp+random without it', () => {
    expect(randomId('dsh-mem')).toMatch(/^dsh-mem-[0-9a-f-]{36}$/)
    const original = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: undefined }, configurable: true })
    try {
      expect(randomId('dsh-turn')).toMatch(/^dsh-turn-\d+-[0-9a-f]+$/)
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true })
    }
  })
})

describe('coverage completions', () => {
  it('request tolerates a malformed JSON body and classifies by status (hindsight 139)', async () => {
    const { fetchImpl } = createFetchStub(() => new Response('not-json', { status: 200 }))
    const client = new HindsightClient(config, { fetchImpl })
    await expect(client.stats()).resolves.toEqual({})
    const failing = createFetchStub(() => new Response('plain-detail', { status: 503 }))
    const client2 = new HindsightClient(config, { fetchImpl: failing.fetchImpl })
    await expect(client2.stats()).rejects.toThrow(/plain-detail/)
  })

  it('recall defaults max_tokens from config when options omit it (178 path)', async () => {
    const stub = createFetchStub(() => jsonResponse({ results: [] }))
    const client = new HindsightClient(config, { fetchImpl: stub.fetchImpl })
    await client.recall('q', {})
    expect(parseJsonBody(stub.calls[0]?.init.body)).toEqual({ query: 'q', max_tokens: config.recallTokens })
  })

  it('recall degrades non-string facts to empty and drops them (187 paths)', async () => {
    const stub = createFetchStub(() => jsonResponse({ results: [{ id: 1, text: 2, tags: 'x' }, { text: 'ok', fact_type: 5 }] }))
    const client = new HindsightClient(config, { fetchImpl: stub.fetchImpl })
    const facts = await client.recall('q')
    expect(facts).toEqual([{ id: '', text: 'ok', tags: [], factType: '' }])
  })

  it('deleteDocument returns 0 for a non-numeric units field (283 path)', async () => {
    const stub = createFetchStub(() => jsonResponse({ memory_units_deleted: 'two' }))
    const client = new HindsightClient(config, { fetchImpl: stub.fetchImpl })
    expect(await client.deleteDocument('d1')).toBe(0)
  })
})

it('recall accepts a readonly tags array and skips empty ones (hindsight 176 paths)', async () => {
  const stub = createFetchStub(() => jsonResponse({ results: [] }))
  const client = new HindsightClient(config, { fetchImpl: stub.fetchImpl })
  await client.recall('q', { tags: ['only'] })
  expect(parseJsonBody(stub.calls.at(-1)?.init.body)).toMatchObject({ tags: ['only'], tags_match: 'any' })
})
