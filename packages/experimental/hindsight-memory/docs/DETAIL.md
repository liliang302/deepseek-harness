# Hindsight memory

The plugin keeps two curated stores — **USER** (who you are: preferences, style, personal facts) and **MEMORY** (working environment: tool quirks, project conventions, paths, pitfalls) — as individually addressable documents inside a self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) server (or any API-compatible deployment speaking the `/v1/default/banks/<bank>` document/recall protocol).

At the first step of every session it injects one frozen snapshot of both stores (with char-budget usage), so the agent starts already knowing your context; writes during the session land in Hindsight immediately but never mutate that snapshot, protecting prefix caches. From the second turn on it recalls facts relevant to what you just said. The model manages entries through the `memory` tool (add / replace / remove / batch / list) under hard character budgets; every finished turn is retained verbatim as searchable `mem:session` history. Credential-shaped text and prompt-injection phrases are refused at every write path. Humans can use `/memory status|list|search|forget|stats` without involving the model. If the Hindsight server is unreachable everything degrades silently — conversations never block.

## Configuration

Set `url` and `bank` for your deployment; defaults (`http://127.0.0.1:8888`, `hermes`) point at a local development instance. Budgets, timeouts, feature switches (`snapshot`/`autoRecall`/`autoRetain`/`nudgeInterval`/`protectSecrets`) are documented in README.md.

## Requirements

- A reachable Hindsight REST server (v1 banks API) with embedding configured; this plugin performs no model calls itself.
- Network egress from the DSH Host process to the configured URL.
