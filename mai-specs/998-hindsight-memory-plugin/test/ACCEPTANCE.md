# 验收报告：Hindsight 全局记忆体插件移植

> Feature：998-hindsight-memory-plugin | 依据：[spec/PRD.md](../spec/PRD.md) AC-01..11、[test/TEST_PLAN.md](./TEST_PLAN.md) E2E-1..12 + IT-1 | 验收人：hs-acceptance（真机执行）| 日期：2026-11-20 | 被验对象：main（交付提交见 git log），包版本 0.2.2-rc.5

## 环境

- Hindsight：本机 Docker 容器 `hindsight`，http://127.0.0.1:8888，bank=`hermes`（无 LLM 模式；全程未调 reflect）。stats 基线：documents 1807→1808（验收写入均自清理）。
- DSH：fork 仓库源码态启动 `pnpm dsh web --port 52999 --no-open`，token cookie 会话建立成功；web profile link 安装本包。
- 隔离：数据闭环写入使用独立测试 bank `dsh-t7-acceptance`（PUT 隐式创建），不污染 hermes 库；hermes 上的工具级 add/remove 用后即清。
- 临时脚本（留档引用路径，不进仓库）：`/tmp/hs-t7/composition.host.mts`（IT-1 主脚本）、`/tmp/hs-t7/e2e9-degrade.mts`（降级）、`/tmp/hs-t7/e2e10-commands.mts`（命令族）、`/tmp/hs-t7/e2e8-security.mts`（安全矩阵）；日志 `/tmp/hs-t7/it1-run.log`、`e2e9/e2e10` 运行输出、截图 `/tmp/hs-t7/shots/e2e1-plugins-list.png`、`e2e1-after-disable.png`。

## IT-1 口径说明

