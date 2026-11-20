# 999: SDD 工作台面板

| 项 | 值 |
|---|---|
| Phase | done |
| Profile | standard |
| 优先级 | P1 |
| 负责人 | 待填 |
| 目标日期 | 待填 |
| 涉及子系统 | packages/plugin (新增 bundle), mai-specs (只读数据源) |

## 一句话描述

为 DSH 增加一个 Web 侧边栏插件页面：浏览 mai-specs Feature 列表、查看各阶段规格文档、展示评审与验收状态

## 背景

作业一要求用 my-ai-infra SDD 流程为 DSH 开发插件。my-ai-infra 的交付过程产物集中在项目 mai-specs/ 目录（BRIEF/PRD/TECH_DESIGN/评审记录/测试计划/验收结果），但缺少在 DSH 内的可视化入口；开发者需要在 DSH 会话中随时回看规格上下文，判断当前 Feature 处于哪个阶段、还缺哪些产物。

## 关键决策

- 插件形态：独立 bundle（Host 只读扫描服务 + Client Web 面板），不改 DSH 内核包；官方范例对照 `ui-plugin-manager`（`main` + `sidebar.panellist` slot）。
- 数据源：当前 Session 工作目录下的 `mai-specs/`，严格只读（BR-01/BR-02）。
- Markdown 渲染：自研轻量渲染器（标题/表格/代码块/列表/加粗链接文本），不引入第三方运行时依赖。
- 有效需求来源与 AC：[spec/PRD.md](spec/PRD.md)（FR-01..05、AC-01..05）。

## 阶段记录

| 阶段 | 选择 | 产物 | 结果 |
|---|---|---|---|
| PRD | 执行（standard） | [spec/PRD.md](spec/PRD.md) | 完成，含 5 项 FR、5 项 AC |
| 技术设计 | 执行 | [design/TECH_DESIGN.md](design/TECH_DESIGN.md) | 完成（已确认） |
| 方案评审 | 执行 | [review/DESIGN_REVIEW.md](review/DESIGN_REVIEW.md) | 有条件通过；P0×2 已修订进设计 |
| 测试规划 | 执行 | [test/TEST_PLAN.md](test/TEST_PLAN.md) | 完成 |
| 编码实现 | 执行 | packages/experimental/{sdd-workbench, client-ui-sdd-workbench}/ | 完成；build:artifacts 8 passed、vitest 25 passed |
| 代码评审 | 执行 | [review/CODE_REVIEW.md](review/CODE_REVIEW.md) | 通过；P1×2 记录不阻塞 |
| 验收 | 执行 | [test/ACCEPTANCE.md](test/ACCEPTANCE.md) | 通过（保留项 1：多工作区实例会话跟随策略） |

## 上下文索引

- [素材索引](context/_INDEX.md)
