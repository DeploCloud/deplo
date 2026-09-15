@AGENTS.md

`AGENTS.md` (imported above) is the whole brief: architecture, the agent boundary, layout,
API, data/security, UI conventions, vocabulary, working rules. This file only adds what is
not in it. **Don't restate AGENTS.md here** - a rule written twice drifts in one place.

## Core mission (north star)

**Deplo makes self-hosting exhaustively simple: the user must NEVER be required to know Docker,
SSH or YAML to get full value out of it.** Every feature names its audience - **non-expert**
(default-on, zero config) or **expert** (advanced mode, opt-in, never on the first-run path) -
assumes a TEAM with different Capabilities rather than one operator who owns the box, and could
be offered as a managed service without a fork. Favour derived/live/automatic over manual.

`AGENTS.md` → "Core mission" has the full statement, including the five conflicts that are worth
flagging (in three lines, before the code, then you build it anyway) and the reason for each.

## Agent skills

- **Issues and PRDs**: GitHub Issues in `DeploCloud/deplo`, driven with the `gh` CLI, including
  the `wayfinder:*` map/ticket flow. See `docs/agents/issue-tracker.md`.
- **Labels**: the repo has GitHub's defaults plus `wayfinder:*` and `dependencies`. There is no
  `needs-triage` / `ready-for-agent` label - inventing one in `gh issue create --label` fails the
  command. See `docs/agents/triage-labels.md`.
- **Domain docs**: single-context - one `CONTEXT.md` (glossary) + `docs/adr/` at the repo root.
  See `docs/agents/domain.md`.
- **Shipping**: `docs/agents/releasing.md` (control plane, never bump on your own initiative) and
  `docs/agents/fleet-rollout.md` (the `deplo-agent` fleet, forward-only).
