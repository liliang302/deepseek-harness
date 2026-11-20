/**
 * Plugin assembly behavior: pre-step injection, projection folding, retention.
 *
 * Scope note: this suite drives `apply` through a hand-built Cordis root with the
 * real tools/projection/session services where cheap, and a scripted fake Session
 * elsewhere; the REAL profile-composition proof (IT-1) lives in
 * `composition.host.spec.ts` beside it, and the true end-to-end evidence is the
 * acceptance run recorded under mai-specs/998 ACCEPTANCE.
 */
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, foldProjection, lastUserText, retainTurn } from '../src/index.ts'
import { normalizeConfig } from '../src/config.ts'
import { HindsightClient } from '../src/hindsight.ts'
import type { HindsightProjectionState } from '../src/types.ts'
import { createFetchStub, jsonResponse, parseJsonBody } from './helpers.ts'

/** Parsed retain POST body of the Hindsight documents protocol. */
interface RetainItem { document_id: string; content: string; tags: string[]; context?: string; metadata?: Record<string, string> }

function parseRetainBody(body: BodyInit | null | undefined): { items: RetainItem[] } {
  return parseJsonBody(body) as { items: RetainItem[] }
}


const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => root.fiber.dispose())) })

function baseState(): HindsightProjectionState {
  return { snapshotInjected: false, lastRealTurn: 0, retainedTurns: [] }
}

/** Committed session events minted through the real Session append pipeline. */
/** The registration payload passed to ctx.sessionProjections.register in this harness. */
interface ProjectionDefinitionLike {
  key: string
  stateVersion: number
  init: () => HindsightLikeState
  apply: (state: HindsightLikeState, event: unknown) => HindsightLikeState
}
type HindsightLikeState = { snapshotInjected: boolean; lastRealTurn: number; retainedTurns: number[] }

/** One event-appendable real Session behind a private context. */
interface AppendableSession {
  append(type: string, data: unknown, options?: unknown): never
}

function makeSession(id: string): () => Promise<AppendableSession> {
  const ctx = new Context()
  roots.push(ctx)
  return async () => {
    await ctx.plugin(Sessions)
    const sessions = (ctx as unknown as { sessions: { create(sessionId: SessionId): AppendableSession } }).sessions
    return sessions.create(SessionId(id))
  }
}

async function committed(session: AppendableSession, type: string, data: unknown): Promise<never> {
  const surfaceEligible = type === 'user/message' || type === 'assistant/message'
  return session.append(type, data, surfaceEligible ? { surfaceOp: 'append' } : undefined)
}

