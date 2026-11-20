# 方案评审报告：Hindsight 全局记忆体插件移植

> 评审人：design-review（my-review-design 独立评审）| 日期：2026-11-20 | 待评审文档：[design/TECH_DESIGN.md](../design/TECH_DESIGN.md)（基线 feat/hindsight-memory-plugin @ dsh-v0.2.2-rc.5，仓库 HEAD 见 git log）| 全程只读核对仓库真实代码

## 总体结论

**有条件通过**。整体架构判断准确、减法检查到位、D5/D7 两个高风险决策的核验方向正确；但存在 1 个 P0（注入消息形状违反仓库类型契约与持久化准入规则）、4 个 P1（T1 清单漏 3 处强制登记、可选服务访问写法违规、配置校验语义漂移、REAL-composition 测试缺失），修复成本集中在 tools.ts / index.ts / T1 清单三处，改完即可开工。

## 阻塞问题（P0，必须修复才能开工）

### P0-1 注入消息 `source: { kind, form: 'snapshot' }` 不满足仓库类型契约与 V4 持久化准入，且绕开快照收敛机制

**方案声称**（§2.1.2 / §2.4 / D1"语义零漂移"）：平移基线 `contextMessage()`，返回 `{ ...decision, messages: [...decision.messages, contextMessage(text, 'hindsight-memory')] }`，消息形状为 `{ id, role: 'user', content: [...], source: { kind, form: 'snapshot' } }`（基线 [index.js:72-83](../context/baseline/index.js)）。

**实际代码事实**：
1. **类型不兼容**：`form: 'snapshot'` 在 `ContextFormed` 判别联合中强制要求 `sections` 字段——`{ readonly form: 'snapshot'; readonly sections: readonly ContextSnapshotSection[] }`（packages/llm/llm/src/message.ts:91-95）。缺 `sections` 直接编译失败。插件自定义 source.kind 必须先经声明合并注册：`declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { 'hindsight-memory': { kind: 'hindsight-memory' } & ContextFormed } }`（先例：packages/experimental/hooks-claude-code/src/index.ts:19-23、packages/schedule/schedule/src/runtime.ts:6-10）。方案通篇未提这一步。
2. **手写裸对象违反消息创建契约**：Agent Note「identified immutable message values」规定每条新语义消息必须在创建点 mint id 并 deep-freeze（`createUserMessage()` 统一完成，packages/llm/llm/src/message.ts:246-253）；`.agents/notes/implemented/architecture/2026-07-28-identified-immutable-message-values.md:21`。基线手拼 `{id, role, content, source}` 不冻结、id 用非 branded 字符串；pre-step 收到的 claimed messages 全部是 frozen 的（packages/core/agent-loop/tests/interception.spec.ts:133-146 断言），插件产出裸对象会被 session append 时再 freeze 掩盖差异，但 `MessageId` 是 branded 类型（`brandString<MessageId>`），裸 string 赋不进去——strict 下编译不过。
3. **V4 持久化准入**：`assertV4MessageSources` 要求每个 durable `user/message` 的 `source.kind` 为非空字符串且 ≠ `'plugin'`（packages/session/session-format-v3-to-v4/src/message-sources.ts:6-12）。`'hindsight-memory'` 本身能过准入，但前提是它作为 producer-owned kind 被正式声明；否则下游消费者（UI transcript、time-context 投影等按 `source.kind` 分类的读取方，如 packages/context/time-context/src/index.ts:171）无法识别归属。
4. **绕过 runtime-context 快照收敛机制**：框架对 `form:'snapshot'` 有专门语义——`RuntimeContextProjection.project(sections)` 按 `sections` 深比较决定是否重复注入（packages/core/agent-loop/src/runtime-context.ts:160-183），且该机制只对 `kind === 'runtime-context'` 的消息生效。插件借用 snapshot form 却不带 sections，等于声明了一个"每轮可能重发"的上下文却没有实现去重协议。方案的补偿是内存态 `state.snapshotLoaded`（基线 index.js:184-192），这有两个真实缺口：**resume/fork 后 Map 为空 → 快照会二次注入**；且注入消息进入 durable history 后每轮请求都携带（model-visible ⟺ logged：docs/architecture.md:130；loop 把 enter batch 逐条 append 为 `user/message`，packages/core/agent-loop/src/agent.ts:469-479），nudge/召回同样逐条累积到 compaction 才消失（time-context README.md:125 明确了同样的代价："Each reading accumulates until compaction shadows it"）。

