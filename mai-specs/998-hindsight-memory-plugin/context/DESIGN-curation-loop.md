# 设计：对话驱动的记忆策展闭环（Curation Loop）

- 状态：草案 v1（待评审）
- 日期：2026-11-13
- 载体：DSH 插件 `hindsight-memory`（v0.2.0 → v0.3.0），服务端零改动
- 目标：从「用户 ↔ agent 对话」中自动完成三类记忆演化——
  ① 提取规则（directive）② 标记错误事实（invalidate）③ 更新时效性内容（supersede / 改时间区间）

---

## 0. 前提核实（全部基于运行中 8888 服务的 OpenAPI，2026-11-13 实测）

| 能力 | 服务端原语 | 状态 |
|---|---|---|
| 软退役错误记忆 | `PATCH /banks/{b}/memories/{id}` `state='invalidated'` + `reason`（可逆；被排除出 recall/consolidation，派生 observation 一并清理，入归档） | ✅ 已有 |
| 修订时效内容 | 同上：`text`（重新嵌入并触发重巩固）、`occurred_start/end`（改事件时间区间） | ✅ 已有 |
| 审计轨迹 | `GET /memories/{id}/history` | ✅ 已有 |
| 规则存储 | `GET/POST /banks/{b}/directives`（`name/content/priority/is_active/tags`），reflect 时注入 | ✅ 已有 |
| 服务端判断（带 LLM） | `POST /banks/{b}/reflect`，支持 `response_schema` 结构化输出 | ✅ 已有 |
| 事实抽取预演 | `POST /memories/dry-run-extract` | ✅ 已有 |
| 取代链 | consolidation 自动 supersedes/invalidat（观测层） | ✅ 已在跑 |

**结论**：插件不需要新造任何"智能"，只需补齐三件事——**召回账本、纠错入口、异步审计回路**。

关键缺口（本设计要解决的）：
1. `formatRecall()` 渲染注入文本时**丢弃了 memory id**（`lib/render.js:88`），导致后续任何纠错都无锚点；
2. 用户说"你记错了"这个信号，目前没有任何路径变成 `PATCH state=invalidated`；
3. 复盘判据晋升 directive 靠人肉脚本 `hs teach`，没有对话驱动的自动候选提取。

---

## 1. 总体架构

```
                       ┌────────────────────────────────────────┐
                       │            hindsight-memory 插件        │
  DSH agent-loop       │                                        │
 ┌───────────┐ 注入    │  A. 召回账本 (ledger)                   │
 │ pre-step  │◀────────┼── recall 结果 {id,text,turn} 暂存 state │
 └───────────┘         │        │                               │
 ┌───────────┐ 工具调用 │        ▼                               │
 │ 主 agent  │─────────┼── B. 同步纠错工具（3 个新 tool）         │
 └───────────┘         │     memory_mark_incorrect              │
        ▲              │     memory_update_memory               │
        │指令注入       │     memory_propose_rule                │
 ┌──────┴─────┐        │                                        │
 │ directives │◀────────┼── C. 异步审计回路（turn 累计触发/cron）  │
 └────────────┘        │     retain 对话摘要 → reflect+schema    │
                       └───────────────┬────────────────────────┘
                                       ▼ PATCH/POST/retain
                        Hindsight 服务端（127.0.0.1:8888, bank=hermes）
                        consolidation 自动完成观测层取代与失效传播
```

三条路径分工：

| 路径 | 触发 | 延迟 | 成本 | 用途 |
|---|---|---|---|---|
| A 账本 | 每次 recall | — | 0 | 基础设施：记住"本轮注入了哪些记忆条目" |
| B 同步工具 | 主 agent 当场发现矛盾 | 即时 | 0 额外推理（主模型已在场） | 主力路径：90% 的纠错走这里 |
| C 异步审计 | 每 N 轮 / 每日定时 | 分钟级 | 1 次服务端 reflect（deepseek-flash） | 兜底：漏网的纠错 + 规则候选提取 |

