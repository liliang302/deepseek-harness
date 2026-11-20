/**
 * hindsight-memory —— 以 Hindsight 为存储的全局记忆管理系统（Hermes 风格）。
 *
 * 组成：
 *   1. CuratedMemoryStore：USER / MEMORY 两个库，条目 = Hindsight document（保留原文），
 *      带字符预算，支持 add / replace / remove / batch / list。
 *   2. 会话快照：每会话首次 pre-step 读取两库并注入一条冻结快照；会话内写入不改快照，
 *      与 Hermes「会话开始冻结、保护前缀缓存」的策略一致。
 *   3. 语义召回：之后每轮首步用当轮用户输入 recall Hindsight 事实。
 *   4. nudge：每 N 轮提醒模型审查记忆（Hermes nudge_interval 默认 10）。
 *   5. 自动沉淀：turn/end 把本轮对话写入 Hindsight，标 mem:session，与 curated 层隔离。
 *   6. 显式入口：memory / memory_recall / memory_retain 工具，/memory 命令。
 *
 * 失败降级：Hindsight 不可达、超时、非 2xx 一律静默跳过，绝不阻塞对话。
 *
 * @module @local/hindsight-memory
 */

import { normalizeConfig } from "./lib/config.js";
import { HindsightClient } from "./lib/hindsight.js";
import { CuratedStore, CURATED_TAG } from "./lib/curated.js";
import { formatRecall, formatSnapshot, formatNudge, clampText } from "./lib/render.js";
import { createMemoryTool, createRecallTool, createRetainTool } from "./lib/tools.js";
import { createMemoryCommand } from "./lib/commands.js";

export const name = "hindsight-memory";

/** 硬依赖工具注册表；命令服务按可选处理（缺少时跳过 /memory）。 */
export const inject = ["tools"];

/** 插件自己注入的消息 source.kind，用于从「用户真实输入」中排除。 */
const OWN_KINDS = new Set(["hindsight-memory", "hindsight-memory-nudge"]);
/** 框架或其他插件注入的消息，同样不算用户输入。 */
const FOREIGN_KINDS = new Set(["runtime-context", "agent-instructions", "system-prompt"]);

/**
 * @param {any} message
 * @returns {string}
 */
function textOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * 从 pre-step 的消息里取最后一条真实用户输入。
 * @param {any[]} messages
 * @returns {string}
 */
function lastUserText(messages) {
  let found = "";
  if (!Array.isArray(messages)) return found;
  for (const message of messages) {
    if (!message || message.role !== "user") continue;
    const kind = message.source?.kind;
    if (FOREIGN_KINDS.has(kind) || OWN_KINDS.has(kind)) continue;
    const text = textOfMessage(message).trim();
    if (text.length > 0) found = text;
  }
  return found;
}

/**
 * 构造一条 user 角色的上下文消息。
 * @param {string} text
 * @param {"hindsight-memory" | "hindsight-memory-nudge"} kind
 * @returns {object}
 */
