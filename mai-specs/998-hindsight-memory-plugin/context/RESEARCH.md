# 架构与技术记录

目标：把 Hermes 的记忆管理语义落到 Hindsight 上。本文件记录关键 API 事实、设计取舍与未验证假设。
环境：DeepSeek Harness 0.2.1-rc.2（asar）、Hindsight（Docker，`127.0.0.1:8888`，bank=`hermes`）。

## 1. 为什么用 document 作为条目

Hindsight 有两层可选：

| 层 | 内容 | 是否适合「一条记忆」 |
|---|---|---|
| fact（world / experience / observation） | 抽取器把原文拆成陈述句，附带实体、时间、proof_count | 否：一条原文常被拆成 2–4 条，且会被 consolidation 合并/改写 |
| document | 保留 `original_text` 原文、`tags`、自定义 `id`、`created_at`、`memory_unit_count` | 是：id 稳定、原文精确、可单条删除 |

实测：写入 `USER 画像：用户偏好中文回复，要求先给结论再给细节。`（1 个 document）后：

- document：`original_text` 完整保留；
- facts：2 条 world + 2 条 observation，均继承 document 的 tags；
- 删除 document：返回 `memory_units_deleted`，其 facts 一并删除，按 tag 查询归零。

因此采用 **document = curated 条目**，facts 层完全交给 Hindsight 负责语义召回与整理。

## 2. Hindsight API 事实

### 2.1 写入

```http
POST /v1/default/banks/{bank}/memories
{"items":[{"content":"…","document_id":"dsh-mem-<uuid>","tags":["dsh","curated","mem:user"],
           "context":"curated memory (user)","metadata":{"source":"dsh-memory","target":"user"}}]}
```

- 同步模式（默认 `async:false`）实测约 2 秒（一次 3169 input tokens 的抽取）。
- `document_id` 可自定义，是 replace「先写后删」的基础。
- `metadata` 只接受字符串值。

### 2.2 读取

```http
GET /v1/default/banks/{bank}/documents?tags=dsh&tags=curated&tags_match=all_strict&limit=200
GET /v1/default/banks/{bank}/documents/{document_id}
```

- **多 tag 必须用重复参数**：`tags=a&tags=b`；逗号形式 `tags=a,b` 返回 0 条。
- `tags_match` 关键取值：
  - `any`（默认）：会带上**无标签**条目，导致结果混入无关记忆；
  - `all_strict`：严格「全部包含」，curated 查询必须用这个。
- 列表不返回原文，只有 `text_length`；快照渲染需要逐条 GET detail，实现里并发 8。

### 2.3 更新与删除

```http
PATCH  /documents/{id}  {"tags":[…]}
DELETE /documents/{id}
```

- `PATCH` **只能改 tags**（请求体只接受 `tags`，传 metadata 会 400）；不能改正文。
- 因此 `replace` = 新 document 写入成功 → 删除旧 document。顺序保证中途失败不丢数据（最多留一条重复）。

### 2.4 语义召回

```http
POST /v1/default/banks/{bank}/memories/recall
{"query":"…","max_tokens":800}
```

- 返回 fact 列表（含 `tags`），curated 与 `mem:session` 都会参与。
- 插件在注入前过滤掉 `curated` 的 fact：curated 条目已由快照/工具覆盖，避免重复。

## 3. DSH 扩展点

| 能力 | 用法 | 备注 |
|---|---|---|
| `agent/pre-step`（waterfall） | 每轮首步改写 `decision.messages` 注入一条 user 消息 | payload 含 `agent`、`turn`、`step`、`signal`；`step===1` 才是每轮首步 |
| `session/event` → `turn/end` | 读取 `session.snapshotEvents()` 中本轮 assistant 消息并沉淀 | fire-and-forget，不能 await，用 `void` |
| `ctx.tools.register` | 注册 `memory` / `memory_recall` / `memory_retain` | definition 需 `name`、`description`、`parameters`、`output.schema`、`output.render`、`execute` |
| `ctx.get("commands").register` | 注册 `/memory` | `commands` 服务可选；缺少时跳过 |
| `agent/turn-stopping`（serial） | 可在 turn 关闭前 await 后台工作 | 本版未用；未来做 review 时可挂这里 |

### 3.1 注入消息的形状

```js
{ id, role: "user", content: [{ type: "text", text }], source: { kind: "hindsight-memory", form: "snapshot" } }
```

`source.kind` 用于在下一轮 `pre-step` 里把插件自己注入的消息从「用户真实输入」中排除，避免用注入文本去召回自己。

### 3.2 未采用 `systemPrompt.section`

`systemPrompt.section({ text: (context) => … })` 看起来更适合放快照，但 `AssembleContext` 只有 `scope` 与 `signal`，拿不到 agent/session，无法做到「每会话一份冻结快照」。因此仍在 `pre-step` 注入，靠 `state.snapshotLoaded` 冻结。

