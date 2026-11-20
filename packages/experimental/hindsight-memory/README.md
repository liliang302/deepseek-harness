---
description: "Global long-term memory for DeepSeek Harness on a self-hosted Hindsight server, with curated USER/MEMORY stores, session snapshots, per-turn recall, safety screening, and automatic retention."
kind: "package-bundle"
---

# @deepseek-ai/dsh-hindsight-memory

English | [中文](README.zh.md)

Global long-term memory for DeepSeek Harness, stored in a self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server.

Global long-term memory for DeepSeek Harness, stored in a self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server.

One memory = one Hindsight document (exact original text, stable id, tags), organized as two Hermes-style curated stores: **USER** (who the user is) and **MEMORY** (working environment). The plugin injects a frozen per-session snapshot, recalls relevant facts every turn, exposes `memory` / `memory_recall` / `memory_retain` tools with character budgets and safety screening, retains each finished turn as searchable history, and answers the human `/memory` command. Unreachable storage degrades silently; conversations never block.

## Assignment entry (作业一：用 my-ai-infra SDD 为 DSH 开发一个插件)

- **Plugin purpose**: the assignment deliverable — a DSH plugin developed through the my-ai-infra SDD workflow; this package is the ported hindsight-memory plugin (TS, repository conventions, optional bundle registration).
- **SDD process artifacts**: [`mai-specs/998-hindsight-memory-plugin/`](../../mai-specs/998-hindsight-memory-plugin/) — BRIEF, PRD, TECH_DESIGN, DESIGN_REVIEW (+复评), CODE_REVIEW, TEST_PLAN, ACCEPTANCE; index at [`mai-specs/ROADMAP.md`](../../mai-specs/ROADMAP.md). Baseline JS sources are archived under the Feature's `context/baseline/`.
- **Branch**: `feat/hindsight-memory-plugin` (based on tag `dsh-v0.2.2-rc.5`). The earlier SDD-workbench panel attempt remains available on branch `feat/sdd-workbench-plugin`.

## Run from source

```sh
pnpm install
pnpm run build
pnpm dsh web  # or: pnpm dsh desktop
```

Install the plugin: **Plugins** → **Add plugin** → path `packages/experimental/hindsight-memory` → enable. From the terminal at the repository root (web profile example):

```sh
pnpm dsh plugin --profile web add "link:$PWD/packages/experimental/hindsight-memory"
```

Upgrading from an older standalone `hindsight-memory` bundle installed by local path: remove that bundle first (Plugins page or `dsh plugin remove`), then install this package, so the same-id patch row is not silently replaced.

Verify: start a session — the context should carry `[Hindsight 长期记忆 · 会话快照]`; ask the agent to remember something via the `memory` tool, then open a new session and confirm the snapshot includes it. Without a reachable Hindsight server the panel stays silent (degraded mode).

## Configuration (`cordis.patch.yml`, validated at load)

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

## Known limitations and deferred work

- Snapshot injection rides the pre-step enter batch; if the loop rejects entering the step, nothing is injected and the durable log keeps no phantom message (projection-derived state makes the next attempt correct).
- Recall has no relevance threshold; noisy banks may inject weakly related facts until compaction shadows them (same cost as other context producers).
- v0.3 curation-loop design (mark_incorrect / propose_rule / async audit, see the Feature's `context/DESIGN-curation-loop.md`) is intentionally out of scope; file a separate feature when picked up.