function contextMessage(text, kind) {
  const id =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `hindsight-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind, form: "snapshot" },
  };
}

/**
 * 取（或创建）某个 session 的插件状态。
 * @param {Map<string, any>} states
 * @param {any} agent
 */
function stateFor(states, agent) {
  const key = agent && typeof agent.id === "string" ? agent.id : "unknown";
  let state = states.get(key);
  if (state === undefined) {
    state = {
      snapshot: null,
      snapshotLoaded: false,
      snapshotFailed: false,
      lastRecallTurn: -1,
      lastUserText: "",
      retainedTurns: new Set(),
    };
    states.set(key, state);
  }
  return state;
}

/**
 * 汇总某一轮的对话并写入 Hindsight（tag mem:session）。
 * @param {HindsightClient} client
 * @param {import("./lib/config.js").DEFAULTS} config
 * @param {any} session
 * @param {number} turn
 * @param {{ lastUserText: string }} state
 */
async function retainTurn(client, config, session, turn, state) {
  let assistantText = "";
  try {
    const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
    for (const event of events) {
      if (event?.type !== "assistant/message") continue;
      if (event.data?.turn !== turn) continue;
      const text = textOfMessage(event.data.message).trim();
      if (text.length > 0) assistantText = text;
    }
  } catch {
    return;
  }
  const userText = typeof state.lastUserText === "string" ? state.lastUserText.trim() : "";
  if (userText.length === 0 && assistantText.length === 0) return;
  const body = [
    userText.length > 0 ? `用户：${userText}` : "",
    assistantText.length > 0 ? `助手：${assistantText}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  if (body.length < config.retainMinChars) return;
  const content = clampText(body, config.maxRetainChars);
  const tags = [...new Set([...config.tags, "mem:session"])];
  const id = `dsh-turn-${turn}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    await client.retainDocument({ id, content, tags, context: `dsh turn ${turn}` });
  } catch {
    // 自动沉淀失败不影响对话。
  }
}

/**
 * 插件入口。
 * @param {any} ctx - Cordis 上下文。
 * @param {unknown} rawConfig - profile 中的 config。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const client = new HindsightClient(config);
  const store = new CuratedStore(client, config);
  const states = new Map();

  ctx.tools.register(createMemoryTool({ store, config }));
  ctx.tools.register(createRecallTool({ client, config }));
  ctx.tools.register(createRetainTool({ client, config }));

  const commands = typeof ctx.get === "function" ? ctx.get("commands") : undefined;
  if (commands && typeof commands.register === "function") {
    commands.register(createMemoryCommand({ store, client, config }));
  }

  // 每轮第一步：注入冻结快照 / 语义召回 / nudge。
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    try {
      if (decision?.kind !== "enter") return decision;
      if (payload?.step !== 1) return decision;
      const signal = payload?.signal;
      if (signal?.aborted) return decision;

      const turn = typeof payload.turn === "number" ? payload.turn : 0;
      const state = stateFor(states, payload?.agent);
      const query = lastUserText(decision.messages);
      if (query.length > 0) state.lastUserText = query;

      const parts = [];

      // 1) 会话首个快照：整个 session 只加载一次，之后冻结。
      if (config.snapshot && !state.snapshotLoaded) {
        state.snapshotLoaded = true;
        try {
          state.snapshot = await store.loadAll({ signal });
        } catch {
          state.snapshotFailed = true;
        }
        if (state.snapshot) parts.push(formatSnapshot(state.snapshot, config));
      }

      // 2) 语义召回：第一轮已由快照覆盖，之后每轮一次。
      if (config.autoRecall && turn > 1 && state.lastRecallTurn !== turn && query.length > 0) {
        state.lastRecallTurn = turn;
        try {
          const memories = await client.recall(query, { maxTokens: config.recallTokens, signal });
          const filtered = memories.filter((item) => !item.tags.includes(CURATED_TAG));
          if (filtered.length > 0) parts.push(formatRecall(filtered, config));
        } catch {
          // 召回失败静默降级。
        }
      }

      // 3) nudge。
      if (config.nudgeInterval > 0 && turn > 0 && turn % config.nudgeInterval === 0) {
        parts.push(formatNudge(turn, config));
      }

      if (parts.length === 0) return decision;
      return { ...decision, messages: [...decision.messages, contextMessage(parts.join("\n\n"), "hindsight-memory")] };
    } catch {
      return decision;
    }
  });

  // 每轮结束：把本轮对话沉淀为 mem:session 记忆，不阻塞对话。
  ctx.on("session/event", (session, event) => {
    if (!config.autoRetain) return;
    if (event?.type !== "turn/end") return;
    const turn = event.data?.turn;
    if (typeof turn !== "number") return;
    const state = stateFor(states, session);
    if (state.retainedTurns.has(turn)) return;
    state.retainedTurns.add(turn);
    void retainTurn(client, config, session, turn, state);
  });

  ctx.effect(
    () => () => {
      states.clear();
    },
    "hindsight-memory: clear per-session state",
  );
}
