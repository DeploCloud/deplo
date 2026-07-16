@AGENTS.md

## Core mission (north star)

**deplo makes self-hosting exhaustively simple, Vercel-style. The user must NEVER be required to
know Docker or SSH** — that non-requirement is the whole differentiator vs. Coolify / Dokploy.
Every feature is tested exhaustively and judged on UX/DX for a non-expert: if the happy path only
works from a shell or by hand-editing YAML, the feature is unfinished. Favor
derived/live/automatic over manual, and use infrastructure the user already has rather than
demanding they stand up more. Full statement in `AGENTS.md` → "Core mission".

## Agent skills

### Issue tracker

Issues and PRDs live in the DeploCloud/deplo GitHub Issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, each mapped to its default label string. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