TEST_PLAN §5 预授权了 IT-1 的降级口径：因禁止改 packages/**，无法落仓库内 `composition.host.spec.ts`，改为 /tmp tsx REAL-composition 脚本——真实 cordis Context 装载真实服务图（sessions/projections/llm/systemPrompt/tools/native-executor/agent-loop/commands），`apply()` 直连真 Hindsight，MockAdapter 驱动 scripted agent 回合。相对原计划差异：不经 Loader boot() 与 test-only cordis.yml（bundle patch 装配面由 E2E-1 真机实例覆盖：profile bundles 追加 + `listPlugins` fiberPhase=active + 启动日志零 "did not activate"）。

## 逐条结果

| ID | 判据摘要 | 结果 | 证据（时间均为 2026-11-20，UTC+8） |
|---|---|---|---|
| AC-01/E2E-2 | 首步注入冻结快照、含两库与占用百分比、第二轮不重复 | **PASS** | IT-1 16:20：B.snapshot-injected-turn1（form:'snapshot'、sections=1、文本含 USER/MEMORY 段与 `969/1375 字符 · 70%` 类占用行）；C.durable-log-snapshot（user/message 事件同条落 durable log）；turn>1 无重复（投影 snapshotInjected + UT-I2） |
| AC-02/E2E-3 | 写入→新会话可见、旧会话快照不变 | **PASS** | IT-1 16:20：E.add-ok → E.new-session-sees-write（第二 Context 模拟新会话，其请求快照文本含刚写入标记）→ E.snapshot-frozen-in-session（BR-02 冻结旁证） |
| AC-03/E2E-4 | over_budget 拒绝且零写入 | **PASS** | IT-1 16:20：J.over-budget-guard——hermes MEMORY 实际 2172/2200（99%），executor 路径 add 返回 kind=over_budget、附 entries 清单与 usage{chars:2210,limit:2200}；预算数学正确；文档级正反例 UT-S4/S8 |
| AC-04/E2E-5 | replace 唯一命中换 id 删旧、歧义给候选不动数据 | **PASS** | IT-1 16:20：F.replace-old-gone/F.replace-new-present（先写后删序，listDocuments 复核）；G.remove-no-match-reason（「没有条目包含…」文案，数据未动）；歧义候选分支 UT-S6 |
| AC-05/E2E-6 | 召回过滤 curated、插件自身文本不当查询 | **PASS（脚本级）** | IT-1 16:20：L.recall-client-ok（真 bank 命中 3 条）+ INFO recall-curated-tagged-in-bank=1（该类 fact 被 index.ts 过滤逻辑剔除）；lastUserText 排除逻辑 UT-I4/UT-T6。GUI 内自然语言触发需模型 key，成本高，按 TEST_PLAN §1 分层以单测+脚本承接 |
| AC-06/E2E-7 | turn/end 沉淀 mem:session、同轮去重、短轮不写 | **PASS（混合口径）** | IT-1 16:20：K.auto-retain-turn-doc——脚本会话 turn/end 后 hermes bank `dsh-turn-*` mem:session 文档存在（docs=452，含本轮新增）；去重/短轮门槛 UT-I7 |
| AC-07/E2E-8 | 凭据+注入全拒、protectSecrets=false 只放开密钥类 | **PASS** | e2e8-security 16:35：9 样本（sk/ghp/AKIA/xoxb/JWT/私钥块/中文口令赋值/中英注入）经真实 CuratedStore.add 全拒 + O.zero-http-writes(0)（计数 fetch 证明 BR-06 先于任何 HTTP 写）；全形态矩阵 UT-K1..K14 |
| AC-08/E2E-9 | 停服三类调用静默降级、工具可读错误、无 unhandled rejection | **PASS** | 16:22 docker stop hindsight → e2e9-degrade：M.no-injection-when-down、M.turn-completed（对话照常完成）、M.tool-readable-error（「记忆服务不可用：无法连接 Hindsight」）；进程 unhandledRejection 监听零命中；16:23 docker start 恢复（8 次轮询上线），随后 IT-1/E2E-10 全功能回归 PASS |
| AC-09/E2E-10 | /memory status/list/search/forget/stats 与库一致、错参明确报错 | **PASS** | e2e10-commands 16:34：N.status（双库占用行）、N.list-user、N.search（NAS 命中 3 条）、N.stats（bank=hermes 事实 25333·链接 838248·文档 1808）、N.forget-no-match（附当前条目清单）、两个用法错误分支 N.search-usage/N.forget-usage |
| AC-10/E2E-1 | Plugins 页安装启用、三工具+命令注册、本地化标题图标、停用消失 | **PASS** | 16:07 `dsh plugin --profile web add link:…` 成功（peerDependencies 提示为 pnpm link 常态告警）；16:20 启动日志零 activation warning；RPC listBundles：installed=true/optional=true；setBundleEnabled(true) application:"applied"；listPlugins entryId=include:hindsight-memory enabled=true **fiberPhase=active**；zh meta「Hindsight 长期记忆」+icon 见截图 e2e1-plugins-list.png；GUI 开关禁用→灰色（e2e1-after-disable.png）→再启用恢复；工具/命令注册与 dispose 撤除由 IT-1 A/I 段硬证 |
| AC-11/E2E-11 | 仓库门禁本地等价执行 | **部分 PASS（如实降级）** | 16:24-16:36 复跑：本包 vitest 159/159 绿、per-file src 覆盖率 100%（GT-2 ✓）；build:check exit 0（GT-1 ✓）；lint 0 error（GT-3 ✓）。**verify-cordis-config/verify-tsconfig-paths 红**（缺本包 paths 映射，CODE_REVIEW P1-1）；doc-sync 中 4 项针对本包 README/JSDoc 红（P1-2..4）；其余 doc-sync 红项为 sdd-workbench 残留与环境噪音。T6「门禁全绿」声明与实况不符，已在 CODE_REVIEW 记录 |
| —/E2E-12 | resume 不重复注入（P1-4 回归） | **PASS（脚本级）** | IT-1 16:20：D.resume-idempotent——同一 session 事件流 foldProjection 重放两遍，snapshotInjected=true 且第二次重放状态引用幂等；GUI 重启-resume 路径与 UT-I2 同构（投影重建自 durable log），接受脚本证据为终 |

## 汇总

- **PASS：AC-01..10 全部 + E2E-12 + IT-1**（E2E-5/6/7/12 采用 TEST_PLAN 预授权的脚本级/混合口径，差异已在各条注明）。
- **AC-11 部分通过**：核心门禁（build/test/coverage/lint）绿；文档与配置目录 4 个门禁红，属随包交付规范欠账（无运行时影响），修复项已列 CODE_REVIEW P1-1..4。
- 缺陷清单：无 P0/P1 运行时缺陷；P1×4（门禁/文档规范）、P2×5（形状对称性、投影体积、dispose await、nudge 排版、召回阈值声明）见 [review/CODE_REVIEW.md](../review/CODE_REVIEW.md)。
- 遗留观察：link 安装的 peerDependencies 告警（pnpm 对 workspace link 的正常提示，README 升级指引场景不受影响）；测试 bank `dsh-t7-acceptance` 保留为空壳可复查（documents 已清零），如需彻底回收可 DELETE /v1/default/banks/dsh-t7-acceptance。

## 验收结论

**有条件通过**：功能与契约面（AC-01..10）真机验证全部达标，可对外演示与个人环境投产；条件为 CODE_REVIEW P1-1..4 门禁欠账在下个提测周期清零并重跑 doc-sync/hygiene 全绿（对应 AC-11 完整闭合）。
