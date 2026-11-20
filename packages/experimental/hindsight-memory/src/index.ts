/**
 * hindsight-memory — global long-term memory over a self-hosted Hindsight
 * service (Hermes style).
 *
 * Composition:
 *   1. CuratedStore: USER / MEMORY libraries of Hindsight documents with char
 *      budgets and add / replace / remove / batch / list semantics.
 *   2. Session snapshot: the first step of each session injects one frozen
 *      snapshot; later writes do not change it (prefix-cache protection).
 *   3. Semantic recall: every turn after the first recalls facts from this
 *      turn's real user input, excluding curated-tagged facts.
 *   4. Nudge: every N turns the model is reminded to review memory.
 *   5. Auto-retention: each finished turn is written as a mem:session document.
 *   6. Explicit entry points: memory / memory_recall / memory_retain tools and
 *      the /memory command.
 *
 * Degradation: unreachable services, timeouts, and non-2xx responses skip
 * injection silently and never block the conversation.
 *
 * @module @deepseek-ai/dsh-hindsight-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

import { normalizeConfig } from './config.ts'
import { HindsightClient } from './hindsight.ts'
import { CURATED_TAG, CuratedStore } from './curated.ts'
import { clampText, formatNudge, formatRecall, formatSnapshot } from './render.ts'
import { createMemoryCommand } from './commands.ts'
import { createMemoryTool, createRecallTool, createRetainTool } from './tools.ts'
import type { HindsightMemoryConfig, HindsightProjectionState, LoadedStores } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Curated memory snapshot / recall injection. */
    'hindsight-memory': { kind: 'hindsight-memory' } & ContextFormed
    /** Memory-review nudge injection. */
    'hindsight-memory-nudge': { kind: 'hindsight-memory-nudge' } & ContextFormed
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'hindsight-memory'

/** Hard dependency on the tool registry; the command service is read optionally via ctx.get. */
export const inject = ['tools', 'sessionProjections']

/** Loader schema: every field carries a default; malformed types fail at load. */
export const Config: z<HindsightMemoryConfig> = z.object({
  url: z.string().default('http://127.0.0.1:8888'),
  bank: z.string().default('hermes'),
  userCharLimit: z.number().step(1).min(1).default(1375),
  memoryCharLimit: z.number().step(1).min(1).default(2200),
  snapshot: z.boolean().default(true),
  autoRecall: z.boolean().default(true),
  recallTokens: z.number().step(1).min(1).default(800),
  autoRetain: z.boolean().default(true),
  retainMinChars: z.number().step(1).min(0).default(120),
  maxRetainChars: z.number().step(1).min(1).default(6000),
  nudgeInterval: z.number().step(1).min(0).default(10),
  tags: z.array(z.string()).default(['dsh']),
  timeoutMs: z.number().step(1).min(1).default(8000),
  retainTimeoutMs: z.number().step(1).min(1).default(30000),
  maxEntryChars: z.number().step(1).min(1).default(2200),
  maxInjectedChars: z.number().step(1).min(1).default(6000),
  protectSecrets: z.boolean().default(true),
  maxEntries: z.number().step(1).min(1).default(200),
})

/** This plugin's own message source kinds, excluded when detecting real user input. */
const OWN_KINDS: ReadonlySet<string> = new Set(['hindsight-memory', 'hindsight-memory-nudge'])
/** Framework/other-plugin injections that likewise are not user input. */
const FOREIGN_KINDS: ReadonlySet<string> = new Set(['runtime-context', 'time-context', 'agent-instructions', 'system-prompt'])

