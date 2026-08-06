@AGENTS.md

## Core mission (north star)

**deplo makes self-hosting exhaustively simple, Vercel-style. The user must NEVER be required to
know Docker or SSH** — that non-requirement is the whole differentiator vs. the open-source
competitors. The experience to match is the big clouds (Vercel, Railway, Render) on the user's own
infrastructure, and the audience is everyone who wants it — people leaving a cloud over the bill,
teams that never self-hosted, and competitors' users too, but never *only* that last group.
Every feature is tested exhaustively and judged on UX/DX for a non-expert: if the happy path only
works from a shell or by hand-editing YAML, the feature is unfinished. Favor
derived/live/automatic over manual, and use infrastructure the user already has rather than
demanding they stand up more.

Also binding:

- **Every feature must make sense in the UX and name its audience — exactly two exist:**
  **non-expert** (default-on, obvious, zero config) or **expert** (*advanced mode*: opt-in, behind
  an "Advanced" affordance, never on the first-run path).
- **Design for teams and companies, not just the solo self-hoster.** Assume several people with
  different Capabilities share one instance and that the actor is not the instance owner:
  active-team scoping, server-side Capability gates, per-folder grants, an Activity trail readable
  in the UI. Roles/members/tokens/2FA are product, not plumbing. Orthogonal to non-expert vs
  expert; the single-user path must not get heavier for it.
- **Don't build what almost nobody will realistically use long-term.** The goal is being far
  simpler than competing self-hosted platforms, not matching their feature list. First launch must
  sell the **pricing difference vs. Vercel/Railway**, not force a tour of tons of settings with
  advanced options exposed by default.
- **Build everything so it could become a managed service.** deplo plans its own proprietary cloud
  later (idea still rough): keep things multi-tenant-safe and free of "operator == end user"
  assumptions — while self-hosted + open source stay first-class and never get starved for it.
- **Flag a mission conflict once, then build it.** A request (yours or the user's) that collides
  with the above gets at most three lines of warning *before* the code (what it collides with, the
  cheaper thing covering the same need), and then you build it anyway. Only the five listed
  conflicts count; "feels like scope creep" doesn't. If the user reaffirms, it's decided.

Full statement in `AGENTS.md` → "Core mission" (the five conflicts are listed under
"Flag a mission conflict once, then build it").

## Agent skills

### Issue tracker

Issues and PRDs live in the DeploCloud/deplo GitHub Issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, each mapped to its default label string. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
