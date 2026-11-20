# 方案评审报告：SDD 工作台面板

> 评审对象：design/TECH_DESIGN.md（状态：待评审） | 评审人：liliang302（主 Agent 自评；委派的独立评审子任务中途失败未产出，本报告为按 my-review-design 流程由主编排者自行完成的同标准评审，特此说明） | 日期：2026-11-20

## 总体结论

**有条件通过**：问题定义准确、复用路径选择正确、复杂度克制（MVP 达标）；开工前须修正 2 个 P0（Remote 类型接线缺环、Client 注入名机制误写），均有低成本解法。

## 阻塞问题（P0，必须修复才能开工）

### P0-1 Remote 命名空间的 Client 类型面依赖 typert 代码生成，设计未提及包的生成接入

方案 §2.1.3 声称"Host 包内 declare module 扩展 Remote 命名空间表"。**实际机制不同**：`ctx.remote.<namespace>` 的类型来自构建期生成的 `lib/typert.remote-client.d.ts`（tsdown 插件 `typertPlugin` 扫描带 `@Remote` 的 `TypertRemoteService` 自动生成），经包导出映射 `"./remote"` 暴露；消费方以 `import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'` 合并进 `ClientRemote` 接口（先例：`packages/api/workspace-files/src/client/remote.ts:7`、`packages/api/gateway/src/client/index.ts:103`）。

**修复**：T1/T4 增加——sdd-workbench 包 package.json 声明 `./remote`、`./typert` 导出与对应 files 条目（照抄 `packages/experimental/api-speech-to-text/package.json` 的 exports/files 段）；Client 包源码 import type 该 `/remote` 子路径。手写 declare module 不再需要。

### P0-2 Client `inject` 数组里的 `'remote.sddWorkbench'` 不是合法服务名

§2.3.2 写 `inject=[...,'remote','remote.sddWorkbench',...]`。Cordis inject 是服务键列表，`remote.workspaceFiles` 这类名字并不存在为可注入服务（workspaceFiles 的 client 半边实际只注入 `'remote'`，见 `packages/client/ui-sidebar-documentpreview/src/client/index.ts:85` 的对照——其列出的 `remote.workspaceFiles` 属历史遗留写法，不能推广依赖）。

**修复**：Client 包 `inject = ['slots','locale','remote','sessions','uiSession','layout']`；类型面靠 P0-1 的 `/remote` import 解决。若 `layout` 在 web composition 中缺失会导致整行不激活，需保留但用 `ctx.inject([...])` 可选化或直接验证（实现时 T5 首步验证）。

## 重要建议（P1）

1. **可见性清单遗漏**：仅加 `OPTIONAL_BUNDLES` 不够——bundle 要出现在 Plugins 主页而非 More，需同步 `packages/util/official-bundles/src/plugin-manager.ts` 的 `MORE_BUNDLES`/`EXPERIMENTAL_BUNDLES` 集合决策（建议进 EXPERIMENTAL 徽章 + 不进 MORE，即主列表 Experimental 区）。T7 文件清单补上此文件。
2. **owner 之外的访问策略**：`remote-access` 对非 owner principal 默认拒绝（`NO_ALLOW`，packages/api/remote-access/src/index.ts:46），本 MVP 只服务 owner 浏览器，无需注册 policy；在设计 §4 风险处显式记录"多 Peer 共享部署下非 owner 不可见"这一已知边界，避免验收时被当缺陷。
3. **scan 的 sessionId 语义统一**：`readDoc` 与 `scan` 都以 `sessionId: string | null` 传（已修订），但 UI 切 Session 时的重新 scan 应 debounce 或忽略过期响应（AbortSignal 足够），T5 落实。
4. **BRIEF Phase 解析脆弱点**：Phase 取自两列元数据表的正则应容忍值两侧反引号/空格；解析失败置 null 显示"—"（BR-03 一致），单测夹具覆盖畸形 BRIEF。

## 次要观察（P2）

- `confineSpecPath` 示例代码中 `segments.length===1 ? segments[0] : segments[0]` 是无意义三元，实现时删。
- 渲染器把链接降级为纯文本+title 的选择合理（免 CSP 面），但 PRD FR-04 文案要同步说明，防止验收口径漂移。
- icon.svg 手绘即可，注意 ≤256 KiB、路径不出包（host-plugin 检查单）。
- ROADMAP 分区标题匹配用精确字符串（规划中/进行中/已完成），my-ai-infra 若改词只坏 roadmapSection 字段，可接受。

## 假设核验表

| # | 方案声称 | 实际代码事实 | 结论 |
|---|---|---|---|
| A1 | `main` slot + key cast MainPanelId 可挂全局面板 | ui-plugin-manager/src/client/index.ts:129-137（`key: PANEL_ID`，`'plugins' as MainPanelId`） | ✓ |
| A2 | `sidebar.panellist` 注册侧边栏入口 | 同上 L167-173（id/order/label/locale + 图标组件） | ✓ |
| A3 | TypertRemoteService 构造即注册并绑定 wire namespace | typert/protocol/src/index.ts:250-262（super(ctx,key) → provide；bindTypertRemote） | ✓ |
| A4 | Host 根解析 `header.cwd ?? sandboxPolicy.workspaceRoot` | api/workspace-files/src/index.ts:223-231；sandbox-policy/src/index.ts:164（无配置回退 process.cwd()） | ✓ |
| A5 | 无 Session 时 adapter.current.key 为 undefined | ui-session/src/client/index.ts materializeAbsent `{ key: undefined }`；ui-sidebar-right/src/client/index.ts:119-120 同款消费 | ✓ |
| A6 | ctx.fs 具备 listDir/readText/readByteRange/resolve/stat/contains | fs/fs/src/index.ts:269, 222, 245, 149, 198, 190 | ✓ |
| A7 | tsdown.client preset 支持 CSS Modules + react external | packages/client/tsdown.client.ts 头注释（virtual css loader、PRELOADED_CLIENT_EXTERNALS） | ✓ |
| A8 | experimental 包不受 client bundle 隔离门禁 | tsdown.client.ts `clientInputIsolation`：`if (experimental) return` | ✓ |
| A9 | OPTIONAL_BUNDLES 要求 patch+icon+locale 显示元数据 | util/official-bundles/src/bundles.ts L46-53 注释 | ✓ |
| A10 | profile 安装的 bundle 若无 lib/client.js 会"响亮失败" | client/modules README："a missing bundle fails activation loudly with one build instruction" | ✓（故 T7 workspace 接入是正确解法） |
| A11 | Client 类型面 = declare module 手写 | 实为 typert 生成物 `/remote` 子路径 + `import type {}` 合并 | ✗ → P0-1 |
| A12 | inject 可写 `remote.sddWorkbench` | Cordis inject 只认服务键；remote 命名空间挂在 `remote` 服务实例上 | ✗ → P0-2 |

## 减法检查结论

移除以下设计后 AC 仍可满足，确认不做：投影缓存/wire.view（面板数据非会话派生）、多工作区聚合、文档搜索、编辑能力。当前包数量（2 包 + 1 patch）已是官方 voice-input 先例的最小形态，未见过度设计。
