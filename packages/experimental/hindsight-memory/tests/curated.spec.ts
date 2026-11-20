/** Curated store: listing, budgets, write-before-delete replace, locating semantics. */
import { describe, expect, it, vi } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { CURATED_TAG, CuratedStore, findUniqueEntry, normalizeForMatch, normalizeTarget, targetTag } from '../src/curated.ts'
import { HindsightClient } from '../src/hindsight.ts'
import { createFetchStub, entry, jsonResponse, parseJsonBody } from './helpers.ts'

/** Parsed retain POST body of the Hindsight documents protocol. */
interface RetainItem { document_id: string; content: string; tags: string[]; context?: string; metadata?: Record<string, string> }

function parseRetainBody(body: BodyInit | null | undefined): { items: RetainItem[] } {
  return parseJsonBody(body) as { items: RetainItem[] }
}


const config = normalizeConfig({ userCharLimit: 100, memoryCharLimit: 60 })

/** Store wired to a fetch stub routing documents endpoints by tags query. */
function fixture(documents: Record<string, { content: string; tags: readonly string[]; created_at?: string }>) {
  const { fetchImpl, calls } = createFetchStub((url, init) => {
    if (init.method === 'POST') return jsonResponse({ status: 'ok' })
    if (url.includes('/documents?')) {
      const wanted = [...new URL(url).searchParams.getAll('tags')]
      const items = Object.entries(documents)
        .filter(([, doc]) => wanted.every(tag => doc.tags.includes(tag)))
        .map(([id, doc]) => ({ id, tags: doc.tags }))
      return jsonResponse({ items, total: items.length })
    }
    const match = /\/documents\/([^?]+)/.exec(url)
    const id = match?.[1] ?? ''
    const doc = documents[decodeURIComponent(id)]
    if (doc === undefined) return jsonResponse({ detail: 'missing' }, { ok: false, status: 404 })
    return jsonResponse({ original_text: doc.content, tags: doc.tags, created_at: doc.created_at ?? '2026-01-01T00:00:00.000Z' })
  })
  const client = new HindsightClient(config, { fetchImpl })
  return { store: new CuratedStore(client, config), calls }
}

describe('UT-S1/S10 list and loadAll', () => {
  it('sorts by createdAt then id, skips empty texts and failed reads', async () => {
    const { store } = fixture({
      b: { content: 'second', tags: ['dsh', 'curated', 'mem:memory'], created_at: '2026-01-02T00:00:00.000Z' },
      a: { content: 'first', tags: ['dsh', 'curated', 'mem:memory'], created_at: '2026-01-01T00:00:00.000Z' },
      e: { content: '   ', tags: ['dsh', 'curated', 'mem:memory'] },
    })
    const entries = await store.list('memory')
    expect(entries.map(item => item.id)).toEqual(['a', 'b'])
    expect(entries[0]?.chars).toBe(5)
    const loaded = await store.loadAll()
    expect(loaded.usage.memory).toEqual({ chars: 11, limit: 60, count: 2 })
    expect(loaded.usage.user.limit).toBe(100)
  })

  it('queries with all_strict over config.tags+curated+target tag', async () => {
    const { store, calls } = fixture({})
    await store.list('user')
    const url = new URL(String(calls[0]?.url))
    expect(url.searchParams.getAll('tags')).toEqual(['dsh', CURATED_TAG, 'mem:user'])
    expect(url.searchParams.get('tags_match')).toBe('all_strict')
    expect(url.searchParams.get('limit')).toBe(String(config.maxEntries))
  })
})

it('UT-S2 readDetails keeps in-flight GETs at or below 8', async () => {
  let inFlight = 0
  let peak = 0
  const docs: Record<string, { content: string; tags: readonly string[] }> = {}
  for (let index = 0; index < 17; index += 1) docs[`id${index}`] = { content: `entry ${index}`, tags: ['dsh', 'curated', 'mem:memory'] }
  const { fetchImpl } = createFetchStub(async (url) => {
    if (url.includes('/documents?')) return jsonResponse({ items: Object.keys(docs).map(id => ({ id })), total: 17 })
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise(resolve => setTimeout(resolve, 1))
    inFlight -= 1
    return jsonResponse({ original_text: 'x', created_at: '2026-01-01T00:00:00.000Z' })
  })
  const store = new CuratedStore(new HindsightClient(config, { fetchImpl }), config)
  await store.list('memory')
  expect(peak).toBeLessThanOrEqual(8)
  expect(peak).toBeGreaterThan(1)
})