**为什么 B 是主力**：纠错信号出现的那一刻，主模型（deepseek）上下文里同时有"注入的旧记忆"和"用户的新陈述"，它是最便宜的裁判；插件自己不调 LLM（v0.2 至今零模型依赖，保持这个性质）。C 只负责主 agent 没意识到要改的存量问题。

---

## 2. 模块 A：召回账本（ledger）

### 2.1 改动点：`lib/render.js` formatRecall

每条注入文本前加短锚点 id（UUID 前 8 位，供模型引用；插件内维护短 id → 全量 id 映射）：

```
1. [21d11aea] 2026-11-07 NAS 入侵排查结论：未发现被入侵证据……
2. [a3f9c021] NAS 部署规则：镜像 tag 必须用固定日期……
```

### 2.2 改动点：`index.js` recall 调用处

`state.ledger` 新增（会话级，随现有 `states` Map 生命周期）：

```js
// turn 维度，滚动保留最近 LEDGER_TURNS=8 轮
state.ledger.push({
  turn,
  ts: Date.now(),
  items: memories.map(m => ({ id: m.id, short: m.id.slice(0,8), type: m.type, text: m.text.slice(0,300) })),
});
```

- `type` 保留：`observation` 与原始 `fact` 的纠错语义不同（见 §4.3）。
- 短 id 冲突处理：注册时若前 8 位撞车则取 12 位，映射表按插入序。
- 快照注入（formatSnapshot）不加锚点——curated 条目走现有 `memory` 工具的 replace/remove，职责不重叠。

### 2.3 注入语料变化

召回块尾部的提示语从"需要改写时用 memory 工具"升级为：

> 若用户本轮陈述与上述某条**冲突**、或某条已过时/错误，调用 `memory_mark_incorrect`（附短 id 与用户原话）；若用户给出了正确的新版本，同时调用 `memory_update_memory` 或直接 `memory_mark_incorrect` 带 `replacement`。

这是行为契约的全部——其余交给主模型的判断力。

---

## 3. 模块 B：三个新工具（lib/tools.js）

### 3.1 `memory_mark_incorrect`

```jsonc
{
  "name": "memory_mark_incorrect",
  "description": "用户已明确否定或事实已证伪时调用。软退役一条长期记忆：不再参与召回与巩固，可逆，保留审计轨迹。",
  "parameters": {
    "id":          "string  // 召回条目左侧短锚点（如 21d11aea）",
    "reason":      "string  // 必填。判定依据，优先引用用户原话",
    "replacement": "string  // 可选。正确版本；给了则同时 retain 一条新事实（tags: dsh+curated+mem:corrected）"
  }
}
```

实现要点：
1. `resolveShortId(state.ledger, id)` → 全量 UUID；解析失败返回全部候选，让模型重试（不猜）。
2. `PATCH /memories/{uuid}` body `{ state:'invalidated', reason }`。
3. 有 `replacement` 时追加 `POST /memories`（async=true）写入更正事实——服务端 consolidation 会自动把它与被退役观测建立取代关系。
4. **护栏**：
   - 每会话失效上限 `MAX_INVALIDATE_PER_SESSION=10`，超限要求先 `hs` 人工审（防模型发疯批量清库）；
   - `reason` 少于 8 字符拒绝（防误触）；
   - observation 类型可直接 PATCH（其 source facts 不动，只退观测——观测是投影，错了就退，原料还在）；
   - 幂等：已是 `invalidated` 的直接返回"已退役，无需操作"。

### 3.2 `memory_update_memory`

时效性更新用，**不退役、只修订**：

```jsonc
{
  "name": "memory_update_memory",
  "description": "记忆内容部分过时或时间区间写错时调用（如版本号、部署地址、进度类事实的例行更新）。",
  "parameters": {
    "id": "string",
    "text": "string            // 可选。新文本（服务端重嵌入并重巩固）",
    "occurred_start": "string", // 可选。ISO 8601
    "occurred_end": "string"    // 可选。'2999-12-31' 表示仍然有效
  }
}
```