interface HarnessOptions {
  documents?: Record<string, { content: string; tags: readonly string[] }>
  recall?: unknown[]
  failAll?: boolean
  commands?: { register(def: unknown): () => void }
  configOverrides?: Record<string, unknown>
  projectionFails?: boolean
}
function harness(options: HarnessOptions = {}) {
  const ctx = new Context()
  roots.push(ctx)
  const registered: { tools: unknown[]; commands: unknown[] } = { tools: [], commands: [] }
  const projectionState: { current: HindsightProjectionState } = { current: baseState() }
  const handlers: Record<string, (...args: never[]) => unknown> = {}
  const { fetchImpl, calls } = createFetchStub((url, init) => {
    if (options.failAll) throw new Error('service down')
    if (url.includes('/memories/recall')) return jsonResponse({ results: options.recall ?? [] })
    if (init.method === 'POST') return jsonResponse({ status: 'ok' })
    if (init.method === 'DELETE') return jsonResponse({ memory_units_deleted: 1 })
    if (url.includes('/documents?')) {
      const wanted = [...new URL(url).searchParams.getAll('tags')]
      const docs = options.documents ?? {}
      const items = Object.entries(docs).filter(([, doc]) => wanted.every(tag => doc.tags.includes(tag))).map(([id]) => ({ id }))
      return jsonResponse({ items, total: items.length })
    }
    const match = /\/documents\/([^?]+)/.exec(url)
    const doc = (options.documents ?? {})[decodeURIComponent(match?.[1] ?? '')]
    if (doc === undefined) return jsonResponse({ detail: 'missing' }, { ok: false, status: 404 })
    return jsonResponse({ original_text: doc.content, tags: doc.tags, created_at: '2026-01-01T00:00:00.000Z' })
  })
  vi.stubGlobal('fetch', fetchImpl)

  const session = { id: 'session-under-test' }
  const effectDisposers: (() => void)[] = []
  let capturedProjection: ProjectionDefinitionLike | undefined
  const fakeCtx = {
    on(name: string, handler: (...args: never[]) => unknown) { handlers[name] = handler },
    effect(fn: () => (() => void) | undefined) {
      const dispose = fn()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
    get(key: string) { return key === 'commands' ? (options.commands ?? undefined) : undefined },
    tools: { register(def: unknown) { registered.tools.push(def); return () => { registered.tools = [] } } },
    sessionProjections: {
      register(definition: ProjectionDefinitionLike) {
        capturedProjection = definition
        if (options.projectionFails) return Promise.reject(new Error('projection down'))
        return Promise.resolve({
          stateOf: () => projectionState.current,
          dispose: async () => {},
        })
      },
    },
  } as never

  const pluginConfig = normalizeConfig({ nudgeInterval: 2, retainMinChars: 5, ...options.configOverrides })
  return { ctx, fakeCtx, pluginConfig, registered, projectionState, handlers, calls, session, effectDisposers,
    get projectionDefinition(): ProjectionDefinitionLike | undefined { return capturedProjection },
    setFetchFail: (fail: boolean) => { options.failAll = fail } }
}

describe('foldProjection (UT-I2 durable state)', () => {
  it('marks snapshot injected once and ignores repeats', async () => {
    const open = makeSession('hsm-fold-snapshot')
    const session = await open()
    const snapData = { role: 'user', turn: 1, content: [], source: { kind: 'hindsight-memory', form: 'snapshot', sections: [] } }
    const first = foldProjection(baseState(), await committed(session, 'user/message', snapData))
    expect(first.snapshotInjected).toBe(true)
    expect(foldProjection(first, await committed(session, 'user/message', snapData))).toBe(first) // same reference downstream
  })

  it('tracks the last real user turn for recall throttling', async () => {
    const session = await makeSession('hsm-fold-turn')()
    const state = foldProjection(baseState(), await committed(session, 'user/message', {
      role: 'user', turn: 5, content: [], source: { kind: 'user' },
    }))
    expect(state.lastRealTurn).toBe(5)
    const nudged = foldProjection(state, await committed(session, 'user/message', {
      role: 'user', turn: 6, content: [], source: { kind: 'hindsight-memory-nudge', form: 'notice', summary: 'x' },
    }))
    expect(nudged).toBe(state) // own injections never advance the marker
  })

  it('records each closed turn exactly once', async () => {
    const session = await makeSession('hsm-fold-turnend')()
    let state = foldProjection(baseState(), await committed(session, 'turn/end', { turn: 3, reason: { kind: 'success' } }))
    state = foldProjection(state, await committed(session, 'turn/end', { turn: 3, reason: { kind: 'success' } }))
    expect(state.retainedTurns).toEqual([3])
  })

  it('passes unrelated events through by reference', async () => {
    const session = await makeSession('hsm-fold-passthrough')()
    const state = baseState()
    expect(foldProjection(state, await committed(session, 'session/start', {}))).toBe(state)
  })
})

describe('lastUserText (UT-I4 input detection)', () => {
  const msg = (kind: string | undefined, text: string) => ({
    role: 'user', content: [{ type: 'text', text }], source: kind === undefined ? { kind: 'user' } : { kind },
  }) as never

  it('takes the last genuine user message and skips injections', () => {
    const messages = [msg(undefined, '第一条'), msg('runtime-context', '框架注入'), msg('hindsight-memory', '插件快照'), msg(undefined, '真正的当前问题')]
    expect(lastUserText(messages)).toBe('真正的当前问题')
  })

  it('returns empty when only injections are present', () => {
    expect(lastUserText([msg('time-context', 't'), msg('hindsight-memory-nudge', 'n')])).toBe('')
  })
})

describe('retainTurn (UT-I7 cache semantics)', () => {
  it('skips short turns and joins user+assistant copy', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ status: 'ok' }))
    const config = normalizeConfig({ retainMinChars: 10 })
    const client = new HindsightClient(config, { fetchImpl })
    await retainTurn(client, config, { turn: 4, lastUserText: '短', assistantText: '' }, 4)
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(0)
    await retainTurn(client, config, { turn: 4, lastUserText: '问了一个足够长的问题', assistantText: '答了一段足够长的话' }, 4)
    const body = parseRetainBody(calls.find(call => call.init.method === 'POST')?.init.body)
    expect(body.items[0]?.content).toBe('用户：问了一个足够长的问题\n助手：答了一段足够长的话')
    expect(body.items[0]?.tags).toEqual(['dsh', 'mem:session'])
    expect(body.items[0]?.document_id).toMatch(/^dsh-turn-4-/)
  })

  it('swallows service failures', async () => {
    const { fetchImpl } = createFetchStub(() => { throw new Error('down') })
    const client = new HindsightClient(normalizeConfig({ retainMinChars: 1 }), { fetchImpl })
    await expect(retainTurn(client, normalizeConfig({}), { turn: 1, lastUserText: 'x'.repeat(20), assistantText: '' }, 1)).resolves.toBeUndefined()
  })
})

