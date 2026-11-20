# @deepseek-ai/dsh-client-ui-sdd-workbench

SDD Workbench bundle for DeepSeek Harness: a sidebar panel that browses the workspace's `mai-specs/` feature tree produced by the [my-ai-infra](https://github.com/shanggqm/my-ai-infra) SDD workflow and reads its stage documents (BRIEF / PRD / TECH_DESIGN / reviews / test plans) in formatted Markdown. Read-only by design.

## Assignment entry (作业一：用 my-ai-infra SDD 为 DSH 开发一个插件)

- **Plugin purpose**: Feature navigation + spec document viewer inside DSH Web, matching the assignment's suggested "my-ai-infra SDD workbench" topic.
- **SDD process artifacts**: [`mai-specs/999-sdd-workbench-panel/`](../../mai-specs/999-sdd-workbench-panel/) — BRIEF, PRD, TECH_DESIGN, DESIGN_REVIEW, CODE_REVIEW, TEST_PLAN, ACCEPTANCE; roadmap index at [`mai-specs/ROADMAP.md`](../../mai-specs/ROADMAP.md).
- **Branch**: `feat/sdd-workbench-plugin` (based on tag `dsh-v0.2.2-rc.5`).

## Run from source

```sh
pnpm install
pnpm run build
pnpm dsh web
```

Install the plugin into the running profile: open **Plugins** → **Add plugin** → enter this package directory path (`packages/experimental/client-ui-sdd-workbench`) and enable it, or from the terminal at the repository root:

```sh
pnpm dsh plugin --profile web add "link:$PWD/packages/experimental/client-ui-sdd-workbench"
```

Then click **SDD Workbench** in the Web sidebar. Verify: the feature list shows directories like `999-sdd-workbench-panel`; opening one renders its documents; a workspace without `mai-specs/` shows the setup hint instead of an error.

## Packages

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-sdd-workbench` | Host read-only scan/read Remote service (`sddWorkbench/scan`, `sddWorkbench/readDoc`) |
| `@deepseek-ai/dsh-client-ui-sdd-workbench` | Bundle patch + browser panel (sidebar entry, main panel, Markdown renderer); carries the visible bundle metadata |

## Known limitations

- In a shared instance hosting several workspaces, the panel resolves the current session root via main-view retention with a most-recently-updated fallback; when neither identifies your workspace, use **Refresh** after switching sessions or run the harness from the target directory.
- Markdown images degrade to alt text; links render as label text with the target in a tooltip (no live navigation).
