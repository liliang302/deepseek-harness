# 代码评审报告：Hindsight 全局记忆体插件移植

> 评审人：hs-acceptance（my-review-code 流程，真机验收同轮执行）| 日期：2026-11-20 | 评审对象：main @ f0a88096fb（交付提交 7e12e45acb）| 对照：[spec/PRD.md](../spec/PRD.md)、[design/TECH_DESIGN.md](../design/TECH_DESIGN.md)（含 DESIGN_REVIEW 复评修订）、[test/TEST_PLAN.md](../test/TEST_PLAN.md) | 执行路径核对：src/index.ts → tools.ts → curated.ts → hindsight.ts（另覆盖 config/security/render/commands/types）

## 总体结论

**通过（无 P0）**。DESIGN_REVIEW P0-1/P1-1..4 的修复全部真实落地并经真机验证：注入消息走 `createUserMessage`（frozen + branded id + MessageSourceMap 声明合并 + snapshot 带 sections / notice 带 boundContextSummary），去重改由 sessionProjections 持久投影承担，resume 幂等在 IT-1 脚本级证据中复现。waterfall `next()` 纪律、lossless 返回值、降级静默、dispose 完备性均与仓库规范一致。发现 3 个 P1（门禁未过项：tsconfig paths 映射缺失、README 文档骨架不合规、export JSDoc 参数命名违规）与若干 P2；按任务约束不改源码，全部记录于此。

## 关键契约核对（逐条，附证据）

### 1. lossless 返回值（BR-05）— PASS
- `types.ts` 用 `StoreResult` 判别联合把 present-or-absent 字段结构化，杜绝 `{ usage: undefined }` 形态；`tools.ts finalize()/runBatch()` 只在字段存在时挂载（`entries.length > 0`、`result.usage !== undefined`、`if (failures > 0) value.reason = ...`）。
- 真机旁证：IT-1 脚本对 executor 返回的 over_budget 成功两种值递归查 undefined 字段，均为 null（J.lossless PASS）；单测 UT-T4 保留旧 integration.mjs 的 assertLossless 回归（5 个历史缺陷场景）。
- 唯一残余风险见 P2-1（batch 空 operations 早退分支不含 entries/usage，形状不对称但无 undefined）。

### 2. waterfall next() 纪律 — PASS
- `index.ts:246-247` pre-step 监听器第一句即 `const decision = await next()`，其后所有分支（直通/注入/异常兜底）都返回 decision 派生值或原引用，不存在不调 next 就 return 的短路。step!==1 或非 enter 时返回原引用（UT-I3 断言引用相等，真机 K 段亦观察 turn>1 无重复注入）。
- `retainTurn` fire-and-forget 处 `void retainTurn(...)` 自带 catch 全包（index.ts:193-197），E2E-9 停服运行未触发 unhandledRejection（进程监听器零命中）。

### 3. createUserMessage frozen/branded（P0-1 修复验证）— PASS
- `index.ts:40-47` declare module 合并 `'hindsight-memory'`/`'hindsight-memory-nudge'` 两个 producer kind（`& ContextFormed`），符合 message.ts 的 merge-extensible 协议。
- 快照：`form:'snapshot'` + `sections:[{name,text}]`（index.ts:269-276）；召回/nudge：`form:'notice'` + `boundContextSummary(...)`（≤120 字符截断，index.ts:294/311）。
- 真机 IT-1：请求中的快照消息 `Object.isFrozen === true`、id 为非空字符串（B.snapshot-frozen / B.snapshot-branded-id PASS），且 durable log 有同一条 `user/message`（C.durable-log-snapshot PASS，model-visible ⟺ logged）。

### 4. projection stateVersion 与 fold 正确性 — PASS
- `register({ key:'hindsightMemory', stateVersion:1, stateSchema(zod), init, apply:foldProjection })`（index.ts:221-227）：key 为 host-only 字符串键（不进 SessionProjectionMap），stateVersion=1 满足 registry 的非负整数校验；zod schema 与 cordis stateSchema 类型兼容（运行时注册成功，IT-1 全程无错误日志）。
- `foldProjection` 纯函数、无关事件返回同一引用（projection 契约要求 `Object.is` 零下游工作）；`turn/end` 追加 retainedTurns 前先查重（UT-I7/S9 语义，IT-1 D 段重放两遍事件流 snapshotInjected 不变——resume 幂等 E2E-12 脚本级证据 PASS）。
- 备注：retainedTurns 数组随会话长度线性增长，见 P2-2。

### 5. dispose 完备性（BR-07）— PASS
- 工具×3 与命令的 disposer 收进数组并挂 `ctx.effect`（index.ts:229-243）；projection handle 释放另挂 effect（index.ts:341-347）。fiber dispose 后全局 view 不再可见 memory（IT-1 I.pre-dispose-tools→dispose-clean PASS；registry disposal 规则另有 UT-I10）。
- 小瑕疵见 P2-3：projection dispose effect 体内 `void promise.then(...)` 使卸载不等待释放完成。

### 6. README 配置表 vs DEFAULTS vs Config schema — 一致性 PASS，文档门禁 FAIL
- 三处逐项对齐：url/bank/userCharLimit(1375)/memoryCharLimit(2200)/snapshot/autoRecall/recallTokens(800)/autoRetain/retainMinChars(120)/maxRetainChars(6000)/nudgeInterval(10)/tags([dsh])/timeoutMs(8000)/retainTimeoutMs(30000)/maxEntryChars(2200)/maxInjectedChars(6000)/protectSecrets/maxEntries(200)——config.ts DEFAULTS、index.ts Config schema、README「Configuration」表、cordis.patch.yml 四份完全一致（CR-01 落实：个人默认值在 README 明示"production deployments must set explicitly"）。
- 但 `verify-cordis-config` / `verify-tsconfig-paths` 因缺 `@deepseek-ai/dsh-hindsight-memory` 的 tsconfig.base.json paths 映射而红（P1-1）；README 骨架与标题不合 doc 门禁（P1-2/P1-3/P1-4）。