describe('UT-S3..S5 add', () => {
  it('refuses secret text before any HTTP write', async () => {
    const { store, calls } = fixture({})
    const result = await store.add('user', 'password: hunter0secret')
    expect(result).toMatchObject({ ok: false, kind: 'secret' })
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(0)
  })

  it('over budget returns reason + entries + usage without writing', async () => {
    const { store, calls } = fixture({ m1: { content: 'x'.repeat(55), tags: ['dsh', 'curated', 'mem:memory'] } })
    const result = await store.add('memory', 'y'.repeat(10))
    expect(result).toMatchObject({ ok: false, kind: 'over_budget' })
    if (!result.ok && result.usage !== undefined) expect(result.usage.chars).toBe(65)
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(0)
  })

  it('writes document with curated tags, context and metadata', async () => {
    const { store, calls } = fixture({})
    const result = await store.add('user', ' 用户偏好中文 ')
    expect(result).toMatchObject({ ok: true, action: 'add' })
    const post = calls.find(call => call.init.method === 'POST')
    const body = parseRetainBody(typeof post?.init.body === 'string' ? post.init.body : undefined)
    expect(body.items[0]?.document_id).toMatch(/^dsh-mem-/)
    expect(body.items[0]?.content).toBe('用户偏好中文')
    expect(body.items[0]?.tags).toEqual(['dsh', CURATED_TAG, 'mem:user'])
    expect(body.items[0]?.context).toBe('curated memory (user)')
    expect(body.items[0]?.metadata).toEqual({ source: 'dsh-memory', target: 'user', schema: 'curated-v1' })
  })

  it('single-entry cap uses min(maxEntryChars, limit)', async () => {
    const tiny = normalizeConfig({ maxEntryChars: 5000, memoryCharLimit: 40 })
    const { fetchImpl } = createFetchStub(() => jsonResponse({ items: [], total: 0 }))
    const store = new CuratedStore(new HindsightClient(tiny, { fetchImpl }), tiny)
    const result = await store.add('memory', 'x'.repeat(45))
    expect(result).toMatchObject({ ok: false, kind: 'too_long' })
  })
})

describe('UT-S6..S8 replace', () => {
  it('locates exactly, writes the new document first, deletes after', async () => {
    const { store, calls } = fixture({
      old1: { content: 'NAS 地址是 192.168.2.253', tags: ['dsh', 'curated', 'mem:memory'] },
    })
    const result = await store.replace('memory', '192.168.2.253', 'NAS 地址已迁移到 10.0.0.5')
    expect(result).toMatchObject({ ok: true, action: 'replace' })
    // Sequence over mutating calls only: the new document is written before the old one is deleted.
    const mutations = calls.filter(call => call.init.method === 'POST' || call.init.method === 'DELETE')
      .map(call => `${call.init.method} ${call.url.slice(0, 80)}`)
    expect(mutations).toHaveLength(2)
    expect(mutations[0]).toMatch(/POST .*\/memories/)
    expect(mutations[1]).toMatch(/DELETE .*\/documents\/old1/)
  })

  it('a failed retain leaves the old document untouched', async () => {
    const { fetchImpl, calls } = createFetchStub((url, init) => {
      if (init.method === 'POST') return jsonResponse({ detail: 'boom' }, { ok: false, status: 500 })
      if (url.includes('/documents?')) return jsonResponse({ items: [{ id: 'old1' }], total: 1 })
      return jsonResponse({ original_text: '唯一片段 abc', created_at: '2026-01-01T00:00:00.000Z' })
    })
    const store = new CuratedStore(new HindsightClient(config, { fetchImpl }), config)
    await expect(store.replace('memory', 'abc', '新内容')).rejects.toThrow(/500/)
    expect(calls.some(call => call.init.method === 'DELETE')).toBe(false)
  })

  it('ambiguous fragment lists candidates and writes nothing', async () => {
    const { store, calls } = fixture({
      d1: { content: '关键词 alpha 出现一次', tags: ['dsh', 'curated', 'mem:memory'] },
      d2: { content: '关键词 alpha 又出现', tags: ['dsh', 'curated', 'mem:memory'] },
    })
    const result = await store.replace('memory', 'alpha', 'beta')
    expect(result).toMatchObject({ ok: false, kind: 'no_match' })
    if (!result.ok) expect(result.reason).toContain('匹配到 2 条')
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(0)
  })

  it('folded matching finds curly-quote variants of the same fact', async () => {
    const { store } = fixture({ d1: { content: '他用“引号”—记', tags: ['dsh', 'curated', 'mem:memory'] } })
    const result = await store.replace('memory', '他用"引号"-记', '压缩后的整条')
    expect(result).toMatchObject({ ok: true })
  })

  it('budget math subtracts the old entry', async () => {
    // Fresh fixture per attempt: replace swaps the document id, so the second
    // call must locate the *current* entry (marker `old`), not the consumed one.
    const first = fixture({ d1: { content: `${'x'.repeat(50)}|old`, tags: ['dsh', 'curated', 'mem:memory'] } })
    const ok = await first.store.replace('memory', '|old', `${'y'.repeat(55)}|old`)
    expect(ok).toMatchObject({ ok: true })
    // Old entry 54 chars; new text 59: under the single-entry cap (min(maxEntryChars, limit)=60)
    // but the library holds two entries totalling 74, so the projected total 59+20=79 breaches the 60 budget.
    const second = fixture({
      d1: { content: `${'x'.repeat(50)}|old`, tags: ['dsh', 'curated', 'mem:memory'] },
      d2: { content: 'y'.repeat(20), tags: ['dsh', 'curated', 'mem:memory'] },
    })
    const fail = await second.store.replace('memory', '|old', 'z'.repeat(59))
    expect(fail).toMatchObject({ ok: false, kind: 'over_budget' })
  })
})