与 3.1 的选择规则（写进 description）：**"从来就是错的"用 mark_incorrect；"曾经是错的/现在过期了"用 update_memory**。

### 3.3 `memory_propose_rule`

```jsonc
{
  "name": "memory_propose_rule",
  "description": "从对话中提炼出普适行为规则（口径、红线、判据）时调用。先查已有规则，同名则更新而非新建。",
  "parameters": {
    "name": "string",
    "content": "string",
    "priority": "int",   // 默认 0，越高越先注入
    "tags": ["string"]   // 默认 ["dsh"]；空数组=全局
  }
}
```

实现：先 `GET /directives` 按 name 精确匹配 → 命中则 `PATCH`（UpdateDirectiveRequest 支持改 content/priority/is_active），未命中 `POST`。**防重复规则是硬要求**——用户明确反感同一事实两处表达。

晋升门槛（写进 description，让模型自律）：规则须满足「跨任务普适 + 用户明示 + 可判真伪」三者；一次性偏好留在 curated memory，不进 directive。

### 3.4 工具可见性

三个工具跟现有 `memory_*` 一样常驻注册（schema 成本约 +600 tok，远小于 mcp-progressive 元工具化后剩余的量级；若要抠成本可后续并入 progressive 组，本版不做）。

---

## 4. 模块 C：异步审计回路（lib/audit.js，新文件）

### 4.1 定位

C 只回答一个问题："**过去这段时间的对话里，有哪些被注入的记忆被证明错了/过期了，却没人调用纠错工具？**" 以及"有没有值得晋升但漏掉的规则？"

### 4.2 触发与节流

- 触发条件（满足其一）：会话 `turn ≥ auditEveryTurns`（默认 30，0=关闭）时 fire-and-forget；或外部 launchd 每日 09:30 调 `hs audit`（与现有 `com.lee.hindsight-refresh` 09:00 错峰）。
- 并发锁：`/tmp/dsh-hs-audit.lock`（mkdir 原子），防多会话同时审计。

### 4.3 流程

```
1. 取证据窗：state.ledger 全量（本轮注入过的条目）+ 对话 turn/end 摘要
2. POST /reflect，固定 query + response_schema：
   {
     "invalidations": [ { "memory_id": "...", "quote": "<用户原话>", "why": "conflict|stale|verified_wrong" } ],
     "updates":       [ { "memory_id": "...", "suggested_text": "...", "new_end": "ISO|null" } ],
     "rule_candidates":[ { "name": "...", "content": "...", "evidence": "..." } ]
   }
3. 执行分级：
   - invalidations/updates：confidence 字段 ≥ high → 自动执行（走 §3 同一套函数）
   - rule_candidates：一律不自动写 directive，落到 ~/.dsh/audit/pending-rules.jsonl 等人审
     （规则改变行为，比退役事实危险一个量级——对齐"晋升需第 3 次出现"的既有 hs teach 语义：
      pending 文件中同一判据出现 ≥3 次才在报告里建议晋升）
4. 结果写一条审计 document（tags: dsh+mem:audit），可召回、可复盘
```

### 4.4 成本核算（账本驱动，避免重蹈心智模型刷新 81% token 的覆辙）

- 实测 reflect 单发 ≈125k input tok（deepseek-flash，retain 仅 3.4k）。审计**必须限频**：每会话每天 ≤1 次、全局 ≤3 次；
- reflect 请求带 `tags` 缩范围（`dsh` + 会话实际涉及 tags 的交集）与 `max_tokens` 上限（1200），禁止全库扫描；
- 账本 ≤ 40 条时跳过 LLM，直接零成本规则：用户消息命中否定句式（"不对/已经改了/过期了/别再用"）且同轮有注入 → 只在该轮上下文内做字符串相似度归因，命中才升级为 LLM 精判。

---

## 5. 服务端配置联动（一次性，非代码）

