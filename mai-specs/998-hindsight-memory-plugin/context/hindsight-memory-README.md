# hindsight-memory

以本机 [Hindsight](http://127.0.0.1:8888) 为存储的 **全局记忆管理系统**，记忆管理机制对齐 Hermes Agent。

一条记忆 = 一个 Hindsight document：原文精确保存、有稳定 id、有标签、可单条增删改；Hindsight 自动抽取的事实仍参与语义召回与 consolidation。

## 能力

| 层 | 行为 |
|---|---|
| 双库分层 | `USER`（用户是谁：偏好、风格、个人事实、期待）与 `MEMORY`（工作环境：工具怪癖、项目约定、路径端点、配置坑），一条事实只进一个库 |
| 有界预算 | USER 1375 字符（约 500 tokens）、MEMORY 2200 字符（约 800 tokens），对齐 Hermes `user_char_limit` / `memory_char_limit`；超限时操作失败并返回当前条目，逼迫模型先压缩 |
| 会话快照 | 每个会话第一次 `pre-step` 读取两库，渲染成一条冻结的上下文快照；会话内写入只落 Hindsight，不改快照（保护前缀缓存） |
| 语义召回 | 之后每轮首步用当轮用户输入 recall Hindsight 事实，注入相关记忆 |
| nudge | 每 10 轮（可配）提醒模型审查记忆，与 Hermes `nudge_interval` 一致 |
| 自动沉淀 | 每轮 `turn/end` 把对话写入 Hindsight，标 `mem:session`，与 curated 层隔离 |
| 显式工具 | `memory`（add / replace / remove / batch / list）、`memory_recall`、`memory_retain` |
| 人类命令 | `/memory` 查看状态、列条目、检索、删除 |
| 安全 | 写入前拦截凭据与提示注入文本；失败一律降级，不阻塞对话 |

## 与 Hermes 的对应关系

| Hermes | 本插件 |
|---|---|
| `MEMORY.md`（agent 笔记） | Hindsight 中 tag 为 `mem:memory` 的 document 集合 |
| `USER.md`（用户画像） | Hindsight 中 tag 为 `mem:user` 的 document 集合 |
| 会话开始注入冻结快照 | 每会话首个 `pre-step` 注入一次，之后冻结 |
| `memory` 工具 add/replace/remove/batch | 同名工具，`old_text` 定位、整条覆盖、批量执行 |
| 字符预算与超限拒绝 | 同样的预算语义，按 document 原文长度计算 |
| `nudge_interval: 10` | 同样的轮次提醒 |
| 后台 review 写记忆 | `turn/end` 自动沉淀 + nudge 引导显式写入 |
| 前缀缓存保护 | 会话内不刷新快照 |

## 存储模型

```text
Hindsight bank (默认 hermes)
├── document  dsh-mem-<uuid>   tags: [dsh, curated, mem:user]      ← USER 条目
├── document  dsh-mem-<uuid>   tags: [dsh, curated, mem:memory]    ← MEMORY 条目
├── document  dsh-turn-<n>-…   tags: [dsh, mem:session]            ← 每轮沉淀（不进快照）
└── facts / observations       由 Hindsight 自动抽取，参与 recall 与 consolidation
```

- `add`：新建 document（`document_id` 自定义），同步等待事实抽取。
- `replace`：先写新 document，再删除旧 document（先写后删，避免中途失败丢数据）。
- `remove`：删除 document，其派生 fact 一并清理。
- 快照只读取 `curated` 文档；`mem:session` 的沉淀不会挤占快照预算。

## 安装

推荐用 bundle 安装（profile 里以包名解析，设置页显示 `hindsight-memory` 而不是 `file://` 路径）：

```text
plugin_manager action=install_bundle target=/Volumes/data/project/hindsight-memory
```

安装后 profile 的 `node_modules/hindsight-memory` 是指向本工作区的符号链接，`package.json`
的 `dsh.profile.bundles` 会增加 `hindsight-memory`，因此改工作区文件即改运行文件。

升级：

```bash
# 改完 lib 后，ESM 会缓存子模块；改一次 profile 的 cordis.patch.yml 触发 reconcile，
# 或直接重启 DSH。
```

### 备选：相对路径安装

profile 没有 `node_modules` 时，也可以直接用文件路径加载：

```yaml
- insert:
    - id: hindsight-memory
      name: './hindsight-memory/index.js'
      config:
        url: http://127.0.0.1:8888
        bank: hermes
        userCharLimit: 1375
        memoryCharLimit: 2200
        snapshot: true
        autoRecall: true
        recallTokens: 800
        autoRetain: true
        retainMinChars: 120
        nudgeInterval: 10
        tags: [dsh]
        timeoutMs: 8000
        retainTimeoutMs: 30000
```

代价是设置页会把插件显示成 `file:///…/hindsight-memory/index.js`。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `url` | `http://127.0.0.1:8888` | Hindsight 地址 |
| `bank` | `hermes` | 记忆库 ID |
| `userCharLimit` | `1375` | USER 库字符预算 |
| `memoryCharLimit` | `2200` | MEMORY 库字符预算 |
| `snapshot` | `true` | 会话首个 pre-step 注入冻结快照 |
| `autoRecall` | `true` | 之后每轮做语义召回 |
| `recallTokens` | `800` | 召回 token 预算 |
| `autoRetain` | `true` | 每轮结束沉淀为 `mem:session` |
| `retainMinChars` | `120` | 一轮对话短于此值不沉淀 |
| `maxRetainChars` | `6000` | 单轮沉淀最大字符数 |
| `nudgeInterval` | `10` | 每 N 轮提醒；0 关闭 |
| `tags` | `["dsh"]` | 所有写入的基础标签 |
| `timeoutMs` | `8000` | recall / 文档读取超时 |
| `retainTimeoutMs` | `30000` | 写入 / 删除超时（事实抽取约 2–6 秒） |
| `maxEntryChars` | `2200` | 单条记忆上限 |
| `maxInjectedChars` | `6000` | 注入文本上限 |
| `protectSecrets` | `true` | 拦截凭据与提示注入 |
| `maxEntries` | `200` | 每个库最多读取的条目数 |

## 工具

### `memory`

```text
memory(action="add",     target="memory", content="…")
memory(action="replace", target="user",   old_text="唯一片段", content="整条新全文")
memory(action="remove",  target="memory", old_text="唯一片段")
memory(action="batch",   operations=[{action:"add", target:"user", content:"…"}, …])
memory(action="list",    target="memory")
```

- `target` 默认 `memory`。
- `replace` 会用新内容覆盖**整条**记忆，`old_text` 只用于定位，必须唯一。
- 超预算返回 `reason` + 当前条目 + 占用，模型据此先压缩。
- 写入前做安全扫描，凭据/注入文本会被拒绝。

### `memory_recall`

语义检索整个 Hindsight 库（不限于 curated 层），用于「之前 / 上次 / 我记得」类问题。

### `memory_retain`

写入一条原始记忆（`mem:session`），不进快照。保留它是为了兼容旧用法。

## `/memory` 命令

```text
/memory                     状态：两库占用、最近条目
/memory list [user|memory]  列出条目
/memory search <关键词>      语义检索
/memory forget <user|memory> <片段>
/memory stats               Hindsight 库统计
```

## 验证

```bash
# 一键验证：健康检查、profile 一致性、集成测试、curated/session 计数、tag 过滤语义
bash tests/verify.sh

# 单独跑集成测试（会写入并清理 memtest-suite 标签的文档）
node tests/integration.mjs

# 直接查 curated 条目
curl -s "http://127.0.0.1:8888/v1/default/banks/hermes/documents?tags=dsh&tags=curated&tags_match=all_strict&limit=20"
```

完整的用例清单、执行步骤与已知边界见 [VERIFICATION.md](./VERIFICATION.md)。

会话内验证：
1. 新会话首轮应出现 `[Hindsight 长期记忆 · 会话快照]`。
2. 让模型记录一条偏好，观察 `memory` 工具返回的条目列表与占用。
3. 下一轮应出现 `[Hindsight 长期记忆 · 相关召回]`。
4. 第 10 轮应出现 `[Hindsight 记忆提醒]`。

## 回滚

bundle 安装的回滚：

```text
plugin_manager action=remove_bundle target=hindsight-memory
```

回滚到相对路径安装（旧方式）：

```bash
cp ~/.dsh/profiles/desktop/cordis.patch.yml.bak-20261019c ~/.dsh/profiles/desktop/cordis.patch.yml
# profile/hindsight-memory 实体目录仍在（同步的镜像），loader 会按文件路径加载
```

写入 Hindsight 的数据不会自动删除；按 `curated` / `mem:session` 标签筛选后处理。

## 已知限制

- 快照在会话内冻结：本会话的写入不会反映到已注入的快照（工具返回里能看到最新列表）。这是刻意对齐 Hermes 的前缀缓存策略。
- `list` 需要逐条读取 document 详情（并发 8），条目很多时有一次网络开销。
- 自动沉淀是「整轮拼接」，不做摘要；长对话会产生较多 `mem:session` 文档。
- Hindsight 的 tags 过滤必须用 `all_strict`，`any` 会带上无标签条目。
- 未实现 Hermes 的后台 fork review（用 `llm.stream` 做审查）；当前用「自动沉淀 + nudge 显式写入」替代。

架构与 API 细节见 [RESEARCH.md](./RESEARCH.md)。
