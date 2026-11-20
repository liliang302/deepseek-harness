# 998: Hindsight 全局记忆体插件

| 项 | 值 |
|---|---|
| Phase | draft |
| Profile | standard |
| 优先级 | P1 |
| 负责人 | liliang302 |
| 目标日期 | 待填 |
| 涉及子系统 | packages/experimental/hindsight-memory (新包), packages/util/official-bundles, apps/cli, mai-specs |

## 一句话描述

把用户已有的 hindsight-memory 插件（Hermes 式 USER/MEMORY 双库全局记忆，以自托管 Hindsight 为存储）按仓库规范移植为 DSH optional bundle：TS 化、注册清单、随包交付；并用 my-ai-infra SDD 流程完成设计、评审、实现与验收

## 背景

作业一要求用 my-ai-infra SDD 流程为 DSH 开发一个插件并随代码提交过程产物。用户选定 hindsight-memory 作为作业内容：该插件已在个人环境长期运行验证（VERIFICATION.md 有完整证据矩阵），能力覆盖会话冻结快照注入、逐轮语义召回、memory add/replace/remove/batch/list 工具、字符预算守卫、提示注入与凭据拦截、nudge 审查提醒、turn-end 对话沉淀与 /memory 人类命令。现状是独立 JS 工作区（无 git、无 TS、包名不带 scope），需移植进 fork 仓库成为规范的 experimental bundle。

## 关键决策

- 作业主体=hindsight-memory 插件移植（用户 2026-11-20 澄清）；上一轮 SDD 工作台面板保留在 feat/sdd-workbench-plugin 分支作附加成果。
- 有效需求来源与 AC：[spec/PRD.md](spec/PRD.md)（FR-01..09、CR-01/02、AC-01..11）。
- 移植形态：TS 重写进 packages/experimental/hindsight-memory（包名 @deepseek-ai/dsh-hindsight-memory，登记 EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS），能力平移不改语义；v0.3 纠错闭环排除在外。
- 测试分层：vitest mock-fetch 单测（100% 覆盖门禁）+ 真机 e2e 走查；旧 integration.mjs 的 assertLossless 回归保留。

## 阶段记录

| 阶段 | 选择 | 产物 | 结果 |
|---|---|---|---|
| PRD | 执行（standard） | [spec/PRD.md](spec/PRD.md) | 完成 |
| 技术设计 | 执行 | design/TECH_DESIGN.md | 进行中 |
| 方案评审 | 执行 | review/DESIGN_REVIEW.md | 待开始 |
| 测试规划 | 执行 | test/TEST_PLAN.md | 待开始 |
| 编码实现 | 执行 | packages/experimental/hindsight-memory/ | 待开始 |
| 代码评审 | 执行 | review/CODE_REVIEW.md | 待开始 |
| 验收 | 执行 | test/ACCEPTANCE.md | 待开始 |

## 上下文索引

- [素材索引](context/_INDEX.md)
