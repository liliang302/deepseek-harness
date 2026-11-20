---
description: "以自托管 Hindsight 为存储的 DSH 全局长期记忆：USER/MEMORY curated 双库、会话快照、逐轮召回、安全拦截与自动沉淀。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-hindsight-memory

[English](README.md) | 中文

DeepSeek Harness 的全局长期记忆插件，存储后端为自托管的 [Hindsight](https://github.com/vectorize-io/hindsight) 服务。

DeepSeek Harness 的全局长期记忆插件，存储后端为自托管的 [Hindsight](https://github.com/vectorize-io/hindsight) 服务。

一条记忆 = 一个 Hindsight document（原文精确、稳定 id、标签），组织为 Hermes 风格的两个 curated 库：**USER**（用户是谁）与 **MEMORY**(工作环境)。插件在会话首个模型步骤注入冻结快照、每轮召回相关事实、通过 `memory` / `memory_recall` / `memory_retain` 工具暴露带字符预算与安全拦截的记忆管理、把每个完成轮次沉淀为可检索历史，并响应人类 `/memory` 命令。存储不可达时全程静默降级，绝不阻塞对话。

## 作业入口（作业一：用 my-ai-infra SDD 为 DSH 开发一个插件）

- **插件用途**：本包即作业交付物——按 my-ai-infra SDD 流程移植进仓库的 hindsight-memory 记忆体插件（TS 化、符合仓库规范、optional bundle 注册）。
- **SDD 过程产物**：[`mai-specs/998-hindsight-memory-plugin/`](../../mai-specs/998-hindsight-memory-plugin/)——BRIEF、PRD、TECH_DESIGN、DESIGN_REVIEW(+复评)、CODE_REVIEW、TEST_PLAN、ACCEPTANCE；索引见 [`mai-specs/ROADMAP.md`](../../mai-specs/ROADMAP.md)。旧 JS 基线源码归档于该 Feature 的 `context/baseline/`。
- **主分支**：`main` 承载作业入口与完整交付物——本插件、SDD 过程产物与归档基线源码（另含更早的 SDD 工作台面板附加尝试）。特性分支：`feat/hindsight-memory-plugin`（本次工作）、`feat/sdd-workbench-plugin`（面板尝试）。

## 从源码运行

```sh
pnpm install
pnpm run build
pnpm dsh web  # or: pnpm dsh desktop
```

安装插件：**插件** 页 → **添加插件** → 路径填 `packages/experimental/hindsight-memory` → 启用。或在仓库根终端（web profile 示例）：

```sh
pnpm dsh plugin --profile web add "link:$PWD/packages/experimental/hindsight-memory"
```

若此前以本地路径装过独立版 `hindsight-memory` bundle：先移除旧 bundle 再安装本包，避免同 id 的 patch 行被静默替换。

验证：开一个会话——上下文应带 `[Hindsight 长期记忆 · 会话快照]`；让助手用 `memory` 工具记一条内容，再开新会话确认快照包含它。Hindsight 不可达时插件静默降级。

## 配置（`cordis.patch.yml`，加载期校验）

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

## 已知限制与延后事项

- 快照随 pre-step enter batch 注入；该步被 reject 时不注入、日志也不留幽灵消息，投影状态保证下一次尝试正确。
- recall 无相关性阈值，噪声库可能注入弱相关事实直至压缩遮蔽（与其他上下文生产者同代价）。
- v0.3 纠错闭环设计（mark_incorrect / propose_rule / 异步审计，见 Feature `context/DESIGN-curation-loop.md`）刻意不在本次范围；拾起时另立 Feature。