**为什么是 P0**：不修则 (a) strict 编译直接失败，T4 走不下去；(b) 即便强行通过，会话 resume 后重复注入破坏 BR-02"整个会话只注入一次"的 AC-01；(c) source.kind 未声明违反仓库规范评审必打回。**修复路径明确**：声明 MessageSourceMap 合并 + 改用 `createUserMessage({ content, source: { kind: 'hindsight-memory', form: 'notice', summary: <一行说明> } })`（notice form 只需 `summary: string`，message.ts:96-99，正是"一次性事件陈述"语义，webhook/action-cards 均此用法），或带完整 `sections` 走 snapshot form；per-session 状态改由 projection 或从 session log 折叠最后一条本插件消息推导（见 P1-4）。

**证据**：packages/llm/llm/src/message.ts:81-100,212-253；packages/session/session-format-v3-to-v4/src/message-sources.ts:6-12；packages/core/agent-loop/src/runtime-context.ts:16,127-183;agent.ts:469-479；docs/architecture.md:130；.agents/notes/implemented/architecture/2026-07-28-identified-immutable-message-values.md:15-21；基线对照 context/baseline/index.js:72-83。

## 重要建议（P1）

### P1-1 T1 包骨架清单至少漏 3 处门禁强制登记

方案 §2.2/T1 列了 apps/cli 依赖、OPTIONAL_BUNDLES+EXPERIMENTAL_BUNDLES、EXCEPTIONS、tsconfig.host.json 四处。实测还有：
1. **`scripts/gen-tool-catalog.ts` TOOL_PACKAGES**：`verify-tool-catalog`（doc-sync 门禁）的 `assertManifestComplete` glob `packages/*/tool-*`（scripts/gen-tool-catalog.ts:794）——本包目录名 `hindsight-memory` 恰好不命中，**侥幸免登记**；但这依赖目录命名，若改名 `tool-hindsight-memory` 就必须登记 mount 条目并在 boot 中提供 Hindsight mock。建议在 T1 显式记录这条判定依据，别留给运气。
2. **`docs/config-catalog.md`**：`collectConfigCatalog` 扫描所有 `packages/*/*` 中含 `apply(ctx, config)` 两参函数插件的包（scripts/gen-config-catalog.ts:764+,kind='config'），`verify-config-catalog` 属 doc-sync 门禁（scripts/run-gates.ts:867）。本包有 Config → 必须跑 `pnpm run gen-config-catalog` 重新生成双语 catalog，T1/T6 均未列。
3. **locale 8 语言完整性**：`verify-locale-metadata.ts:30-33` 把**每个有 src/index.ts 且 kind=config/no-config 的包**的 locale 目录纳入强制检查（不只 bundle），要求 en/zh/ja/es/fr/de/ru/pt 全量翻译 meta.title/description/detail，占位符一致、description 以句号结尾（en）、非复制源文（scripts/verify-locale-metadata.ts:50-68）。方案写了 `locale/{en,zh,...}.json` ✓ 但没写"8 语言全量 + detail 文件必须存在"（`meta.detail` 指向的文件缺失即报错，line 44-47）——`docs/DETAIL.md` 若声明就必须存在；另注意 DETAIL.md **不在** translation-pairing 语料范围（isTranslationScopeFile 只收 README*/docs//.agents/python/，scripts/translation-pairing.ts:163-170），所以 DETAIL.zh.md 非必需，可省（见 P2-2）。
4. EXCEPTIONS 登记格式核对 ✓：`'packages/experimental/hindsight-memory': '@deepseek-ai/dsh-hindsight-memory'` 与 scripts/experimental-package-policy.ts:8-35 的 satisfies 模板（`packages/experimental/${string}` → `@deepseek-ai/dsh-${string}`）完全吻合。
5. icon：旧版 64×64 SVG **不能沿用**——`svgArtworkProblems` 强制 `width="36" height="36" viewBox="0 0 36 36"`（scripts/verify-package-meta.ts:88），且 `@deepseek-ai/dsh-*` 包全部受检（line 196）；RES-04"图标沿用旧版"要改成"重画 36×36"。另 OPTIONAL_BUNDLES 每项必须有 `icon` 字段 + `./locale/*.json` export + `dsh.bundle.patch`（scripts/verify-default-product-isolation.ts:88-102），bundle 型 package.json 模板应参照 packages/experimental/terminal-bundle/package.json（含 exports "./cordis.patch.yml"、files cordis.patch.yml、dsh.bundle.patch 声明），而非 sdd-workbench（后者不是 bundle，无 patch/icon）——方案"对齐 sdd-workbench 案例"选错了模板对象。
6. tsconfig.base.json paths 由 `gen-tsconfig-paths` 生成区自动覆盖（BEGIN GENERATED 标记区），`pnpm install` 后跑一次生成器即可，T1 补一句。

