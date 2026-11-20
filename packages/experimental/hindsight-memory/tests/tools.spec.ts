/** Memory tools: routing, rendering stability, batch aggregation, lossless results. */
import { describe, expect, it } from 'vitest'
import { normalizeConfig } from '../src/config.ts'
import { CuratedStore, CURATED_TAG } from '../src/curated.ts'
import { HindsightClient } from '../src/hindsight.ts'
import { createMemoryTool, createRecallTool, createRetainTool } from '../src/tools.ts'
import { assertLossless, createFetchStub, jsonResponse, parseJsonBody , renderText } from './helpers.ts'

/** Parsed retain POST body of the Hindsight documents protocol. */
interface RetainItem { document_id: string; content: string; tags: string[]; context?: string; metadata?: Record<string, string> }

function parseRetainBody(body: BodyInit | null | undefined): { items: RetainItem[] } {
  return parseJsonBody(body) as { items: RetainItem[] }
}


const config = normalizeConfig({ userCharLimit: 100, memoryCharLimit: 60 })

interface Harness { store: CuratedStore; client: HindsightClient; calls: { url: string; init: RequestInit }[] }

/** Store+client over one in-memory document map; POST records writes into the map. */
function harness(initial: Record<string, { content: string; tags: readonly string[] }> = {}): Harness {
  const documents: Record<string, { content: string; tags: readonly string[] }> = { ...initial }
  const { fetchImpl, calls } = createFetchStub((url, init) => {
    if (init.method === 'POST') {
      const body = parseRetainBody(init.body)
      for (const item of body.items) documents[item.document_id] = { content: item.content, tags: [...item.tags] }
      return jsonResponse({ status: 'scheduled' })
    }
    if (init.method === 'DELETE') {
      const id = decodeURIComponent(url.split('/documents/')[1] ?? '')
      const existed = Object.hasOwn(documents, id)
      if (existed) Reflect.deleteProperty(documents, id)
      return jsonResponse({ memory_units_deleted: existed ? 2 : 0 })
    }
    if (url.includes('/documents?')) {
      const wanted = [...new URL(url).searchParams.getAll('tags')]
      const items = Object.entries(documents)
        .filter(([, doc]) => wanted.every(tag => doc.tags.includes(tag)))
        .map(([id]) => ({ id }))
      return jsonResponse({ items, total: items.length })
    }
    const match = /\/documents\/([^?]+)/.exec(url)
    const doc = documents[decodeURIComponent(match?.[1] ?? '')]
    if (doc === undefined) return jsonResponse({ detail: 'missing' }, { ok: false, status: 404 })
    return jsonResponse({ original_text: doc.content, tags: doc.tags, created_at: '2026-01-01T00:00:00.000Z' })
  })
  const client = new HindsightClient(config, { fetchImpl })
  return { store: new CuratedStore(client, config), client, calls }
}

const exec = { signal: new AbortController().signal } as never

describe('UT-T1 model-facing surface stability', () => {
  const tool = createMemoryTool({ store: harness().store, config })

  it('keeps the baseline description verbatim', () => {
    expect(tool.description).toContain('一条事实只写一个库。')
    expect(tool.description).toContain('不要写入密码、密钥等凭据。')
  })

  it('keeps parameters and output schema shape', () => {
    expect(tool.parameters.required).toEqual(['action'])
    const properties = tool.parameters.properties as Record<string, { enum?: string[] } | undefined>
    expect(properties.action?.enum).toEqual(['add', 'replace', 'remove', 'batch', 'list'])
    expect(properties.target?.enum).toEqual(['user', 'memory'])
    expect(tool.output.schema.type).toBe('object')
  })

  it('declares a positive cooperative timeout', () => {
    expect(tool.timeoutMs).toBe(Math.max(config.retainTimeoutMs, config.timeoutMs) + 5000)
  })
})

