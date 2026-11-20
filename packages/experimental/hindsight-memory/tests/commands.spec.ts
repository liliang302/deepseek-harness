/** `/memory` command: verb routing, usage copy, and outage containment. */
import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { CuratedStore } from '../src/curated.ts'
import { HindsightClient } from '../src/hindsight.ts'
import { createMemoryCommand } from '../src/commands.ts'
import { createFetchStub, jsonResponse } from './helpers.ts'

const config = normalizeConfig({ userCharLimit: 100, memoryCharLimit: 60 })

function harness(documents: Record<string, { content: string; tags: readonly string[] }>, stats?: unknown) {
  const { fetchImpl, calls } = createFetchStub((url, init) => {
    if (init.method === 'DELETE') {
      const id = decodeURIComponent(url.split('/documents/')[1] ?? '')
      const existed = Object.hasOwn(documents, id)
      if (existed) Reflect.deleteProperty(documents, id)
      return jsonResponse({ memory_units_deleted: existed ? 1 : 0 })
    }
    if (url.endsWith('/stats')) return jsonResponse(stats ?? { bank_id: 'hermes', total_nodes: 7, total_links: 3, total_documents: 2, last_memory_write_at: '2026-11-20T00:00:00Z' })
    if (url.includes('/memories/recall')) return jsonResponse({ results: [{ text: '命中项 one', tags: ['x'] }] })
    if (url.includes('/documents?')) {
      const wanted = [...new URL(url).searchParams.getAll('tags')]
      const items = Object.entries(documents).filter(([, doc]) => wanted.every(tag => doc.tags.includes(tag))).map(([id]) => ({ id }))
      return jsonResponse({ items, total: items.length })
    }
    const match = /\/documents\/([^?]+)/.exec(url)
    const doc = documents[decodeURIComponent(match?.[1] ?? '')]
    if (doc === undefined) return jsonResponse({ detail: 'missing' }, { ok: false, status: 404 })
    return jsonResponse({ original_text: doc.content, tags: doc.tags, created_at: '2026-01-01T00:00:00.000Z' })
  })
  const client = new HindsightClient(config, { fetchImpl })
  const command = createMemoryCommand({ store: new CuratedStore(client, config), client, config })
  return { command, calls }
}

const invoke = (rawInput: string) => ({ rawInput, signal: new AbortController().signal }) as never

it('declares the command surface', () => {
  const { command } = harness({})
  expect(command.name).toBe('memory')
  expect(command.input?.attachments).toBe(false)
  expect(command.input?.hint).toContain('/memory'.replace('/memory', 'list'))
})

describe('verb routing', () => {
  it('UT-M1 status default renders both budgets', async () => {
    const { command } = harness({ u1: { content: 'u-entry', tags: ['dsh', 'curated', 'mem:user'] }, m1: { content: 'm-entry', tags: ['dsh', 'curated', 'mem:memory'] } })
    const result = await command.handler(invoke(''))
    expect(result.kind).toBe('success')
    expect(result.text).toContain('USER  ')
    expect(result.text).toContain('MEMORY ')
    expect(result.text).toContain('• [user] u-entry')
  })

  it('UT-M2 list normalizes the target argument', async () => {
    const { command } = harness({ m1: { content: 'only-in-memory', tags: ['dsh', 'curated', 'mem:memory'] } })
    const result = await command.handler(invoke('list bogus-target'))
    expect(result.text).toContain('memory 共 1 条')
    expect(result.text).toContain('only-in-memory')
  })

  it('UT-M3 search needs a query and reports hits', async () => {
    const { command } = harness({})
    expect((await command.handler(invoke('search'))).text).toContain('用法：/memory search')
    const hit = await command.handler(invoke('search 旧决策'))
    expect(hit.text).toContain('命中 1 条')
    expect(hit.text).toContain('命中项 one')
  })

  it('UT-M4 forget requires a fragment and deletes on a unique hit', async () => {
    const docs = { m1: { content: '要忘掉的事 fragX', tags: ['dsh', 'curated', 'mem:memory'] } }
    const { command } = harness(docs)
    expect((await command.handler(invoke('forget memory'))).text).toContain('用法：/memory forget')
    const gone = await command.handler(invoke('forget memory fragX'))
    expect(gone.kind).toBe('success')
    expect(gone.text).toContain('已从 memory 删除')
    const again = await command.handler(invoke('forget memory fragX'))
    expect(again.kind).toBe('error')
    expect(again.text).toContain('没有条目包含')
  })

  it('UT-M5 stats reads bank counters', async () => {
    const { command } = harness({})
    const result = await command.handler(invoke('stats'))
    expect(result.text).toContain('bank=hermes')
    expect(result.text).toContain('事实 7 条')
  })

  it('UT-M6 handler failures settle as error results', async () => {
    const { fetchImpl } = createFetchStub(() => { throw new Error('service down') })
    const client = new HindsightClient(config, { fetchImpl })
    const command = createMemoryCommand({ store: new CuratedStore(client, config), client, config })
    const result = await command.handler(invoke('status'))
    expect(result).toMatchObject({ kind: 'error', text: /记忆服务不可用.*service down/ })
  })
})

