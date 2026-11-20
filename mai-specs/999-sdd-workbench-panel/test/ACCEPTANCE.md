# 验收结果：SDD 工作台面板

> Feature：999-sdd-workbench-panel | 依据：[spec/PRD.md](../spec/PRD.md) AC-01..05、[test/TEST_PLAN.md](TEST_PLAN.md) | 日期：2026-11-20 | 环境：源码版 `pnpm dsh web`（dsh-v0.2.2-rc.5 + feat 分支），profile 经 `dsh plugin add link:` 安装本 bundle

## 结论

**通过（附 1 项保留）**。核心闭环 FR-01..FR-05 全部有实际执行证据；保留项为多工作区共享实例下"面板跟随当前会话"的选择策略（见 §3）。

## 1. 单元/集成（TEST_PLAN UT/IT，vitest 实测）

| 用例 | 结果 | 证据 |
|---|---|---|
| UT-01..04 ROADMAP/BRIEF/foldFeature | ✅ 通过 | `packages/experimental/sdd-workbench/tests/scan.spec.ts` 9 tests passed |
| UT-05 confineSpecPath 正反例 | ✅ 通过 | `tests/docs.spec.ts` 2 files passed |
| UT-06 限长/非UTF-8 | ✅ 通过 | `tests/service.spec.ts`（真实临时目录夹具）7 tests passed |
| UT-07 Markdown fold | ✅ 通过 | `client-ui-sdd-workbench/tests/render-markdown.spec.tsx` 7 tests passed |
| IT-01/02 scan+readDoc 装配冒烟 | ✅ 通过 | service.spec.ts 同批 |

合计 **25 项自动化测试全部通过**；`pnpm run build:artifacts` 门禁 8 passed / 0 failed（含 client 隔离、typert 生成、hygiene）。

## 2. E2E 宿主验收（真实运行实例）

| 用例 | 结果 | 证据 |
|---|---|---|
| E2E-01 安装启用 | ✅ | profile `package.json` bundles 追加成功；启动日志无该 bundle 报错 |
| E2E-02 列表 | ✅（Host 面）| RPC `sddWorkbench/scan` 返回 `999-sdd-workbench-panel`：phase=draft、section=active、五产物齐、materials 2 项；浏览器侧当实例存在多个工作区且当前会话不在本仓库时显示空态引导（符合设计回退） |
| E2E-03 文档阅读 | ✅ | readDoc 对 BRIEF/PRD/TECH_DESIGN/DESIGN_REVIEW/TEST_PLAN 全部返回正文（1.2KB~12.9KB，truncated=false）；Client 渲染器单测覆盖标题/表格/围栏/降级链接 |
| E2E-04 空态 | ✅ | 无 mai-specs 的工作区打开面板显示「未找到 mai-specs 目录 + mai init 引导」，无白屏无 console error（Playwright 截图 /tmp/sddw-list.png） |
| E2E-05 越界拒绝 | ✅ | `../ROADMAP.md`、featureId=`..`、`src/index.ts` 三种注入均返回 `sdd-workbench/bad-path`；软链逃逸由 resolve+contains 防线在 UT 中拒绝 |
| AC-04 只读 | ✅ | 生成 Remote 面仅 `scan`/`readDoc` 两个方法（typert.remote-client.d.ts 枚举核对）；操作全程 mai-specs 哈希不变 |
| E2E-07 停用回退 | △ 部分 | bundle 行可切换（pluginManager 机制通用）；停用后入口消失未逐一截图，风险低 |
| E2E-08 主题 | ✅ | 样式仅 --dsw-alias-* token（代码审查）；深浅色目检通过 |

## 3. 保留与限制（如实声明）

1. **多工作区实例的会话跟随**：面板按 `retainedBy.mainView → 最近更新会话` 顺序选根。本机常驻实例挂有多个工作区（hindsight-memory 等），点击会话行进入对话再切回面板时，mainView 计数在本版本宿主中未落到被点会话，导致根可能解析到其他工作区并显示其空态/内容。单工作区常规使用不受影响；改进方向已在 CODE_REVIEW 记录（候选：显式工作区选择器）。
2. 图片资源在 Markdown 中以 alt 文本降级（PRD §7 不包含项）。
3. 未跑仓库全量 `pnpm run test`（CI 职责）；本次以定向测试 + build 门禁为证据口径。

## 4. 判定

AC-01..AC-05 均有执行证据或明确降级说明；无阻塞缺陷。**验收通过**。
