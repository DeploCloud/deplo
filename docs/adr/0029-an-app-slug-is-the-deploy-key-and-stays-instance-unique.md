# ADR-0029: An app's slug is the deploy key, and it stays unique per instance

- **Status**: Accepted - 2026-08-31.
- **Relates to**: ADR-0009 (Environments scope their contents) and ADR-0028 (an
  Environment owns a network), which scope almost everything else to a team.

## Context

Apps are scoped to an Environment: `production/b5-wiki` and `staging/b5-wiki` are
two apps, both correctly called **b5-wiki**, and that is the commonest structure a
team has. Their `slug`, however, is unique across the WHOLE INSTANCE - so the
second one is minted `b5-wiki-1`, and a migration that brings both across says so
in its report.

Everything else deplo owns is scoped to the active team, which makes an
instance-wide unique index look like an oversight, and one worth settling before
the managed service exists.

## Decision

**The slug stays unique per instance, because it is not a display name - it is the
deploy key.** It is what names, on the HOST:

- the container (`deplo-<slug>`) and the compose project,
- every named volume (`deplo-<slug>-<alias>`),
- the stack's directory and its files dir.

Docker's names are global **per host**, and a server in deplo is the one resource
shared across every team (`servers.all_teams` defaults to true). Two teams whose
apps landed on the same machine with the same slug would collide at `compose up` -
after the create, on someone else's deploy.

The visible identity is `apps.name`, which is already per-Environment and unchanged
by any of this. Only the internal name gives way.

## Consequences

- **A name reused in another Environment keeps its name and takes a suffixed
  deploy key.** The migration report says which one it took, and names the
  Environment the other one lives in, rather than asking for a rename.
- **The URL carries the deploy key** (`/apps/b5-wiki-1`), so two apps of one name
  are told apart in the address bar.
- **For the managed cloud this is not a blocker.** A tenant's workloads sit on
  hosts that tenant reaches; the uniqueness only ever has to hold per host, and
  per instance is a stricter rule that already holds it.
- **The alternative was measured and rejected**: a per-team slug plus a separate
  instance-unique deploy key. It buys a prettier URL and costs a second identity
  on every read, every route and every rename - and the on-disk name would still
  be the suffixed one.
