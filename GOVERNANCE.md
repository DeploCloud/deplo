# Governance

How deplo is run, who decides what, and what happens to the project if any one person
disappears. For how to contribute code, read [CONTRIBUTING.md](CONTRIBUTING.md); for how to
report a vulnerability, read [SECURITY.md](SECURITY.md).

## Roles

| Role                | Who                                                                                 | Responsibilities                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Lead maintainer** | [@IdraDev](https://github.com/IdraDev)                                              | Final say on scope, architecture and releases. Merges, tags, publishes. Answers security reports. |
| **Maintainer**      | members of the [DeploCloud](https://github.com/orgs/DeploCloud/people) organization | Triage, review, merge. Admin on the repository and the release pipeline.                          |
| **Contributor**     | anyone with a merged change                                                         | Proposes changes through pull requests. No obligation beyond the change itself.                   |

Roles are held by people, not assigned by committee. A contributor becomes a maintainer by
being invited to the organization after a sustained track record; a maintainer steps down by
saying so.

## How decisions get made

**Architecture is decided in the open, in writing.** A decision that constrains future work
becomes a numbered ADR in [`docs/adr/`](docs/adr/) before the code lands. An ADR names what was
decided, what it rules out, and why. Contradicting a live ADR means writing the one that
supersedes it, not quietly overriding it.

**Scope is decided by the lead maintainer.** deplo has a stated mission in
[AGENTS.md](AGENTS.md#core-mission---the-north-star-every-feature-answers-to): self-hosting
that never requires the user to know Docker or SSH. A proposal is judged against that mission
first and its cleverness second. "Another platform has this setting" is an argument against a
feature, not for it.

**Everything else is decided in the issue.** Bugs, features and questions live in
[GitHub Issues](https://github.com/DeploCloud/deplo/issues). Disagreement is resolved by
argument in the thread; if it stays deadlocked, the lead maintainer breaks the tie and says why.

## Code review

**Outside contributions go through a pull request and are reviewed before merge.** A reviewer
checks, in this order:

1. **Security.** Does it cross a trust boundary? Every mutating path is Capability-gated
   server-side in `lib/data/*`, never only in the UI. Secrets stay write-only. User-supplied
   outbound addresses go through `lib/outbound-url.ts`.
2. **Correctness and tests.** New behaviour arrives with a test that fails without it. The suite
   must be green (`bun run test`, with `DEPLO_DATABASE_URL` unset).
3. **Mission fit.** Does the happy path work for someone who has never opened a shell?
4. **House style.** The conventions in [AGENTS.md](AGENTS.md) and
   [CONTRIBUTING.md](CONTRIBUTING.md): naming from [CONTEXT.md](CONTEXT.md), short comments,
   Conventional Commits, formatting left to Prettier.

A reviewer who cannot answer point 1 asks someone who can rather than approving.

**Maintainers commit directly to `main`** for their own work, and the CI gates
(lint, tests, `tsc --noEmit`, dependency audit) run on every push. This is a deliberate
trade-off in favour of a small team's throughput, and it is why deplo does not claim the
OpenSSF `two_person_review` criterion.

## Releases

Releases are cut by a maintainer with `bun pm version`, which tags and commits in one step, and
published from CI on the tag. deplo is in beta: **minor** when a user would notice, **patch**
otherwise. The procedure is in [`docs/agents/releasing.md`](docs/agents/releasing.md). The Go
server agent versions on its own clock and the fleet only ever moves forward.

## Continuity

**Nothing critical lives in a personal account.**

- The **repository**, its issues and its releases belong to the
  [DeploCloud organization](https://github.com/DeploCloud), which has more than one owner. No
  single person's account can take the project offline or lock the others out.
- The **user manual** is its own repository, [DeploCloud/docs](https://github.com/DeploCloud/docs),
  under the same organization.
- **Container images** are published to `ghcr.io/deplocloud/deplo`, owned by the organization.
- The project is **AGPL-3.0-only**. Every published version stays forkable by anyone, so the
  work survives the organization itself.

If the lead maintainer becomes unreachable, the remaining organization owners appoint a new one.
If nobody is left, the licence is the backstop: fork it and carry on.