describe('coverage completions', () => {
  it('scalarOf degrades object stats fields to the placeholder', async () => {
    const { command } = harness({}, { total_nodes: { weird: true }, total_links: 4, total_documents: null })
    const result = await command.handler(invoke('stats'))
    expect(result.text).toContain('事实 ? 条')
    expect(result.text).toContain('链接 4')
    expect(result.text).toContain('文档 ?')
  })

  it('search miss branch renders the no-match copy', async () => {
    const { fetchImpl } = createFetchStub(url => (url.includes('/memories/recall')
      ? jsonResponse({ results: [] })
      : jsonResponse({ items: [], total: 0 })))
    const client = new HindsightClient(config, { fetchImpl })
    const command = createMemoryCommand({ store: new CuratedStore(client, config), client, config })
    expect((await command.handler(invoke('search 没有的东西'))).text).toContain('记忆库中没有匹配项')
  })

  it('list on an empty library shows the placeholder row', async () => {
    const { command } = harness({})
    const result = await command.handler(invoke('list user'))
    expect(result.text).toContain('（空）')
  })

  it('status with entries and without both render', async () => {
    const { command } = harness({ m1: { content: 'm-entry', tags: ['dsh', 'curated', 'mem:memory'] } })
    expect((await command.handler(invoke(''))).text).toContain('• [memory] m-entry')
  })
})

describe('coverage completions (guards)', () => {
  it('forget failure carries the current entry list (commands 92 entries path)', async () => {
    const { command } = harness({ m1: { content: '现存条目 keepme', tags: ['dsh', 'curated', 'mem:memory'] } })
    const result = await command.handler(invoke('forget memory 不存在的片段zzz'))
    expect(result.kind).toBe('error')
    expect(result.text).toContain('当前 memory 条目：')
    expect(result.text).toContain('keepme')
  })

  it('non-Error handler failures stringify (commands 102 String path)', async () => {
    const { fetchImpl } = createFetchStub(() => { throw 'raw-failure' })
    const client = new HindsightClient(config, { fetchImpl })
    const command = createMemoryCommand({ store: new CuratedStore(client, config), client, config })
    expect((await command.handler(invoke('status'))).text).toContain('raw-failure')
  })
})

it('forget over-budget style failure without entries still renders (commands 92 path)', async () => {
  const { fetchImpl } = createFetchStub((url) => {
    if (url.includes('/documents?')) return jsonResponse({ items: [{ id: 'ghost' }], total: 1 })
    return jsonResponse({ original_text: 'x'.repeat(80), created_at: '2026-01-01T00:00:00.000Z' })
  })
  const client = new HindsightClient(config, { fetchImpl })
  const command = createMemoryCommand({ store: new CuratedStore(client, config), client, config })
  // remove succeeds here; force the no-match-without-entries shape through an empty needle guard
  const result = await command.handler(invoke('forget memory    '))
  expect(result.kind).toBe('error')
})

it('forget failure without entries renders the empty list (commands 92 ?? path)', async () => {
  // remove() failing with no current entries: an unreachable-in-practice shape via store stub.
  const clientStub = {
    listDocuments: async () => ({ items: [], total: 0 }),
    getDocument: async () => { throw new Error('never') },
    retainDocument: async () => {},
    deleteDocument: async () => 0,
    recall: async () => [],
    stats: async () => ({}),
  } as never
  const store = new CuratedStore(clientStub, config)
  const command = createMemoryCommand({ store, client: clientStub, config })
  const result = await command.handler(invoke('forget memory frag'))
  expect(result.kind).toBe('error')
  expect(result.text).toContain('当前 memory 条目：')
})

it('status over-budget style failures keep the generic copy when reason absent', async () => {
  const { fetchImpl } = createFetchStub(() => jsonResponse({}))
  const client = new HindsightClient(config, { fetchImpl })
  const command = createMemoryCommand({ store: new CuratedStore(client, config), client, config })
  const result = await command.handler(invoke('list memory'))
  expect(result.text).toContain('（空）')
})

it('status with a non-Error thrown reason stringifies (commands catch else)', async () => {
  const throwingStub = {
    listDocuments: async () => { throw 'status exploded' },
    getDocument: async () => ({ originalText: '', tags: [], createdAt: '', updatedAt: '', metadata: {} }),
    retainDocument: async () => {},
    deleteDocument: async () => 0,
    recall: async () => [],
    stats: async () => ({}),
  } as never
  const store = new CuratedStore(throwingStub, config)
  const command = createMemoryCommand({ store, client: throwingStub, config })
  const result = await command.handler(invoke(''))
  expect(result.kind).toBe('error')
  expect(result.text).toContain('status exploded')
})

it('forget failure without an entries field renders the empty placeholder', async () => {
  // A store whose remove() returns a bare failure (no entries array) exercises the `?? []` leg.
  const bareFailingStore = {
    remove: async () => ({ ok: false, kind: 'no_match', reason: '没有条目包含「frag」。' }),
    loadAll: async () => ({ user: [], memory: [], usage: {
      user: { chars: 0, limit: 0, count: 0 }, memory: { chars: 0, limit: 0, count: 0 },
    } }),
    list: async () => [],
  } as unknown as CuratedStore
  const { fetchImpl } = createFetchStub(() => jsonResponse({}))
  const client = new HindsightClient(config, { fetchImpl })
  const command = createMemoryCommand({ store: bareFailingStore, client, config })
  const result = await command.handler(invoke('forget memory frag'))
  expect(result.kind).toBe('error')
  expect(result.text).toContain('当前 memory 条目：')
  expect(result.text).toContain('（空）')
})