it('UT-S9 remove reports deleted units and no-match candidates', async () => {
  const { store } = fixture({ d1: { content: '要删除的条目 uniqfrag', tags: ['dsh', 'curated', 'mem:memory'] } })
  const removed = await store.remove('memory', 'uniqfrag')
  expect(removed).toMatchObject({ ok: true, action: 'remove' })
  const missing = await store.remove('memory', '不存在xyz')
  expect(missing).toMatchObject({ ok: false, kind: 'no_match' })
})

describe('locating helpers', () => {
  it('normalizeTarget falls back to memory', () => {
    expect(normalizeTarget('user')).toBe('user')
    expect(normalizeTarget(undefined)).toBe('memory')
    expect(normalizeTarget('bogus')).toBe('memory')
  })

  it('targetTag maps both libraries', () => {
    expect(targetTag('user')).toBe('mem:user')
    expect(targetTag('memory')).toBe('mem:memory')
  })

  it('findUniqueEntry guards empty needles and folded whitespace', () => {
    expect(findUniqueEntry([], 'x')).toMatchObject({ reason: /没有条目包含/ })
    expect(findUniqueEntry([entry('a', 'x')], '  ')).toMatchObject({ reason: /old_text 不能为空/ })
    expect(normalizeForMatch('用  \n “引” —字')).toBe(normalizeForMatch('用 "引" -字'))
  })
})

void describe.skip
void vi

describe('coverage completions', () => {
  it('replace refuses unsafe new content before locating (curated 253)', async () => {
    const { store, calls } = fixture({ d1: { content: 'frag 唯一', tags: ['dsh', 'curated', 'mem:memory'] } })
    const result = await store.replace('memory', 'frag', 'password: hunter0secret')
    expect(result).toMatchObject({ ok: false, kind: 'secret' })
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(0)
  })

  it('replace refuses over-long content after locating (curated 262)', async () => {
    const { store } = fixture({ d1: { content: 'frag 唯一', tags: ['dsh', 'curated', 'mem:memory'] } })
    const result = await store.replace('memory', 'frag', 'x'.repeat(61))
    expect(result).toMatchObject({ ok: false, kind: 'too_long' })
  })

  it('folded-only ambiguity reports candidates (curated 89 folded path)', async () => {
    const docs = {
      d1: { content: '他用“引号”甲记', tags: ['dsh', 'curated', 'mem:memory'] },
      d2: { content: '他用“引号”乙记', tags: ['dsh', 'curated', 'mem:memory'] },
    }
    const { store } = fixture(docs)
    const result = await store.remove('memory', '他用"引号"')
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('匹配到 2 条')
  })

  it('skip entries whose detail read failed mid-list (curated 124 undefined id guard)', async () => {
    // ids list contains a null-ish id via duplicate race: emulate by returning an item without id.
    const { fetchImpl } = createFetchStub((url, init) => {
      if (init.method === 'POST') return jsonResponse({ status: 'ok' })
      if (url.includes('/documents?')) return jsonResponse({ items: [{ id: 'good' }, {} as never], total: 2 })
      return jsonResponse({ original_text: '内容 good', created_at: '2026-01-01T00:00:00.000Z' })
    })
    const store = new CuratedStore(new HindsightClient(config, { fetchImpl }), config)
    const entries = await store.list('memory')
    expect(entries.map(entry => entry.id)).toEqual(['good'])
  })
})

describe('coverage completions (round 2)', () => {
  it('replace rewrites the matched entry inside the returned list (curated 283 true path)', async () => {
    const docs = {
      keep: { content: '不动的条目 keepfrag', tags: ['dsh', 'curated', 'mem:memory'] },
      hit: { content: '要替换的条目 hitfrag', tags: ['dsh', 'curated', 'mem:memory'] },
    }
    const { store } = fixture(docs)
    const result = await store.replace('memory', 'hitfrag', '替换后的新内容 hitfrag')
    expect(result.ok).toBe(true)
    if (result.ok && result.action === 'replace') {
      expect(result.entries.map(entry => entry.content)).toContain('不动的条目 keepfrag')
      expect(result.entries.map(entry => entry.content)).toContain('替换后的新内容 hitfrag')
    }
  })

  it('list drops items whose id disappears between pages (curated 124 undefined guard)', async () => {
    // ids array is built from items; a race-free way to reach the guard is an item with empty-string id.
    const { fetchImpl } = createFetchStub((url, init) => {
      if (init.method === 'POST') return jsonResponse({ status: 'ok' })
      if (url.includes('/documents?')) return jsonResponse({ items: [{ id: '' }, { id: null }, { id: 'good' }], total: 3 })
      return jsonResponse({ original_text: '内容 good', created_at: '2026-01-01T00:00:00.000Z' })
    })
    const store = new CuratedStore(new HindsightClient(config, { fetchImpl }), config)
    const entries = await store.list('memory')
    expect(entries.map(entry => entry.id)).toEqual(['good'])
  })
})