### 3.3 HMR 行为

修改 `index.js` 会触发插件重载；**只改 `lib/*.js` 不一定触发**（实测工具名改动未生效，touch `index.js` 后才重载）。调试时改完 lib 记得 touch 入口。

## 4. 设计决策

| 决策 | 理由 |
|---|---|
| USER/MEMORY 用 tag 而非两个 bank | 一个 bank 内 recall 一次覆盖两库；换库需要两次请求并手工合并排序 |
| 记忆条目写入用同步 retain | 保证 `add` 返回时条目已可 list；超时给 30 秒 |
| 预算按字符而非 token | 与 Hermes 的 `_char_count` 一致，模型无关、可预测；token 仅用于展示估算（2.75 chars/token） |
| 超预算返回当前条目 | 与 Hermes 的 `over_budget` 行为一致，让模型自己决定压缩哪条 |
| 会话内冻结快照 | 对齐 Hermes「mid-session writes hit disk but never change the prompt」，保护前缀缓存 |
| 自动沉淀单独打 `mem:session` | 避免每轮对话把 curated 预算挤爆；recall 仍可命中 |
| 安全扫描放写入侧 | 记忆会进入上下文，一条被污染的记忆跨会话持久 |

## 5. 未验证/已知限制

1. `/memory` 命令的 UI 呈现未在浏览器里逐项点击验证（命令已注册，handler 逻辑与工具共用同一 store）。
2. nudge 的 10 轮边界未跑满验证（逻辑为 `turn % nudgeInterval === 0`）。
3. `retainDocument` 的失败语义：服务端可能已写入而客户端超时（Hindsight 有 `operation_id` 幂等键，本版未用）。
4. 自动沉淀不做摘要，`mem:session` 文档会随对话线性增长；后续可改为「先摘要再写」。
5. Hermes 的后台 fork review（用 LLM 判断该不该写、写哪个库）未实现；当前依赖 nudge 引导模型显式调用 `memory`。
6. Hindsight 的 consolidation 可能把 curated 派生 fact 与 session fact 合并，快照读的是 document 原文，不受影响；但 recall 结果可能出现改写版本。

## 6. 验证记录（2026-10-19）

- `tests/integration.mjs`：预算、replace、remove、歧义匹配、密钥/注入拦截、工具层、渲染，全部通过。
- 子 agent 端到端：`memory` 的 list/add/replace/remove 6 步全部成功，usage 正确，清理无残留。
- 自动沉淀：子 agent 会话结束后出现 `dsh-turn-1-…`，1858 字符，tags `[mem:session, dsh]`。
- 真实基础记忆：写入 4 条 curated（1 user + 3 memory）后，`documents?tags=curated&all_strict` 返回 4 条。
- 真实会话：会话首轮上下文出现完整的 `[Hindsight 长期记忆 · 会话快照]`（USER 1 条 / MEMORY 3 条，带 `38/1375`、`353/2200` 占用）以及后续轮次的 `[Hindsight 长期记忆 · 相关召回]`，证明 pre-step 注入、冻结快照与语义召回在真实多轮会话中生效。

## 7. 已修复缺陷（2026-10-19）

### 7.1 失败路径返回 `value is not lossless JSON`

**现象**：无匹配 `remove`、密钥拦截、注入拦截、`batch` 成功这四条路径，工具结果一律变成
`Error: tool "memory" returned invalid output: value is not lossless JSON`；调用方拿不到
`reason`，最危险的是 `batch` 已写盘却报失败。

**根因**：工具返回值里显式写了 `usage: undefined`（`finalize` 的失败分支）和
`reason: undefined`（`runBatch` 的成功分支）。Harness 要求工具结果可无损 JSON 序列化，
值为 `undefined` 的字段会让整条结果被改写为不可读错误。

**修复**：可选字段只在有值时挂上；`reason` 兜底为字符串；`execute` 外层 try/catch。

**回归**：`tests/integration.mjs` 新增 `assertLossless()`，递归检查返回值不含 `undefined`
且可 JSON 往返，覆盖无匹配、密钥、注入、空 batch、batch 成功五条路径。

### 7.2 热重载不会驱逐 `lib/*.js`

**现象**：改了 `lib/tools.js` 并 `touch index.js`，运行中的插件仍执行旧代码；
`node tests/integration.mjs` 直接 import 新文件却全部通过。

**原因**：ESM 模块缓存按 URL 命中。Cordis 只重新 import 入口 `index.js`，其
`import "./lib/tools.js"` 的 URL 不变，子模块不会重新求值。

**处理**：`hmr.reconcileProfile()` 会检测 profile 下已变更的文件并驱逐模块；触发方式是
改动 `cordis.patch.yml`（profile 重组）。仅 `touch` 入口不够。彻底重启 DSH 一定生效。
