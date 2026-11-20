---
description: "以自托管 Hindsight 为存储的 DSH 全局长期记忆：USER/MEMORY curated 双库、会话快照、逐轮召回、安全拦截与自动沉淀。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-hindsight-memory

[English](README.md) | 中文

## 概述

插件把两个 curated 库——**USER**（用户是谁）与 **MEMORY**（工作环境）——存成自托管 [Hindsight](https://github.com/vectorize-io/hindsight) 服务里可逐条寻址的 document。每个会话首个模型步骤注入一条冻结快照（持久去重保证 resume/HMR 安全）；第二轮起按当前输入召回相关事实；模型通过 `memory` 工具在硬字符预算内管理条目；每个完成轮次原文沉淀为可检索的 `mem:session` 历史；凭据形态与提示注入文本在所有写入路径被拒。存储不可达时全程静默降级。人类侧有 `/memory status|list|search|forget|stats`。

## 目录

- [作业入口](#assignment-entry)
- [使用本包](#use-this-package)
- [配置](#configuration)
- [实现结构](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延后事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="assignment-entry"></a>

## 作业入口

- **插件用途**：本包即作业交付物——按 my-ai-infra SDD 流程移植进仓库的 hindsight-memory 记忆体插件（TS 化、符合仓库规范、optional bundle 注册）。
- **SDD 过程产物**：[`mai-specs/998-hindsight-memory-plugin/`](../../../mai-specs/998-hindsight-memory-plugin/)——BRIEF、PRD、TECH_DESIGN、DESIGN_REVIEW(+复评)、CODE_REVIEW、TEST_PLAN、ACCEPTANCE；索引见 [`mai-specs/ROADMAP.md`](../../../mai-specs/ROADMAP.md)。旧 JS 基线源码归档于该 Feature 的 `context/baseline/`。
- **主分支**：`main` 承载作业入口与完整交付物——本插件、SDD 过程产物与归档基线源码（另含更早的 SDD 工作台面板附加尝试）。特性分支：`feat/hindsight-memory-plugin`（本次工作）、`feat/sdd-workbench-plugin`（面板尝试）。

<a id="use-this-package"></a>

## 使用本包

在仓库根从源码运行：

```sh
pnpm install
pnpm run build
pnpm dsh web  # or: pnpm dsh desktop
```

安装插件：**插件** 页 → **添加插件** → 路径填 `packages/experimental/hindsight-memory` → 启用。或在终端（web profile 示例）：

```sh
pnpm dsh plugin --profile web add "link:$PWD/packages/experimental/hindsight-memory"
```

若此前以本地路径装过独立版 `hindsight-memory` bundle：先移除旧 bundle 再安装本包，避免同 id 的 patch 行被静默替换。

验证：开一个会话——上下文应带 `[Hindsight 长期记忆 · 会话快照]`；让助手用 `memory` 工具记一条内容，再开新会话确认快照包含它。Hindsight 不可达时插件静默降级。

<a id="configuration"></a>

## 配置

表内键在插件加载时由 Loader schema 校验（`cordis.patch.yml`）。

| 键 | 默认 | 含义 |
|---|---|---|
| `url` | `http://127.0.0.1:8888` | Hindsight 基址。个人开发默认值，生产部署必须显式设置。 |
| `bank` | `hermes` | 记忆库 id。 |
| `userCharLimit` / `memoryCharLimit` | 1375 / 2200 | 两库字符预算（对齐 Hermes）。超限写入被拒并回显当前条目。 |
| `snapshot` | true | 会话首步注入冻结快照（持久去重：resume/重放不会二次注入）。 |
| `autoRecall` / `recallTokens` | true / 800 | 首轮之后每轮语义召回非 curated 事实。 |
| `autoRetain` / `retainMinChars` / `maxRetainChars` | true / 120 / 6000 | 每轮原文沉淀，标 `mem:session`。 |
| `nudgeInterval` | 10 | 每 N 轮提醒审查记忆；0 关闭。 |
| `tags` | `["dsh"]` | 所有写入合并的基础标签。 |
| `timeoutMs` / `retainTimeoutMs` | 8000 / 30000 | 读/写超时（服务端事实抽取较慢）。 |
| `maxEntryChars` / `maxInjectedChars` | 2200 / 6000 | 单条上限；注入总文本上限。 |
| `protectSecrets` | true | 拒绝凭据形态写入（注入拦截恒开）。 |
| `maxEntries` | 200 | 单库读取上限。 |

协议常量固定不进配置：标签 `curated`/`mem:user`/`mem:memory`/`mem:session`，id 前缀 `dsh-mem-`/`dsh-turn-`/`dsh-note-`。

<a id="understand-the-implementation"></a>

## 实现结构

`src/index.ts` 负责装配（工具、可选 `/memory` 命令、pre-step 注入、轮末结算、投影注册）；`config.ts` 默认值与值域归一；`hindsight.ts` 零依赖 REST 客户端（只用 documents/recall/memories/stats）；`curated.ts` store 语义（预算数学、先写后删）；`security.ts` 凭据/注入拦截；`render.ts` 全部面向模型的文本；`tools.ts`/`commands.ts` 暴露面。session-projection 单元折叠已提交事件，使快照/召回/沉淀判断跨重启保持正确。

<a id="model-experience"></a>

## 模型体验

### 注入的记忆上下文

#### What the model sees

三个生产者向模型上下文注入文本：会话快照、逐轮召回块、审查提醒。

##### Session snapshot

```markdown
[Hindsight 长期记忆 · 会话快照]
=== USER PROFILE (who the user is) [969/1375 字符 · 70% · 约 353 tokens · 8 条] ===
1. 用户偏好中文交流与推理，回答先给结论再给必要细节；涉及文件时给出可点击路径。
...
```

##### Per-turn recall

```markdown
[Hindsight 长期记忆 · 相关召回]
以下条目可能与本轮相关：
1. 2026-11-09 硬规则（优先于一切补录动作）：依赖关系只保留能在持续集成中闭环的…
（这些是过去的事实，可能已经过时；若与当前对话冲突，以当前事实为准。）
```

##### Review nudge

```markdown
[Hindsight 记忆提醒] 本会话已进行 10 轮。
回看刚才的对话：是否出现了值得跨会话保留的用户偏好、环境事实或重要结论？
有就调用 memory 工具（target=user 记录用户，target=memory 记录环境），一次只记一条，写入前先查是否已有等价条目。
没有就忽略这条提醒，不要为了写而写。
当前预算：USER 1375 字符，MEMORY 2200 字符。
```

#### Token effect

快照约按字符数除以 2.75 计 token、每会话一次；每条召回/nudge 是小块 per-turn 文本，压缩时被遮蔽。插件启用期间 `memory`、`memory_recall`、`memory_retain` 的工具 schema 常驻每个请求。

#### KV Cache effect

快照每会话注入一次并冻结，会话内不扰动缓存前缀；写入只落存储不改已注入文本。启停本 bundle 会改变活跃会话的工具列表并使其缓存前缀失效一次。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延后事项

- 快照随 pre-step enter batch 注入；该步被 reject 时不注入、日志也不留幽灵消息，投影状态保证下一次尝试正确。
- recall 无相关性阈值，噪声库可能注入弱相关事实直至压缩遮蔽（与其他上下文生产者同代价）。
- v0.3 纠错闭环设计（mark_incorrect / propose_rule / 异步审计，见 Feature `context/DESIGN-curation-loop.md`）刻意不在本次范围；拾起时另立 Feature。

由个人工作区 `hindsight-memory` v0.2.0（JS，自带 VERIFICATION 矩阵）移植而来；基线源码存于 Feature 的 `context/baseline/` 供行为对照。两个历史缺陷已由回归测试钉死：工具返回值不得含 undefined 字段（lossless JSON）；ESM 热重载不驱逐 `lib/` 子模块（改本包运行时代码后需重启 profile）。

<a id="dev-note"></a>
### 开发备注

由个人工作区 `hindsight-memory` v0.2.0（JS）移植而来；基线源码存于 Feature 的 `context/baseline/` 供行为对照。两个历史缺陷已由回归测试钉死：工具返回值不得含 undefined 字段（lossless JSON）；ESM 热重载不驱逐 `lib/` 子模块（改本包运行时代码后需重启 profile）。