/** Concatenate the text blocks of one conversation message. */
function textOfMessage(message: { content?: readonly unknown[] } | undefined): string {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * Last real user input among proposed step messages: any user-role message
 * whose source kind is neither this plugin's nor a known framework injection.
 * @param messages - the enter-batch messages from the pre-step decision.
 * @returns the trimmed text of the last qualifying message, or ''.
 */
export function lastUserText(messages: readonly UserMessage[]): string {
  let found = ''
  for (const message of messages) {
    const kind = message.source.kind
    if (FOREIGN_KINDS.has(kind) || OWN_KINDS.has(kind)) continue
    const text = textOfMessage(message).trim()
    if (text.length > 0) found = text
  }
  return found
}

const projectionStateSchema = zod.object({
  snapshotInjected: zod.boolean(),
  lastRealTurn: zod.number(),
  retainedTurns: zod.array(zod.number()),
})

/**
 * Fold one committed session event into the plugin's durable per-session state.
 * `turn/end` records retention bookkeeping; the live listener decides whether
 * this fiber still owns unclosed-turn caches before retaining.
 * @param state - state covering all prior events.
 * @param event - the next committed session event.
 * @returns the next state (same reference when the event is not the plugin's).
 */
export function foldProjection(state: HindsightProjectionState, event: SessionEvent): HindsightProjectionState {
  switch (event.type) {
    case 'user/message': {
      const source = event.data.source
      if (source.kind === 'hindsight-memory' && source.form === 'snapshot') {
        return state.snapshotInjected ? state : { ...state, snapshotInjected: true }
      }
      if (typeof source.kind === 'string' && !OWN_KINDS.has(source.kind) && !FOREIGN_KINDS.has(source.kind)) {
        const turn = (event.data as { turn?: number }).turn
        if (typeof turn === 'number' && turn > state.lastRealTurn) return { ...state, lastRealTurn: turn }
      }
      return state
    }
    case 'turn/end': {
      if (state.retainedTurns.includes(event.data.turn)) return state
      return { ...state, retainedTurns: [...state.retainedTurns, event.data.turn] }
    }
    default:
      return state
  }
}

/** Live per-turn caches owned by one session within this fiber. */
export interface TurnCache {
  /** Turn these caches belong to. */
  turn: number
  /** Last real user text seen at pre-step for this turn. */
  lastUserText: string
  /** Latest assistant text observed for this turn (overwrite-style). */
  assistantText: string
}

/** Append messages to an enter decision, preserving its other fields. */
function appendMessages(
  decision: Extract<PreStepDecision, { kind: 'enter' }>,
  messages: readonly UserMessage[],
): PreStepDecision {
  return { ...decision, messages: [...decision.messages, ...messages] }
}

/**
 * Summarize one finished turn as a mem:session document (fire-and-forget).
 * Failures never surface: retention must not affect the conversation.
 * @param client - Hindsight client.
 * @param config - runtime configuration.
 * @param cache - this turn's live user/assistant text caches.
 * @param turn - the closed turn number.
 * @returns when retention settles (success or contained failure).
 */
export async function retainTurn(
  client: HindsightClient,
  config: HindsightMemoryConfig,
  cache: TurnCache,
  turn: number,
): Promise<void> {
  const userText = cache.lastUserText.trim()
  const assistantText = cache.assistantText.trim()
  if (userText.length === 0 && assistantText.length === 0) return
  const body = [
    userText.length > 0 ? `用户：${userText}` : '',
    assistantText.length > 0 ? `助手：${assistantText}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  if (body.length < config.retainMinChars) return
  const content = clampText(body, config.maxRetainChars)
  const tags = [...new Set([...config.tags, 'mem:session'])]
  const id = `dsh-turn-${turn}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  try {
    await client.retainDocument({ id, content, tags, context: `dsh turn ${turn}` })
  } catch (_retainFailed) {
    // Automatic retention failures never affect the conversation.
  }
}

/**
 * Plugin entry point.
 * @param ctx - Cordis context owning all registrations.
 * @param config - loader-validated configuration.
 * @returns when listeners, tools, projection, and the optional command are registered.
 */
export function apply(ctx: Context, config: HindsightMemoryConfig): void {
  const runtime = normalizeConfig(config)
  const client = new HindsightClient(runtime)
  const store = new CuratedStore(client, runtime)
  const turnCaches = new WeakMap<Session, TurnCache>()

  const cacheFor = (session: Session, turn: number): TurnCache => {
    let cache = turnCaches.get(session)
    if (cache === undefined || cache.turn !== turn) {
      cache = { turn, lastUserText: '', assistantText: '' }
      turnCaches.set(session, cache)
    }
    return cache
  }

  const projectionReady = ctx.sessionProjections.register({
    key: 'hindsightMemory',
    stateVersion: 1,
    stateSchema: projectionStateSchema,
    init: (): HindsightProjectionState => ({ snapshotInjected: false, lastRealTurn: 0, retainedTurns: [] }),
    apply: foldProjection,
  })

  const disposers: (() => unknown)[] = []
  for (const tool of [
    createMemoryTool({ store, config: runtime }),
    createRecallTool({ client, config: runtime }),
    createRetainTool({ client, config: runtime }),
  ]) {
    disposers.push(ctx.tools.register(tool))
  }
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    disposers.push(commands.register(createMemoryCommand({ store, client, config: runtime })))
  }
  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'hindsight-memory: unregister tools and command')

  // First step of each turn: frozen snapshot / semantic recall / nudge.
  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    try {
      if (decision.kind !== 'enter' || payload.step !== 1) return decision
      const { agent, turn, signal } = payload
      if (signal.aborted) return decision
      const projection = await projectionReady
      const state = projection.stateOf(agent.session)
      const cache = cacheFor(agent.session, turn)

      const query = lastUserText(decision.messages)
      if (query.length > 0) cache.lastUserText = query

      // 1) Frozen snapshot: once per session; a failed load degrades to silence.
      if (runtime.snapshot && !state.snapshotInjected) {
        let loaded: LoadedStores | undefined
        try {
          loaded = await store.loadAll({ signal })
        } catch (_snapshotLoadFailed) {
          // Snapshot failure skips injection for this attempt; retried next step.
        }
        if (loaded !== undefined) {
          const rendered = formatSnapshot(loaded, runtime)
          return appendMessages(decision, [createUserMessage({
            content: [{ type: 'text', text: rendered }],
            source: {
              kind: 'hindsight-memory',
              form: 'snapshot',
              sections: [{ name: 'hindsight-memory', text: rendered }],
            },
          })])
        }
      }

      const extra: UserMessage[] = []

      // 2) Semantic recall: turn 1 is covered by the snapshot; one call per turn.
      if (runtime.autoRecall && turn > 1 && state.lastRealTurn < turn && query.length > 0) {
        try {
          const memories = await client.recall(query, { maxTokens: runtime.recallTokens, signal })
          const filtered = memories.filter(item => !item.tags.includes(CURATED_TAG))
          if (filtered.length > 0) {
            const rendered = formatRecall(filtered, runtime)
            extra.push(createUserMessage({
              content: [{ type: 'text', text: rendered }],
              source: {
                kind: 'hindsight-memory',
                form: 'notice',
                summary: boundContextSummary(`相关记忆 ${filtered.length} 条`),
              },
            }))
          }
        } catch (_recallFailed) {
          // Recall failure degrades silently.
        }
      }

      // 3) Nudge every nudgeInterval turns.
      if (runtime.nudgeInterval > 0 && turn > 0 && turn % runtime.nudgeInterval === 0) {
        const rendered = formatNudge(turn, runtime)
        extra.push(createUserMessage({
          content: [{ type: 'text', text: rendered }],
          source: {
            kind: 'hindsight-memory-nudge',
            form: 'notice',
            summary: boundContextSummary(`第 ${turn} 轮记忆审查提醒`),
          },
        }))
      }

      if (extra.length === 0) return decision
      return appendMessages(decision, extra)
    /* v8 ignore next 3 -- defense-in-depth: every awaited step inside has its own catch,
     * so the outer handler only fires on an unforeseen synchronous fault. */
    } catch (_preStepFailed) {
      return decision
    }
  })

  // Per-turn settlement: cache assistant text; retain closed turns as mem:session notes.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/message') {
      const cache = turnCaches.get(session)
      if (cache !== undefined && event.data.turn === cache.turn) {
        const text = textOfMessage(event.data.message).trim()
        if (text.length > 0) cache.assistantText = text
      }
      return
    }
    if (!runtime.autoRetain || event.type !== 'turn/end') return
    const cache = turnCaches.get(session)
    if (cache === undefined) return
    void retainTurn(client, runtime, cache, event.data.turn)
  })

  ctx.effect(
    () => () => {
      // Projection state is durable; only the fiber-local caches clear here.
      void projectionReady.then(handle => handle.dispose())
    },
    'hindsight-memory: release projection handle',
  )
}