| 项 | 值 | 理由 |
|---|---|---|
| `RECALL_PREFER_OBSERVATIONS` | 开 | 观测是演化结果，优先返回；被覆盖原始事实自动隐藏 |
| bank `mission` 追加一句 | "召回内容被用户否定时应标记失效而非默默忽略" | reflect 路径同样受 mission 约束 |
| 新建 directive「时效事实写法」 | 进度/版本类事实文本内必须带日期锚点 | 让 staleness 可机判 |

## 6. 配置新增（lib/config.js）

```js
auditEnabled: true,        // C 回路总开关
auditEveryTurns: 30,
auditMaxPerDay: 3,
maxInvalidatePerSession: 10,
ledgerTurns: 8,
```

## 7. 文件改动清单（预估，全部在插件内）

| 文件 | 改动 | 行数 |
|---|---|---|
| `lib/render.js` | formatRecall 加锚点 + 提示语升级 | ~20 |
| `index.js` | recall 处写 ledger；注册新工具与审计钩子 | ~30 |
| `lib/hindsight.js` | 新增 `updateMemory(PATCH)`、`listDirectives`、`createDirective`、`patchDirective`、`reflect` 5 个方法（沿用现有 request()，客户端从 6 入口扩到 11） | ~60 |
| `lib/tools.js` | 三个新工具定义与实现 | ~150 |
| `lib/audit.js` | 新文件：触发器、粗筛、reflect+schema、分级执行、pending-rules | ~180 |
| `lib/config.js` | 5 个新键 | ~10 |
| `tests/integration.mjs` | 每工具 1 正 1 护栏用例（见 §8） | ~120 |

无新依赖、不破坏现有 6 入口路径；插件工程先 `git init` 提基线再动工（沿用先前结论）。

## 8. 验收标准（对真实 8888 服务跑通）

1. **锚点回环**：recall 注入 → 用短 id `mark_incorrect` → `GET /memories/{id}` 确认 `state=invalidated` 且 `invalidated_at/reason` 落库 → 再 recall 同 query 不再出现该条。
2. **更正取代**：带 `replacement` 退役后，新事实经 consolidation 出观测，`GET /memories/{id}/observations` 可见取代关系。
3. **护栏**：第 11 次失效被拒；`reason` 过短被拒；短 id 撞车返回候选。
4. **规则防重**：同名 directive 连续 propose 两次 → 总数不变、`updated_at` 变化。
5. **审计闭环**：伪造一轮"用户否定注入记忆"的对话 → 审计后该条被退役、`mem:audit` 文档可召回、pending-rules 出现候选。
6. **成本红线**：单审计周期 reflect input token 记账（`GET /llm-requests/stats`），全局 ≤3 次/天生效。
7. **零回归**：现有快照/召回/nudge/沉淀四段行为与 v0.2 完全一致（integration 测试全绿）。

## 9. 分期

- **P1（先行，1 天）**：模块 A + B —— 账本、三工具、测试。立即获得对话驱动纠错能力，零 LLM 额外成本。
- **P2（观察一周后）**：模块 C —— 异步审计。P1 上线后先看 `hs`/audit-logs 里同步路径的命中率；若主 agent 已把大多数纠错当场处理，C 的阈值可再调高甚至只做每日 cron。
- **不做**：客户端自造 embedding 相似度判断（服务端有）；自动删除记忆（只 invalidate，可逆）；自动晋升 directive（永远过人审或 3 次门槛）。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 模型误退役正确记忆 | 只允许退役**本会话注入过**的条目（账本即白名单）；可逆；history 可查 |
| Hermes 与 DSH 同时改同一条 | PATCH 走服务端乐观锁 by updated_at；冲突则放弃写入留给下轮审计 |
| 规则注入膨胀拖慢每次 reflect | directive 数量上限告警（>30 条出报告建议合并）|
| 双端快照互不可见引发重复纠错 | curated 层（tag 分区）本就不进账本；账本只管 recall 命中，天然无重叠 |
