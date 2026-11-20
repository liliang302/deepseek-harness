# SDD Workbench

Adds a sidebar panel that reads the workspace's `mai-specs/` directory produced by the my-ai-infra SDD workflow: a feature list with phase and stage-artifact badges, and in-panel reading of BRIEF / PRD / TECH_DESIGN / review / test documents as formatted Markdown. Read-only; no document is ever modified.

Install, then switch the bundle on in Plugins. Open "SDD Workbench" from the sidebar. Requires a workspace initialized with `mai init` (my-ai-infra); an absent `mai-specs/` shows guidance instead of an error.