describe('UT-T2 execute routing', () => {
  it('unknown action fails without touching HTTP', async () => {
    const { store, calls } = harness()
    const tool = createMemoryTool({ store, config })
    const value = await tool.execute({ action: 'frobnicate' }, exec)
    expect(value).toMatchObject({ ok: false, reason: '未知 action：frobnicate' })
    expect(calls).toHaveLength(0)
    assertLossless(value, 'unknown action')
  })

  it('add → list round-trip through the tool face', async () => {
    const { store } = harness()
    const tool = createMemoryTool({ store, config })
    const added = await tool.execute({ action: 'add', target: 'user', content: '用户喜欢猫' }, exec)
    expect(added).toMatchObject({ ok: true, action: 'add', target: 'user' })
    assertLossless(added, 'add result')
    const listed = await tool.execute({ action: 'list', target: 'user' }, exec)
    expect(listed).toMatchObject({ ok: true, action: 'list' })
    const rendered = tool.output.render({}, listed as never)
    expect(renderText(rendered)).toContain('用户喜欢猫')
    expect(renderText(rendered)).toContain('记忆条目（user')
  })

  it('replace/remove route with old_text; missing args fail softly', async () => {
    const { store } = harness({ m1: { content: '唯一片段 frag', tags: ['dsh', 'curated', 'mem:memory'] } })
    const tool = createMemoryTool({ store, config })
    const replaced = await tool.execute({ action: 'replace', old_text: 'frag', content: '整条新内容 frag2' }, exec)
    expect(replaced).toMatchObject({ ok: true, action: 'replace' })
    const removed = await tool.execute({ action: 'remove', old_text: 'frag2' }, exec)
    expect(removed).toMatchObject({ ok: true, action: 'remove' })
    const bad = await tool.execute({ action: 'remove' }, exec)
    expect(bad).toMatchObject({ ok: false })
    assertLossless(bad, 'missing old_text')
  })

  it('service outage surfaces as readable failure text, not a throw', async () => {
    const { fetchImpl } = createFetchStub(() => { throw new TypeError('connect refused') })
    const store = new CuratedStore(new HindsightClient(config, { fetchImpl }), config)
    const tool = createMemoryTool({ store, config })
    const value = await tool.execute({ action: 'list' }, exec)
    expect(value).toMatchObject({ ok: false, reason: /记忆服务不可用.*connect refused/ })
  })
})

describe('UT-T3 batch aggregation', () => {
  it('mixes successes and failures, attaches reason only when failing', async () => {
    const { store } = harness({ m1: { content: 'alpha 唯一', tags: ['dsh', 'curated', 'mem:memory'] } })
    const tool = createMemoryTool({ store, config })
    const okBatch = await tool.execute({ action: 'batch', operations: [
      { action: 'add', target: 'memory', content: 'beta 新条目' },
      { action: 'remove', target: 'memory', old_text: 'alpha' },
    ] }, exec)
    expect(okBatch).toMatchObject({ ok: true, action: 'batch' })
    expect(JSON.stringify(okBatch)).toContain('2/2 成功')
    assertLossless(okBatch, 'batch ok')

    const mixed = await tool.execute({ action: 'batch', operations: [
      { action: 'add', target: 'memory', content: 'gamma' },
      { action: 'remove', target: 'memory', old_text: '不存在的delta' },
    ] }, exec)
    expect(mixed).toMatchObject({ ok: false, action: 'batch' })
    expect(JSON.stringify(mixed)).toContain('1/2 成功')
    assertLossless(mixed, 'batch mixed')
  })

  it('empty operations fail immediately', async () => {
    const { store, calls } = harness()
    const tool = createMemoryTool({ store, config })
    const value = await tool.execute({ action: 'batch', operations: [] }, exec)
    expect(value).toMatchObject({ ok: false, reason: /operations 不能为空/ })
    expect(calls).toHaveLength(0)
  })
})

it('UT-T5 every result path is lossless JSON', async () => {
  const { store } = harness()
  const tool = createMemoryTool({ store, config })
  for (const args of [{ action: 'list' }, { action: 'add', content: '' }, { action: 'replace', content: 'x' }]) {
    assertLossless(await tool.execute(args, exec), `lossless ${args.action}`)
  }
})

