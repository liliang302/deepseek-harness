---
description: "Global long-term memory for DeepSeek Harness on a self-hosted Hindsight server, with curated USER/MEMORY stores, session snapshots, per-turn recall, safety screening, and automatic retention."
kind: "package-bundle"
---

# @deepseek-ai/dsh-hindsight-memory

English | [中文](README.zh.md)

## Summary

The plugin keeps two curated stores — **USER** (who the user is) and **MEMORY** (working environment) — as individually addressable documents inside a self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server. At the first step of every session it injects one frozen snapshot (persisted dedupe makes resume/HMR safe); from the second turn on it recalls facts relevant to the current prompt; the model manages entries through the `memory` tool under hard character budgets, every finished turn is retained verbatim as searchable `mem:session` history, and credential-shaped or prompt-injection text is refused at every write path. Unreachable storage degrades silently. Humans get `/memory status|list|search|forget|stats`.

## Table of Contents

- [Assignment entry](#assignment-entry)
- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Assignment entry

- **Plugin purpose**: the assignment deliverable — a DSH plugin developed through the my-ai-infra SDD workflow; this package is the ported hindsight-memory plugin (TS, repository conventions, optional bundle registration).
- **SDD process artifacts**: [`mai-specs/998-hindsight-memory-plugin/`](../../../mai-specs/998-hindsight-memory-plugin/) — BRIEF, PRD, TECH_DESIGN, DESIGN_REVIEW (+复评), CODE_REVIEW, TEST_PLAN, ACCEPTANCE; index at [`mai-specs/ROADMAP.md`](../../../mai-specs/ROADMAP.md). Baseline JS sources are archived under the Feature's `context/baseline/`.
- **Main branch**: `main` carries the assignment entry and the full deliverable — this plugin, its SDD artifacts, and the archived baseline sources (plus the earlier SDD-workbench panel as an extra attempt). Feature branches: `feat/hindsight-memory-plugin` (this work), `feat/sdd-workbench-plugin` (the panel attempt).

## Use this package

Run from source at the repository root:

```sh
pnpm install
pnpm run build
pnpm dsh web  # or: pnpm dsh desktop
```

Install the plugin: **Plugins** → **Add plugin** → path `packages/experimental/hindsight-memory` → enable. From the terminal (web profile example):

```sh
pnpm dsh plugin --profile web add "link:$PWD/packages/experimental/hindsight-memory"
```

Upgrading from an older standalone `hindsight-memory` bundle installed by local path: remove that bundle first (Plugins page or `dsh plugin remove`), then install this package, so the same-id patch row is not silently replaced.

Verify: start a session — the context should carry `[Hindsight 长期记忆 · 会话快照]`; ask the agent to remember something via the `memory` tool, then open a new session and confirm the snapshot includes it. Without a reachable Hindsight server the plugin stays silent (degraded mode).

## Configuration

Table keys are validated by the Loader schema at plugin load (`cordis.patch.yml`).

| Key | Default | Meaning |
|---|---|---|
| `url` | `http://127.0.0.1:8888` | Hindsight base URL. Personal-dev default; production deployments must set it explicitly. |
| `bank` | `hermes` | Bank id. |
| `userCharLimit` / `memoryCharLimit` | 1375 / 2200 | Curated-store char budgets (Hermes-aligned). Writes over budget are refused with the current entries returned. |
| `snapshot` | true | Frozen snapshot at the session's first step (persisted dedupe: replay/resume never re-injects). |
| `autoRecall` / `recallTokens` | true / 800 | Per-turn semantic recall of non-curated facts. |
| `autoRetain` / `retainMinChars` / `maxRetainChars` | true / 120 / 6000 | Verbatim per-turn retention tagged `mem:session`. |
| `nudgeInterval` | 10 | Every N turns remind the model to review memory; 0 disables. |
| `tags` | `["dsh"]` | Base tags merged into every write. |
| `timeoutMs` / `retainTimeoutMs` | 8000 / 30000 | Read vs write timeouts (server fact-extraction is slow). |
| `maxEntryChars` / `maxInjectedChars` | 2200 / 6000 | Single-entry cap; total injected-text cap. |
| `protectSecrets` | true | Reject credential-shaped writes (injection screening is always on). |
| `maxEntries` | 200 | Per-store listing cap. |

Protocol constants stay fixed: tags `curated`/`mem:user`/`mem:memory`/`mem:session`, document id prefixes `dsh-mem-`/`dsh-turn-`/`dsh-note-`.

## Understand the implementation

`src/index.ts` owns assembly (tools, optional `/memory` command, pre-step injection, turn settlement, projection registration); `config.ts` defaults and value-range normalization; `hindsight.ts` the zero-dependency REST client (documents/recall/memories/stats only); `curated.ts` store semantics including budget math and write-before-delete replace; `security.ts` the credential/injection screens; `render.ts` every model-facing string; `tools.ts`/`commands.ts` the exposed surfaces. The session-projection unit folds committed events so snapshot/recall/retention decisions survive restarts.

## Model Experience

### Injected memory context

#### What the model sees

Three producers inject text into model context: the session snapshot, per-turn recall notices, and review nudges.

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

The snapshot costs roughly its char count divided by 2.75 tokens once per session; each recall or nudge notice adds a small per-turn block that ages out at compaction. Tool schemas for `memory`, `memory_recall`, and `memory_retain` sit in every request while the plugin is enabled.

#### KV Cache effect

The snapshot is injected once and frozen for the session, so it does not churn the cached prefix mid-session; writes go to storage without mutating injected text. Enabling or disabling the bundle changes the tool list of live sessions and invalidates their cached prefix once.

## Known Limitations and Deferred Work

- Snapshot injection rides the pre-step enter batch; if the loop rejects entering the step, nothing is injected and the durable log keeps no phantom message (projection-derived state makes the next attempt correct).
- Recall has no relevance threshold; noisy banks may inject weakly related facts until compaction shadows them (same cost as other context producers).
- v0.3 curation-loop design (mark_incorrect / propose_rule / async audit, see the Feature's `context/DESIGN-curation-loop.md`) is intentionally out of scope; file a separate feature when picked up.


Ported from the personal-workspace `hindsight-memory` v0.2.0 (JS, verified in its own VERIFICATION matrix); the baseline sources live under the Feature's `context/baseline/` for behavior diffing. Two historical defects are pinned by regression tests: lossless-JSON tool results (no undefined-valued fields) and ESM hot-reload not evicting `lib/` submodules (restart the profile after editing this package's runtime code).

<a id="dev-note"></a>
### Dev Note

Ported from the personal-workspace `hindsight-memory` v0.2.0 (JS); baseline sources live under the Feature's `context/baseline/` for behavior diffing. Two historical defects are pinned by regression tests: lossless-JSON tool results (no undefined-valued fields) and ESM hot-reload not evicting `lib/` submodules (restart the profile after editing this package's runtime code).
