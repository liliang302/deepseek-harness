# 素材索引 — 999

| 文件 | 类型 | 来源与原名 | 关键内容摘要 | 收集日期 | 派生自 |
|---|---|---|---|---|---|
| [作业一：用 my-ai-infra SDD 为 DSH 开发一个插件.md](./%E4%BD%9C%E4%B8%9A%E4%B8%80%EF%BC%9A%E7%94%A8%20my-ai-infra%20SDD%20%E4%B8%BA%20DSH%20%E5%BC%80%E5%8F%91%E4%B8%80%E4%B8%AA%E6%8F%92%E4%BB%B6.md) | md | 课程作业说明（用户提供） | 作业要求：fork DSH 官方仓库、本地跑起来，用 my-ai-infra SDD 流程完成一个能在 DSH 运行的插件；保留 mai-specs 过程产物随代码提交；README 提供作业入口。质量要求：命令可跑通 + 过程文档符合 SDD 规范。 | 2026-11-20 | — |

## 关键发现

- 本机已安装 DSH Desktop 0.2.2-rc.5，源码基线 tag dsh-v0.2.2-rc.5 与其一致
- DSH 插件=bundle（package.json dsh.bundle.patch + cordis.patch.yml + Host index.js + Client client.js），经 plugin_manager install_bundle 装入 profile
- my-ai-infra SDD 产物集中在 mai-specs/NNN-slug/：BRIEF.md、PRD.md、TECH_DESIGN(.md/.html)、REVIEW_*、TEST_PLAN、验收结果；ROADMAP.md 汇总状态
- 用户选题确认：SDD 工作台面板（Feature 导航 + 规格文档查看），呼应作业选题建议

## 开放问题

- 面板数据源目录是否应可配置（默认工作区根下 mai-specs/）——PRD 阶段明确
- Markdown 渲染深度（原文视图 vs 富渲染）——设计阶段按 MVP 取舍