### P1-2 可选 commands 服务的访问写法与 inject 组合有坑

方案 §2.3.1 用 `ctx.get('commands')` 存在才注册——方向正确（AGENTS.md packages 层规则"Optional services use ctx.get(name)"；claude-code-mods/src/host-ops.ts:298 同法），但注意两点：(a) `inject=['tools']` 里不能加 'commands'（硬注入会让无 commands 的部署整包 PENDING，postmortem 0001 的教训正是 inject 误用）；方案现状 OK，但 §2.3.1 同时写了 `CommandDefinition{name,...}` 注册——`register()` 返回值是 disposer，必须挂进 `ctx.effect`（registry contributions prove disposal，packages/AGENTS.md；命令名须匹配 `/^[a-z][a-z0-9_-]*$/`，interaction/commands/src/index.ts:32,180，`memory` ✓）。(b) handler 返回 `{kind:'success'|'error', text}` 与 CommandResult 契约相符 ✓（types.ts:34-38），但方案 §2.3.4 又写"返回 CommandInfo{kind:'text'|...}"——**CommandInfo 不存在**，是同节自相矛盾的残留，按 types.ts 的 CommandResult 定稿即可。(c) `invocation.rawInput`/`signal` 字段核实 ✓（index.ts:41-59）。

### P1-3 normalizeConfig"非法类型回退默认+warn"与 Loader schemastery 校验冲突

方案 §2.1.1：静态 `Config = z.object(...)` 带 default，`normalizeConfig` 简化为只清洗 tags；CR-01 又说"配置类型非法仍回退默认并记 warn"。两者矛盾：Loader 用 Config schema 校验 profile config，**类型不符会 fail loud**（仓库规则"Misconfiguration fails loud at load"），根本到不了插件 apply。zod 校验通过后传入 apply 的值已类型安全，normalizeConfig 的回退分支不可达 → 100% 覆盖率门禁（NFR-03）下这些分支要么测不到要么逼出死代码。建议：接受 Loader 语义（非法配置加载即失败），normalizeConfig 删掉全部类型回退，只留 url 尾斜杠剥离、tags 清洗、`Math.floor` 之类值域归一；CR-01 文案同步改。附带发现：基线 DEFAULTS 实为 **18 键**（python 数过：url/bank/userCharLimit/memoryCharLimit/snapshot/autoRecall/recallTokens/autoRetain/retainMinChars/maxRetainChars/nudgeInterval/tags/timeoutMs/retainTimeoutMs/maxEntryChars/maxInjectedChars/protectSecrets/maxEntries），方案 §2.1.1 说"19 键逐一对应"多数了一个——小错，改文案即可。

### P1-4 per-session 状态 Map 的重启/resume 一致性

D4 保留 apply 闭包 `states keyed by agent.id`。基线行为在单进程连续运行下成立，但 bundle 化后要面对：profile 重载/HMR 重建 fiber → states 清空 → 老会话 resume 时快照重注入（与 P0-1 第 4 点叠加）；subagent fork 等新 agent id 天然干净。MVP 修法二选一：(a) 快照注入前扫一遍本 session 已提交的 `user/message`（用 turn/end 同款 `session/event` 累计或注册一个轻量 `sessionProjections` unit——后者更合规，time-context/tmux-context/action-cards 全是这个模式，packages/context/time-context/src/index.ts:159-198），projection 同时能替 D5 存 per-turn assistantText 与 retainedTurns，一并解决"重启后 retainTurn 去重失效"；(b) 明确接受"每次 fiber 重建重注入一次"并写进 README Known Limitations。方案 §1.3 说"为单一消费者建投影属过度"——评审认为不成立：投影在这里同时消除 P0-1 的重复注入、D5 的缓存丢失和 retainTurn 重启重沉淀三个问题，是仓库标准解而非过度设计。至少要在 T4 现场核验时把 (a)/(b) 定下来。