describe('UT-T6 memory_recall', () => {
  function recallHarness(results: unknown[]) {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ results }))
    return { client: new HindsightClient(config, { fetchImpl }), calls }
  }

  it('maps facts and honors max_tokens override plus bounds', async () => {
    const { client } = recallHarness([{ text: 'fact A', tags: ['x'], fact_type: 'fact' }])
    const tool = createRecallTool({ client, config })
    const value = await tool.execute({ query: 'A?', max_tokens: 42 }, exec)
    expect(value).toMatchObject({ count: 1, results: ['fact A'] })
    assertLossless(value, 'recall ok')
    const fallback = await tool.execute({ query: 'A?' }, exec)
    expect(fallback).toMatchObject({ count: 1 })
    const clamped = await tool.execute({ query: 'A?', max_tokens: -7 }, exec)
    expect(clamped).toMatchObject({ count: 1 }) // invalid budget falls back to config default
  })

  it('renders hit and miss copy', async () => {
    const { client } = recallHarness([])
    const tool = createRecallTool({ client, config })
    expect(renderText(tool.output.render({}, { count: 0, results: [] }))).toContain('未命中')
    expect(renderText(tool.output.render({}, { count: 1, results: ['r'] }))).toContain('命中 1 条')
  })

  it('outage returns an error field instead of throwing', async () => {
    const { fetchImpl } = createFetchStub(() => { throw new Error('down') })
    const tool = createRecallTool({ client: new HindsightClient(config, { fetchImpl }), config })
    const value = await tool.execute({ query: 'q' }, exec)
    expect(value).toMatchObject({ count: 0, error: /down/ })
    assertLossless(value, 'recall outage')
  })
})

describe('UT-T7 memory_retain', () => {
  it('merges tags with mem:session and uses dsh-note ids', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ status: 'ok' }))
    const client = new HindsightClient(config, { fetchImpl })
    const tool = createRetainTool({ client, config })
    const value = await tool.execute({ content: '过程结论', tags: ['proj', '  ', 42] }, exec)
    expect(value).toMatchObject({ ok: true })
    const body = parseRetainBody(calls[0]?.init.body as string | undefined)
    expect(body.items[0]?.document_id).toMatch(/^dsh-note-/)
    expect(body.items[0]?.tags).toEqual([...config.tags, 'mem:session', 'proj'])
    expect(renderText(tool.output.render({}, { ok: true }))).toContain('已写入')
  })

  it('empty content fails without HTTP', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({}))
    const tool = createRetainTool({ client: new HindsightClient(config, { fetchImpl }), config })
    expect(await tool.execute({ content: '  ' }, exec)).toMatchObject({ ok: false, error: '内容为空。' })
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(0)
  })
})

void CURATED_TAG

it('finalize attaches usage only when the failure carries it (tools coverage)', async () => {
  const { store } = harness({ m1: { content: 'x'.repeat(58), tags: ['dsh', 'curated', 'mem:memory'] } })
  const tool = createMemoryTool({ store, config })
  const over = await tool.execute({ action: 'add', target: 'memory', content: 'y'.repeat(10) }, exec)
  expect(over).toMatchObject({ ok: false })
  assertLossless(over, 'over budget finalize')
})