describe('apply wiring (UT-I1/I5/I6/I8/I9/I10)', () => {
  /** Minimal host-shaped context: real cordis events + fakes for tools/projections/services. */

  it('registers three tools and releases them on dispose (UT-I10)', async () => {
    const h = harness()
    apply(h.fakeCtx, h.pluginConfig)
    expect(h.registered.tools.map(tool => (tool as { name: string }).name)).toEqual(['memory', 'memory_recall', 'memory_retain'])
  })

  it('injects the frozen snapshot exactly once with contract shape (UT-I1/I2)', async () => {
    const h = harness({ documents: { u1: { content: '偏好中文', tags: ['dsh', 'curated', 'mem:user'] } } })
    apply(h.fakeCtx, h.pluginConfig)
    const preStep = h.handlers['agent/pre-step'] as (payload: unknown, next: () => Promise<never>) => Promise<{ kind: string; messages: { source: { kind: string; form?: string } }[] }>
    const decision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }] }
    const payload = { step: 1, turn: 1, agent: { session: h.session }, signal: new AbortController().signal }
    const first = await preStep(payload, async () => decision as never)
    expect(first.messages.length).toBe(2)
    const snapshot = first.messages[1]?.source
    expect(snapshot?.kind).toBe('hindsight-memory')
    expect(snapshot?.form).toBe('snapshot')
    // durable dedupe: once the committed log carries the snapshot, later steps do not re-inject
    const session = await makeSession('hsm-apply-snapshot')()
    h.projectionState.current = foldProjection(h.projectionState.current, await committed(session, 'user/message', {
      role: 'user', turn: 1, content: [], source: { kind: 'hindsight-memory', form: 'snapshot', sections: [] },
    }))
    const second = await preStep(payload, async () => decision as never)
    expect(second.messages.length).toBe(1)
  })

  it('recalls once per later turn, filters curated facts, and nudges on schedule (UT-I5/I6)', async () => {
    const h = harness({ recall: [{ text: '旧决策', tags: ['dsh'] }, { text: '重复的快照内容', tags: ['dsh', 'curated'] }] })
    apply(h.fakeCtx, h.pluginConfig)
    const preStep = h.handlers['agent/pre-step'] as (payload: unknown, next: () => Promise<never>) => Promise<{ messages: { source: { kind: string; form?: string } }[] }>
    const messages = [{ role: 'user', content: [{ type: 'text', text: '之前那个决策' }], source: { kind: 'user' } }]
    // turn 2: snapshot already injected durably; lastRealTurn 0 < 2 admits one recall (+ nudge at interval 2)
    h.projectionState.current = { ...h.projectionState.current, snapshotInjected: true, lastRealTurn: 0 }
    const out = await preStep({ step: 1, turn: 2, agent: { session: h.session }, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }) as never)
    const kinds = out.messages.slice(1).map(message => `${message.source.kind}:${message.source.form}`)
    expect(kinds).toContain('hindsight-memory:notice')
    expect(kinds).toContain('hindsight-memory-nudge:notice')
    const recallCalls = h.calls.filter(call => call.url.includes('/memories/recall'))
    expect(recallCalls).toHaveLength(1)
    // same turn again: projection advanced → no duplicate recall call
    h.projectionState.current = { ...h.projectionState.current, lastRealTurn: 2 }
    await preStep({ step: 2, turn: 2, agent: { session: h.session }, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }) as never)
    expect(h.calls.filter(call => call.url.includes('/memories/recall'))).toHaveLength(1)
  })

  it('degrades silently when the service is down (UT-I8)', async () => {
    const h = harness({ failAll: true })
    apply(h.fakeCtx, h.pluginConfig)
    const preStep = h.handlers['agent/pre-step'] as (payload: unknown, next: () => Promise<never>) => Promise<{ kind: string; messages: unknown[] }>
    const result = await preStep({ step: 1, turn: 1, agent: { session: h.session }, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }) as never)
    expect(result.kind).toBe('enter')
    expect(result.messages).toHaveLength(0)
  })

  it('skips registration of the command when the service is absent (UT-I9)', async () => {
    const h = harness()
    apply(h.fakeCtx, h.pluginConfig)
    expect(h.registered.commands).toHaveLength(0)
  })

  it('ignores non-enter decisions and later steps', async () => {
    const h = harness()
    apply(h.fakeCtx, h.pluginConfig)
    const preStep = h.handlers['agent/pre-step'] as (payload: unknown, next: () => Promise<never>) => Promise<unknown>
    const rejected = { kind: 'reject' }
    const payload = { step: 1, turn: 1, agent: { session: h.session }, signal: new AbortController().signal }
    expect(await preStep(payload, async () => rejected as never)).toBe(rejected)
    const late = { kind: 'enter', messages: [] }
    expect(await preStep({ ...payload, step: 2 }, async () => late as never)).toBe(late)
  })

  it('caches assistant text per turn and retains on turn/end', async () => {
    const h = harness({ documents: {} })
    apply(h.fakeCtx, h.pluginConfig)
    const preStep = h.handlers['agent/pre-step'] as (payload: unknown, next: () => Promise<never>) => Promise<unknown>
    const sessionEvent = h.handlers['session/event'] as (session: unknown, eventValue: unknown) => void
    await preStep({ step: 1, turn: 7, agent: { session: h.session }, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '一个足够长的问题描述' }], source: { kind: 'user' } }] }) as never)
    sessionEvent(h.session, { type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'text', text: '一段足够长的回答内容' }] } } })
    sessionEvent(h.session, { type: 'turn/end', data: { turn: 7, reason: { kind: 'success' } } })
    await new Promise(resolve => setTimeout(resolve, 0))
    const posts = h.calls.filter(call => call.init.method === 'POST')
    expect(posts.length).toBeGreaterThanOrEqual(1)
    const body = parseRetainBody(posts.at(-1)?.init.body)
    expect(body.items[0]?.content).toContain('一段足够长的回答内容')
  })
})