## 次要观察（P2）

1. **P0-1 的 form 选择建议**：召回块/nudge 是一次性事件 → `form:'notice'`（需 `summary` ≤120 字符，message.ts:104-124 有 boundContextSummary）；快照若走 snapshot form 必须给 `sections:[{name:'hindsight-memory', text}]`。两种都比裸抄基线形状便宜。
2. **docs/DETAIL.md 双语 i18n yaml**：README.md/README.zh.md/README.i18n.yaml 三件套是强制语料（translation-pairing SCOPE_PATTERNS `**/*.md` + README_ARTIFACT 谓词，scripts/translation-pairing.ts:110,163-170）——保留；DETAIL.md 不在配对语料内，DETAIL.zh.md 可不写（terminal-bundle 有 zh 是历史习惯，sdd-workbench 只有 DETAIL.md ✓）。方案列 `docs/DETAIL.md` ✓ 不必加 .zh。
3. **types.ts 判别联合**（H 项）：`StoreResult` ok=true 分支写成 `& Record<string, unknown>` 会把 action/entries 等字段类型洗掉，不如按 action 分支或干脆 `ok:true` 分支保持结构化（add/replace/remove/list/batch 各自字段），lossless 靠"条件挂载"纪律 + assertLossless 单测兜底（BR-05 的真实执行点在 pipeline.ts:637-641 snapshotToolValue，与 schema 形态无关，方案 R-1 的担心可以放下——undefined 字段问题在 JSON snapshot 层爆，不在 TS 层）。`MemoryEntry.chars/createdAt`、`RecallFact.factType` 与基线 client 返回字段一一对得上 ✓。
4. **`ToolDefinition<HindsightConfig…>` 泛型不存在**：contracts.ts:27 的 ToolDefinition 无泛型参数，§2.1.3 笔误，改为 `ToolDefinition`。
5. **工具 timeoutMs 语义变化**：基线工具定义带 `timeoutMs: max(retainTimeoutMs, timeoutMs)+5000`（tools.js:150）；仓库该字段是 cooperative budget，由 `dsh-tool-call-timeout-policy` wrapper 执行（contracts.ts:64-70），且 execute 必须转发 exec.signal——基线 store/client 已透传 signal ✓，保留即可，但注意 defineTool 会对非正数抛错（schema.ts:575）。
6. **output.render 签名**：`render(args, value): ContentBlock[]` ✓ 同名机制存在（contracts.ts:17-24）；基线 render 返回 `[{type:'text'}]` 兼容。`output.schema` 会被注册时 `assertSupportedJsonSchema` 强校验（index.ts:136）——基线 output schema 用了 `properties.usage.properties.chars.type:"integer"` 等纯子集语法 ✓ 能过；parameters 侧的 `minimum/maximum`（recallTokens 边界）**不在受支持关键词表**（json-schema.ts:76-88），raw parameters 虽无注册期校验（见假设表 A），但 `defineTool` 路径会拒——这是 D2 维持 raw JSON Schema 的一个加分论据。
7. **auto-review 式 lint override 不要用**：若最终保留某处 deprecated 读取，需像 packages/experimental/auto-review/src/index.ts:412 那样带 justification 注释——但 D5 的监听方案更好，优先不改。
8. **e2e/integration.mjs 保留形态**：`tests/**/*.spec.ts` 才会被 vitest include 收集（vitest.config.ts:137-141）；integration.mjs 若要进 CI 需改造为 `*.e2e.ts` 并 self-skip（无 Hindsight 环境变量时 skip，仿 DEEPSEEK_API_KEY 模式，docs/testing.md:11），否则只能留在本地验收脚本——方案 D7 表述"可选 e2e"可行，但别指望 `pnpm run test` 自动跑它。
9. **升级冲突**：用户现有 profile 里旧 bundle 以 `link:/Volumes/data/project/hindsight-memory` 安装、patch insert id 为 `hindsight-memory`；新包 bundle patch 若沿用同一 insert id，plugin_manager 升级到仓库包时 composeEntries 的同 id 行会静默替换（optional-bundles.spec.ts:127-131 防的就是这个）。README 升级小节应写明"先 remove_bundle 旧 hindsight-memory 再装新包"。
10. **`memory`/`memory_recall`/`memory_retain` 工具名**：全仓 grep 无占用 ✓（内置记忆体系叫 storage/settings，无冲突）；`/memory` 命令名亦无冲突（既有仅 /feedback /compact /goal）。

