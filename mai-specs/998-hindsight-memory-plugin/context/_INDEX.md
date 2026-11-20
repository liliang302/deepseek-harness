# 素材索引 — 998

| 文件 | 类型 | 来源与原名 | 关键内容摘要 | 收集日期 | 派生自 |
|---|---|---|---|---|---|
| [hindsight-memory-README.md](./hindsight-memory-README.md) | md | hindsight-memory v0.2.0 插件 README（个人工作区原件） | 能力总览：USER/MEMORY 双库、字符预算、冻结快照、语义召回、nudge、turn-end 沉淀、memory/recall/retain 工具、/memory 命令、安全拦截与降级策略；含 Hermes 对应关系与存储模型 | 2026-11-20 | — |
| [RESEARCH.md](./RESEARCH.md) | md | 机制调研笔记（原件） | Hindsight API 实测事实（documents/recall/retain 端点、tags_match=all_strict、重复参数、PATCH 不能改正文）与两个已修缺陷（lossless JSON undefined 字段、ESM 热重载不驱逐 lib 子模块） | 2026-11-20 | — |
| [VERIFICATION.md](./VERIFICATION.md) | md | v0.2.0 验证记录（原件） | L0–J 十组用例矩阵与 2026-10-19 执行结果：多数 PASS，G1/H2/I1 SKIP；附录 A 三轮缺陷闭环 | 2026-11-20 | — |
| [DESIGN-curation-loop.md](./DESIGN-curation-loop.md) | md | v0.3 纠错闭环设计草案（原件） | 召回账本+三个新工具+异步审计回路；本次交付范围外，仅作背景 | 2026-11-20 | — |
| [cordis.patch.yml](./cordis.patch.yml) | yml | 现有 bundle patch（原件） | insert hindsight-memory 行 + 全量 config 注释（url/bank/预算/开关/超时/tags） | 2026-11-20 | — |
| [package.json](./package.json) | json | 现有包清单（原件） | name=hindsight-memory, private, ESM, dsh.bundle.patch, exports/files | 2026-11-20 | — |
| [作业说明.md](./%E4%BD%9C%E4%B8%9A%E8%AF%B4%E6%98%8E.md) | md | 课程作业要求全文 | fork DSH 跑起来 + my-ai-infra SDD 流程完成插件 + mai-specs 过程产物随代码提交 + README 作业入口；质量要求：命令可跑通、过程文档符合 SDD 规范 | 2026-11-20 | — |

## 关键发现

- 用户澄清：作业内容 = hindsight 记忆体插件（既有个人插件移植），不是上一轮的 SDD 工作台面板；后者保留在 feat/sdd-workbench-plugin 分支作附加成果
- 插件现为纯 JS（index.js + lib/*.js 约 1000 行）、无 git、零第三方依赖；移植需 TS 化以满足仓库 strict/tsconfig/门禁
- 集成测试真连本机 Hindsight(127.0.0.1:8888, bank=hermes)；进仓库后需 mock 化单测 + e2e 分层
- 默认配置 url/bank 是个人环境值，产品化需显式配置语义
- 官方注册路径参照 999 案例：apps/cli 依赖 + official-bundles OPTIONAL_BUNDLES/EXPERIMENTAL_BUNDLES + 包内 cordis.patch.yml
- 实验包命名走 EXPERIMENTAL_PACKAGE_NAME_EXCEPTIONS 无前缀名（@deepseek-ai/dsh-hindsight-memory）

## 开放问题

- fail-loud vs 运行时静默降级的取舍——PRD/设计阶段定案（倾向：配置校验前置 fail-loud，运行期不可达降级）
- v0.3 curation-loop 是否纳入本次范围——建议排除，单独 Feature 编号

## 补充归档（初始化后追加）

- `baseline/`：移植基线源码快照（index.js、lib/*.js、tests/*），来自个人工作区 hindsight-memory v0.2.0（无 git，原件路径 /Volumes/data/project/hindsight-memory）。作为实现阶段的对照真源；正式实现以 TS 重写进 packages/experimental/hindsight-memory。