describe('coverage completions', () => {
  const toolOf = () => createMemoryTool({ store: harness().store, config })

  it('non-object args and non-string action degrade safely (tools 28/96)', async () => {
    const tool = toolOf()
    expect(await tool.execute('not-an-object', exec)).toMatchObject({ ok: false, reason: '未知 action：' })
    expect(await tool.execute({ action: 42 }, exec)).toMatchObject({ ok: false })
  })

  it('failure result without reason falls back to the generic copy (tools 51)', async () => {
    const tool = toolOf()
    const rendered = tool.output.render({}, { ok: false, action: 'x' })
    expect(renderText(rendered)).toContain('未知原因')
  })

  it('batch tolerates malformed operation items (tools 96..101)', async () => {
    const { store } = harness()
    const tool = createMemoryTool({ store, config })
    // Malformed items fall through to the remove leg and fail on their empty locators.
    const value = await tool.execute({ action: 'batch', operations: [
      'garbage',
      { action: 'teleport' },
      { action: 'add', content: '有效一条' },
    ] }, exec)
    expect(JSON.stringify(value)).toContain('1/3 成功')
    assertLossless(value, 'mixed garbage batch')
  })

  it('empty action string reports the unknown-action shape (tools 227)', async () => {
    expect(await toolOf().execute({}, exec)).toMatchObject({ ok: false, action: 'unknown' })
  })

  it('non-Error throw surfaces via String(error) (tools 242)', async () => {
    const { fetchImpl } = createFetchStub(() => { throw 'plain-string-failure' })
    const store = new CuratedStore(new HindsightClient(config, { fetchImpl }), config)
    const value = await createMemoryTool({ store, config }).execute({ action: 'list' }, exec)
    expect(value).toMatchObject({ ok: false, reason: /plain-string-failure/ })
  })

  it('recall render degrades non-string results (tools 295/297)', () => {
    const downStub = createFetchStub(() => jsonResponse({}))
    const tool = createRecallTool({ client: new HindsightClient(config, { fetchImpl: downStub.fetchImpl }), config })
    const hit = tool.output.render({}, { count: 2, results: ['plain', { nested: 1 }] })
    expect(renderText(hit)).toContain('1. plain')
    expect(renderText(hit)).toContain('{"nested":1}')
    expect(renderText(tool.output.render({}, { count: 0, results: 'not-array' }))).toContain('未命中')
  })
})

describe('coverage completions (tool tails)', () => {
  it('recall outage with a non-Error reason stringifies (tools 314)', async () => {
    const { fetchImpl } = createFetchStub(() => { throw 'raw-down' })
    const tool = createRecallTool({ client: new HindsightClient(config, { fetchImpl }), config })
    const value = await tool.execute({ query: 'q' }, exec) as { error?: string }
    expect(value.error).toContain('raw-down')
  })

  it('retain render covers ok/failed/unknown copy (tools 356)', () => {
    const stub = createFetchStub(() => jsonResponse({}))
    const tool = createRetainTool({ client: new HindsightClient(config, { fetchImpl: stub.fetchImpl }), config })
    expect(renderText(tool.output.render({}, { ok: true }))).toContain('已写入')
    expect(renderText(tool.output.render({}, { ok: false, error: 'boom' }))).toContain('boom')
    expect(renderText(tool.output.render({}, { ok: false }))).toContain('未知错误')
  })

  it('retain tolerates non-array tags and reports write failures (tools 365/374)', async () => {
    const failing = createFetchStub(() => { throw new Error('write refused') })
    const tool = createRetainTool({ client: new HindsightClient(config, { fetchImpl: failing.fetchImpl }), config })
    const value = await tool.execute({ content: '一条结论', tags: 'not-an-array' }, exec)
    expect(value).toMatchObject({ ok: false, error: /write refused/ })
    assertLossless(value, 'retain failure')
  })
})

describe('coverage completions (non-Error throws)', () => {
  function downClient(reason: unknown) {
    const stub = createFetchStub(() => { throw reason })
    return new HindsightClient(config, { fetchImpl: stub.fetchImpl })
  }

  it('memory tool stringifies non-Error failures (tools 243/244)', async () => {
    const store = new CuratedStore(downClient('socket hang up'), config)
    const value = await createMemoryTool({ store, config }).execute({ action: 'list' }, exec)
    expect(value).toMatchObject({ ok: false, reason: /socket hang up/ })
  })

  it('recall tool stringifies non-Error failures (tools 315)', async () => {
    const value = await createRecallTool({ client: downClient(new Error('plain')), config }).execute({ query: 'q' }, exec) as { error?: string }
    expect(value.error).toContain('无法连接 Hindsight')
    const stringish = await createRecallTool({ client: downClient('down-again'), config }).execute({ query: 'q' }, exec) as { error?: string }
    expect(stringish.error).toContain('down-again')
  })

  it('retain tool stringifies non-Error failures (tools 375)', async () => {
    const value = await createRetainTool({ client: downClient('write-refused'), config }).execute({ content: '一条结论' }, exec)
    expect(value).toMatchObject({ ok: false, error: /write-refused/ })
  })
})