## 假设核验表

| 项 | 方案声称 | 实际代码事实 | 判定 |
|---|---|---|---|
| A 工具契约 | D2：cordis ToolDefinition.parameters 接受手写 JSON Schema，原样迁移；output.render/schema 保留；execute(args, exec) 取 exec.signal | `ToolSchema.parameters: Record<string, unknown>`（llm/src/types.ts:522-531）；ToolsService.register 只强校验 output（`assertSupportedJsonSchema(output.schema)`，core/tools/src/index.ts:127-136），parameters 无注册期校验，raw schema 工具自行验参（docs/cookbook/adding-a-tool.md:"Raw JSON-Schema tools registered directly own their input validation"）；先例① mcp-client createMcpToolDefinition 直传 server inputSchema（packages/mcp/mcp-client/src/tools.ts:260）② cua 用 z.toJSONSchema 产物做 parameters（experimental/cua/src/index.ts:306）；exec=ToolRunContext 含 signal ✓（contracts.ts:245,202）；但官方 experimental 工具主流（tool-terminal/tool-session-query/terminal-panel 等 57 处）走 `defineTool` DSL，且 defineTool 拒绝 minimum/maximum 这类不支持关键词——基线 recall 工具的 `max_tokens:{minimum:1,maximum:8000}` 恰好在 DSL 门外，D2 选 raw 迁移成立且**必要**（配合 execute 内手工校验，方案未明说这半句，T4 补上） | △→✓（结论对，理由需补"parameters 不受注册校验+必须自带验参"） |
| B pre-step payload/注入持久化 | payload.step/turn/agent/signal ✓；decision.kind==='enter'、messages 追加一条带 source.kind/form 的 user 消息即合规平移 | 事件签名 `payload:{agent,messages,turn,step,signal,modelSelection}`、`PreStepDecision={kind:'reject'}|{kind:'enter',messages,startsRequestSeries?}` ✓（core/agent/src/runtime-types.ts:139-146,351）；waterfall 先 await next() ✓（docs/architecture.md:108）；enter batch 由 loop append 成 durable `user/message` ✓（agent.ts:469-479），做法本身合规（time-context/hooks-claude-code/action-cards 同构）。**但**消息形状不合规：form:'snapshot' 强制 sections（llm/src/message.ts:91-95）、kind 须经 MessageSourceMap 声明合并、必须 createUserMessage/freezeMessage（Agent Note 2026-07-28）、V4 准入拒 retired plugin wrapper 并要求 producer-owned kind（session-format-v3-to-v4/src/message-sources.ts:6-12）；startsRequestSeries 展开保留 ✓ | ✗（P0-1） |
| C session/event 监听 | `(session, event)`，assistant/message payload data.turn/data.message | 签名 `'session/event'(this, session: Session, event: SessionEvent)`（core/session/src/index.ts:79）；`'assistant/message': {turn, step, message, stream, usage?, interrupted?}`（session/src/types.ts:349-357）；turn/end `{turn, reason}` ✓；先例 claude-code-mods/src/index.ts:453-480 与 D5 监听累计写法完全同构 | ✓ |
| D commands | `ctx.get('commands')` 可选访问；CommandInvocation.rawInput/signal；CommandDefinition/input/handler→CommandResult | Service key name='commands'（interaction/commands/src/index.ts:28）；ctx.get 先例 host-ops.ts:298 ✓；rawInput:string（:47）、signal:AbortSignal（:58）✓；input.hint 必填非空 string、attachments boolean（:192-204）✓；CommandResult success/error+text ✓（types.ts:34-38）；§2.3.4 "CommandInfo{kind:'text'}" 不存在 ✗（笔误，P1-2b） | △ |
| E 包工程模板 | 对齐 sdd-workbench；apps/cli 依赖+OPTIONAL/EXPERIMENTAL_BUNDLES+EXCEPTIONS+tsconfig.host 引用 | EXCEPTIONS 格式 ✓；但模板应参照 terminal-bundle（bundle 三要素 dsh.bundle.patch/icon/locale export，verify-default-product-isolation.ts:88-102；sdd-workbench 非 bundle 无这些字段）；icon 必须 36×36（verify-package-meta.ts:88）旧图不合规；还漏 gen-config-catalog 再生成、tsconfig.base paths 生成器、tool-catalog 判定依据三项（P1-1）；peerDependencies cordis `workspace:~` ✓（AGENTS.md + terminal-bundle 实例），dsh-* 运行时边是 dependencies `workspace:*` 还是 peer+dev 由 verify-package-dependencies 按导出共享判定，照抄 terminal-bundle 段即可 | △ |
| F vitest 收集与覆盖门禁 | tests/*.spec.ts 自动收集；src 逐文件 100% | include=`packages/*/*/tests/**/*.spec.{ts,tsx}` ✓（vitest.config.ts:137-141）；coverage include `packages/*/*/src/**` + perFile 100% ✓（:266,阈值块）；豁免：`src/types.ts`、`src/bin.ts`、`src/worker.ts` 排除（:270-273）→ 方案 types.ts 纯类型 ✓ 无需测试；`lib/index` 入口不在 src 计数内，src/index.ts 本体**不豁免**，index.spec.ts 必须把它打到 100%（v8 ignore 需理由，docs/testing.md）；experimental 包不在任何 coverage exclude 名单（除 webworker-runtime 个案）→ NFR-03 成立 | ✓ |
| G 全局 fetch/AbortSignal | engines>=24.9 下 AbortSignal.timeout/any 可用 | 根 package.json engines node>=24.9.0 ✓；本机 Node 26 实测二者 function ✓；仓库自身已用 AbortSignal.any（mcp-client/src/connection.ts:357）；基线 combineSignals 的手动兜底分支在 >=24.9 下永不可达 → 100% 分支覆盖反而测不了，TS 化时应删除 fallback（保留主路径） | ✓（附删码建议） |
| H 过度设计 | 减法检查已做（无 Remote/UI/typert/storage-service） | 减法结论认可 ✓；反向问题更多：types.ts StoreResult 真分支过宽（P2-3）、normalizeConfig 双轨校验冗余（P1-3）、combineSignals 死分支（G）、CommandInfo 幻影类型（P1-2b）、"19 键"应为 18（P1-3）；D5 弃投影的判断需要复议（P1-4）——那是"看起来省、实际欠"的方向 | △ |

**Review 索引回应**：R-1 lossless 执行点在 snapshotToolValue（pipeline.ts:637-641），TS 判别联合帮不上忙，条件挂载+回归单测即可；R-2 D5 监听方案与 claude-code-mods 先例同构 ✓，但补 P1-4 的 resume 场景；R-3 abort 传播基线已透传 signal ✓；R-4 zod 冲突预案低估了 raw 路线的合法性（A 项），真正的冲突在 output.schema 受注册校验而 parameters 不受——现方案方向反了，实际约束宽松。


---

## 复评记录（主编排者，2026-11-20）

| 发现 | 处置 | 落点 |
|---|---|---|
| P0-1 消息形状 | 采纳：MessageSourceMap declare module 合并两 kind；快照 form:'snapshot'+sections、召回/nudge form:'notice'+summary；一律 createUserMessage | 设计 D1a/§2.3.1 |
| P0-1 之"通道违规"子项 | **部分驳回**：核实 agent.ts:469-479 后确认 enter batch→durable user/message 成立，pre-step 直改 decision.messages 是官方插件通行做法（time-context 等），非缺陷；保留的修复是形状与去重 | 设计 D1b 改写 |
| P1-1 T1 清单漏项 | 采纳：模板改 terminal-bundle、icon 36×36 重画、gen-config-catalog/gen-tsconfig-paths 入 T1/T6、tool-catalog 判定依据记录、升级指引写入 README | T1/T6 |
| P1-2 commands 写法 | 采纳：disposer 挂 ctx.effect；删"CommandInfo"幻影类型笔误 | §2.3.1/§2.3.4 |
| P1-3 normalizeConfig 双轨 | 采纳：删类型回退分支（Loader fail loud），combineSignals 死分支删除；DEFAULTS 计数更正 18 | §2.1.1/D6 |
| P1-4 resume/HMR 重复注入 | 采纳 (a)：sessionProjections unit fold 事件流做持久去重 + per-turn 文本缓存 + retainedTurns；D4 重写 | D4/§2.3.1 |
| P2-1..10 | 全部采纳为实现期注意项（StoreResult 结构化分支、ToolDefinition 去泛型、timeoutMs cooperative 说明、e2e self-skip、旧 bundle 冲突指引、工具名无冲突结论留档） | 各节 |

**复评结论：通过**。修订后的设计可直接进入测试规划与实现。