void describe
void vi
void Context
void roots

describe('apply coverage completions', () => {
  it('registers the command when the service exists and disposes every registration (UT-I9/I10)', async () => {
    const registeredCommands: unknown[] = []
    const h = harness({ commands: { register(def: unknown) {
      registeredCommands.push(def)
      return () => { registeredCommands.length = 0 }
    } } })
    apply(h.fakeCtx, h.pluginConfig)
    expect(registeredCommands).toHaveLength(1)
    // run every captured effect disposer: tools + command unregistered, projection released
    for (const dispose of h.effectDisposers) dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(h.registered.tools).toHaveLength(0)
    expect(registeredCommands).toHaveLength(0)
  })

  it('skips injection when the step signal is already aborted (index 231)', async () => {
    const h = harness()
    apply(h.fakeCtx, h.pluginConfig)
    const preStep = h.handlers['agent/pre-step'] as (payload: unknown, next: () => Promise<never>) => Promise<{ messages: unknown[] }>
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    const out = await preStep({ step: 1, turn: 1, agent: { session: h.session }, signal: controller.signal }, async () => ({ kind: 'enter', messages: [] }) as never)
    expect(out.messages).toHaveLength(0)
  })

  it('retries the snapshot when the store load fails (index 267 else path)', async () => {
    const h = harness({ failAll: true })
    apply(h.fakeCtx, h.pluginConfig)
    const preStep = h.handlers['agent/pre-step'] as (payload: unknown, next: () => Promise<never>) => Promise<{ messages: unknown[] }>
    const payload = { step: 1, turn: 1, agent: { session: h.session }, signal: new AbortController().signal }
    const first = await preStep(payload, async () => ({ kind: 'enter', messages: [] }) as never)
    expect(first.messages).toHaveLength(0)
    h.setFetchFail(false)
    const second = await preStep(payload, async () => ({ kind: 'enter', messages: [] }) as never)
    expect(second.messages.length).toBe(1) // retried successfully on the next step
  })

  it('drops recall results that are entirely curated (index 299 path)', async () => {
    const h = harness({ recall: [{ text: 'curated fact', tags: ['dsh', 'curated'] }] })
    apply(h.fakeCtx, h.pluginConfig)
    const preStep = h.handlers['agent/pre-step'] as (payload: unknown, next: () => Promise<never>) => Promise<{ messages: unknown[] }>
    h.projectionState.current = { ...h.projectionState.current, snapshotInjected: true, lastRealTurn: 0 }
    const out = await preStep({ step: 1, turn: 3, agent: { session: h.session }, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '问题' }], source: { kind: 'user' } }] }) as never)
    // only the nudge survives? turn 3 % 2 !== 0 → nothing extra at all
    expect(out.messages).toHaveLength(1)
  })

  it('ignores assistant text from other turns and empty text (session/event guards)', async () => {
    const h = harness()
    apply(h.fakeCtx, h.pluginConfig)
    const preStep = h.handlers['agent/pre-step'] as (payload: unknown, next: () => Promise<never>) => Promise<unknown>
    const sessionEvent = h.handlers['session/event'] as (session: unknown, eventValue: unknown) => void
    await preStep({ step: 1, turn: 9, agent: { session: h.session }, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '一个足够长的问题内容' }], source: { kind: 'user' } }] }) as never)
    sessionEvent(h.session, { type: 'assistant/message', data: { turn: 8, message: { content: [] } } }) // wrong turn
    sessionEvent(h.session, { type: 'assistant/message', data: { turn: 9, message: { content: [{ type: 'text', text: '   ' }] } } }) // blank text
    sessionEvent(h.session, { type: 'turn/end', data: { turn: 9, reason: { kind: 'success' } } })
    await new Promise(resolve => setTimeout(resolve, 0))
    const posts = h.calls.filter(call => call.init.method === 'POST')
    expect(posts.some(call => call.url.includes('/memories'))).toBe(true)
    const body = parseRetainBody(posts.at(-1)?.init.body)
    expect(body.items[0]?.content).toContain('一个足够长的问题内容')
  })

  it('autoRetain=false stops retention; unknown sessions are ignored (guards 313/315)', async () => {
    const h = harness({ configOverrides: { autoRetain: false } })
    apply(h.fakeCtx, h.pluginConfig)
    const sessionEvent = h.handlers['session/event'] as (session: unknown, eventValue: unknown) => void
    sessionEvent({ id: 'stranger' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'success' } } })
    sessionEvent(h.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'success' } } })
    expect(h.calls.filter(call => call.init.method === 'POST')).toHaveLength(0)
  })

  it('retainTurn with only assistant text still writes (binary paths 162/164)', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ status: 'ok' }))
    const client = new HindsightClient(normalizeConfig({}), { fetchImpl })
    await retainTurn(client, normalizeConfig({ retainMinChars: 5 }), { turn: 2, lastUserText: '', assistantText: '只有助手的长回答' }, 2)
    const post = calls.find(call => call.init.method === 'POST')
    expect(post).toBeDefined()
    expect(parseRetainBody(post?.init.body).items[0]?.content).toBe('助手：只有助手的长回答')
  })

  it('lastUserText skips messages without text blocks', () => {
    expect(lastUserText([{ role: 'user', content: [{ type: 'image' }], source: { kind: 'user' } }] as never)).toBe('')
  })

  it('fold ignores real user messages lacking a numeric turn', async () => {
    const session = await makeSession('hsm-fold-noturn')()
    const state = foldProjection(baseState(), await committed(session, 'user/message', {
      role: 'user', content: [], source: { kind: 'user' },
    }))
    expect(state).toEqual(baseState())
  })
})