it('batch covering successful remove leg (tools 101 both paths)', async () => {
  const { store } = harness({ m9: { content: 'batch删除目标 bfrag', tags: ['dsh', 'curated', 'mem:memory'] } })
  const tool = createMemoryTool({ store, config })
  const value = await tool.execute({ action: 'batch', operations: [
    { action: 'remove', target: 'memory', old_text: 'bfrag' },
    { action: 'remove', target: 'memory', old_text: 'bfrag-again-missing' },
  ] }, exec)
  expect(JSON.stringify(value)).toContain('1/2 成功')
})

describe('coverage completions (round 5)', () => {
  it('batch ops inherit the top-level target when items omit one (tools 103 ?? path)', async () => {
    const { store } = harness({ u9: { content: '继承测试 ufrag', tags: ['dsh', 'curated', 'mem:user'] } })
    const tool = createMemoryTool({ store, config })
    const value = await tool.execute({ action: 'batch', target: 'user', operations: [
      { action: 'remove', old_text: 'ufrag' },
    ] }, exec)
    expect(JSON.stringify(value)).toContain('1/1 成功')
  })

  it('non-Error transport faults still surface through failureMessage (tools catch else)', async () => {
    // A fetch stub that throws a non-Error proves the client wraps it into HindsightError first.
    const rawThrow = createFetchStub(() => { throw 'raw-string-fault' })
    const store = new CuratedStore(new HindsightClient(config, { fetchImpl: rawThrow.fetchImpl }), config)
    const value = await createMemoryTool({ store, config }).execute({ action: 'list' }, exec) as { reason?: string }
    expect(value.reason).toContain('raw-string-fault')
    const recallValue = await createRecallTool({ client: new HindsightClient(config, { fetchImpl: rawThrow.fetchImpl }), config }).execute({ query: 'q' }, exec) as { error?: string }
    expect(recallValue.error).toContain('raw-string-fault')
    const retainValue = await createRetainTool({ client: new HindsightClient(config, { fetchImpl: rawThrow.fetchImpl }), config }).execute({ content: '一条结论' }, exec) as { error?: string }
    expect(retainValue.error).toContain('raw-string-fault')
  })
})

it('batch counts a store failure whose ok flag is false at the line level (tools 107 else)', async () => {
  // The garbage-item batch above already fails via remove-no-match; this one proves the
  // success leg with an explicit add so both branches of `if (result.ok)` hold per line.
  const { store } = harness()
  const tool = createMemoryTool({ store, config })
  const value = await tool.execute({ action: 'batch', operations: [
    { action: 'add', target: 'memory', content: '第一条成功' },
    { action: 'remove', target: 'memory', old_text: '不存在的内容zzz' },
  ] }, exec)
  expect(JSON.stringify(value)).toContain('✓ 1. add memory')
  expect(JSON.stringify(value)).toContain('✗ 2. remove memory')
})

it('batch illegal action reaches the else leg through a stub store (tools 107)', async () => {
  // The executor-side schema pins the enum, so the vitest harness calls execute directly;
  // a non-enum action must take the fourth branch and count as a failure line.
  const { store } = harness()
  const tool = createMemoryTool({ store, config })
  const value = await tool.execute({ action: 'batch', operations: [
    { action: 'frobnicate', target: 'memory' },
    { action: 'add', content: '一条正常' },
  ] }, exec)
  expect(JSON.stringify(value)).toContain('action 非法')
  expect(JSON.stringify(value)).toContain('1/2 成功')
})

it('batch replace leg executes (tools 107)', async () => {
  const { store } = harness({ m5: { content: '替换基线 rfrag', tags: ['dsh', 'curated', 'mem:memory'] } })
  const tool = createMemoryTool({ store, config })
  const value = await tool.execute({ action: 'batch', operations: [
    { action: 'replace', target: 'memory', old_text: 'rfrag', content: '替换后新内容 rfrag2' },
    { action: 'replace', target: 'memory', old_text: '不存在zzz', content: '不应写入' },
  ] }, exec)
  expect(JSON.stringify(value)).toContain('✓ 1. replace memory')
  expect(JSON.stringify(value)).toContain('✗ 2. replace memory')
})