### 7. 其他核对点
- **安全前置（BR-06）**：`add/replace` 首行 `inspectContent`，先于预算检查与任何 HTTP 写；injection 句式不可关（protectSecrets=false 只放开密钥类），与 FR-06 一致（UT-K1..K14 + 真机 hermes 库抽查未见凭据形态条目）。
- **召回过滤（FR-04/BR-03）**：`lastUserText` 排除 OWN/FOREIGN kinds；recall 结果 `!item.tags.includes(CURATED_TAG)` 过滤；节流条件 `turn>1 && state.lastRealTurn<turn` 防同轮重发。真机 INFO 段确认 bank 中存在带 curated tag 的 fact（会被剔除）。
- **写失败不动旧数据（AC-04）**：replace 先 `retainCurated` 后 `deleteDocument`，retain 抛错则 delete 不发生（UT-S7；IT-1 F 段真机复现旧 id 消失新 id 在）。
- **超时分工（NFR-01）**：读 8s/写 30s 分离、`AbortSignal.any` 合并调用方 signal；readDetails 并发 ≤8 worker 池。
- **listDocuments all_strict**：curated 查询 tags=[...config.tags,'curated','mem:<target>']，与 mem:session 沉淀互不混入（BR-04，IT-1 E/H/K 段以同套 tag 面复核）。

## 问题清单

### P1（应修，属仓库门禁/规范，非运行时缺陷）
- **P1-1 tsconfig paths 缺映射**：`pnpm run verify-cordis-config` 报 `packages/experimental/hindsight-memory/cordis.patch.yml: @deepseek-ai/dsh-hindsight-memory does not resolve to workspace source through tsconfig.base.json paths`；`verify-tsconfig-paths` 同因红。影响：源码态 `dsh web` 启动时该 bundle 行经 built lib/ 而非 src（本次真机 link 安装能跑通是因为走了 profile node_modules 解析）。修法：`gen-tsconfig-paths` 重生成（DESIGN_REVIEW P1-1 曾要求把该生成器纳入 T1/T6，实现时漏执行）。
- **P1-2 README 缺 Summary/Table of Contents/Dev Note 骨架**：`doc-standard.spec.ts` 断言 package-bundle README 必含 `## Summary`、`## Table of Contents`、`### Dev Note`（zh 对应 概述/目录/开发备注），本包双语 README 均缺三项。
- **P1-3 export JSDoc 参数命名违规**：`verify-export-jsdoc` 报 4 处——`createMemoryCommand/createMemoryTool/createRecallTool/createRetainTool` 用解构参数 `{ store, client, config }` 但 `@param deps` 指向不存在的形参名。修法：改为具名参数 `deps` 或修正标签。
- **P1-4 README 标题与链接问题**：`## Known limitations and deferred work` 应为规范大小写 `## Known Limitations and Deferred Work`（verify-package-readme-limitations）；README:19 的 `../../mai-specs/...` 相对链接深度错误（包在 3 层目录下，应为 `../../../mai-specs/...`），verify-md-links 报 4 条断链（双语 ×2 链接）。另 README.md:11-12 首段摘要逐字重复一次。

### P2（可延后，建议记入包 README「Known Limitations」）
- **P2-1 batch 空 operations 早退形状**：`runBatch` 对 `operations.length===0` 返回 `{ok:false,action:'batch',reason}` 不带 entries/usage，与其余失败分支（带当前清单）不对称；无 undefined 字段、不违 lossless，仅模型体验差异。
- **P2-2 retainedTurns 线性增长**：投影状态里已沉淀轮次以数组累积，超长会话 checkpoint 体积随之增大；可换区间压缩或上限截断（截断需保证幂等语义不破）。
- **P2-3 projection dispose 不被 await**：dispose effect 内 `void projectionReady.then(h => h.dispose())`，fiber 卸载不等释放完成；registry 引用计数最终一致，但 HMR 快速重载窗口内可能出现同名 key 短暂 refs 叠加。
- **P2-4 nudge 文案 join('')**：`formatNudge` 用空串连接行，渲染出的提醒文本无换行（快照/召回用 join('\n')）；不影响功能，观感不一致。
- **P2-5 recall 无相关度阈值**：README「Known Limitations」已如实声明（与 PRD §6 决策一致），维持现状。

### 环境噪音（非本包缺陷，验收时观察到）
- `verify-repository-references` 报 `DESIGN_REVIEW.md:3` 的 `HEAD 9b1fd282f2` 为 commit-hash 引用——SDD 过程文档书写惯例与门禁冲突，建议改写为"基线提交（见 git log）"。
- doc-sync 其余红项（config catalog/persistence catalog/sdd-workbench 断链/mai-specs README 配对）源于 sdd-workbench 面板分支残留产物与 main 交付形态错位，与本包无关，留待各自主理。

## 结论

实现忠实于 TECH_DESIGN（含复评修订），核心运行时契约（lossless、next()、frozen/branded、projection 去重、dispose、降级、安全前置、预算数学）全部通过静态核对 + 单测 + 真机三层验证。**无 P0**。P1-1..4 是随包交付的门禁欠账（T6 声称全绿与实际不符，ACCEPTANCE 已如实降级标注），修复动作都很小且不改变行为语义，建议下一个提测周期清零。