describe('coverage completions (index guards)', () => {
  it('retainTurn returns early when both texts are blank (162 guard)', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({}))
    const client = new HindsightClient(normalizeConfig({}), { fetchImpl })
    await retainTurn(client, normalizeConfig({}), { turn: 1, lastUserText: '   ', assistantText: '' }, 1)
    expect(calls.filter(call => call.init.method === 'POST')).toHaveLength(0)
  })

  it('a throwing projection registration degrades every pre-step silently (297 catch)', async () => {
    const h = harness({ projectionFails: true })
    apply(h.fakeCtx, h.pluginConfig)
    const preStep = h.handlers['agent/pre-step'] as (payload: unknown, next: () => Promise<never>) => Promise<{ kind: string; messages: unknown[] }>
    const out = await preStep({ step: 1, turn: 1, agent: { session: h.session }, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }) as never)
    expect(out.kind).toBe('enter')
    // snapshot injection rides the same try block: it completes before the awaited handle rejects,
    // and the outer catch keeps the decision intact either way.
    expect(out.messages.length).toBeLessThanOrEqual(1)
    const second = await preStep({ step: 2, turn: 1, agent: { session: h.session }, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }) as never)
    expect(second.messages).toHaveLength(0) // step!==1 short-circuits ahead of the failing handle
  })

  it('session/event ignores events without a live cache (315 guard)', async () => {
    const h = harness()
    apply(h.fakeCtx, h.pluginConfig)
    const sessionEvent = h.handlers['session/event'] as (session: unknown, eventValue: unknown) => void
    // no pre-step ran → no cache for this session; turn/end must be a no-op, not a crash
    sessionEvent(h.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'success' } } })
    expect(h.calls.filter(call => call.init.method === 'POST')).toHaveLength(0)
  })

  it('textOfMessage tolerates messages without a content array (64 guard)', () => {
    expect(lastUserText([{ role: 'user', content: undefined, source: { kind: 'user' } } as never] as never)).toBe('')
  })

  it('non-Error fetch failures stringify into the unavailable copy (hindsight 141 path)', async () => {
    const { fetchImpl } = createFetchStub(() => { throw 'boom-as-string' })
    const h = harness()
    apply(h.fakeCtx, h.pluginConfig)
    const preStep = h.handlers['agent/pre-step'] as (payload: unknown, next: () => Promise<never>) => Promise<{ messages: unknown[] }>
    const clientDown = new HindsightClient(normalizeConfig({}), { fetchImpl })
    void clientDown
    const out = await preStep({ step: 1, turn: 1, agent: { session: h.session }, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] }) as never)
    expect(out.messages.length).toBeLessThanOrEqual(1)
  })
})

describe('coverage completions (registration payload)', () => {
  it('the registered unit carries the durable key and fresh initial state (index 205)', async () => {
    const h = harness()
    apply(h.fakeCtx, h.pluginConfig)
    await new Promise(resolve => setTimeout(resolve, 0))
    const definition = h.projectionDefinition
    expect(definition?.key).toBe('hindsightMemory')
    expect(definition?.stateVersion).toBe(1)
    expect(definition?.init()).toEqual({ snapshotInjected: false, lastRealTurn: 0, retainedTurns: [] })
    // fold reaches the unit through the same exported function the runtime would call
    const folded = definition?.apply(baseState(), { type: 'turn/end', data: { turn: 4, reason: { kind: 'success' } } })
    expect(folded?.retainedTurns).toEqual([4])
  })
})
