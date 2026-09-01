# Releasing the control plane

How the Deplo version number moves, and who is allowed to move it. The server agent is a different
thing on a different clock: it has its own runbook in `docs/agents/fleet-rollout.md`.

## The one rule for agents

**Never bump the version on your own initiative.** A finished task is a commit, not a release. No
`chore(release):` commit, no tag, no matter how big the change felt. The bump happens only when the
owner explicitly asks for one.

The reason is not ceremony. A version number that nobody chose is a number that describes nothing,
and several sessions share this checkout: two of them bumping `package.json` in the same hour
produces a merge conflict on the one line where a conflict is worst.

### When the owner asks for one number on both repos

The owner sometimes wants the control plane and the agent to carry the **same** version, including
re-cutting a number that already has a tag and a release behind it. **While Deplo is still on
`0.1.0`, do it and do not ask a second time.** Nothing downstream has pinned a number yet, and
`releases/latest` is the only thing that decides what the fleet installs - so moving a tag costs
nothing but the minute it takes. Say what moved, do not open a question about it.

**From `0.1.1` onwards, warn and refuse.** Past the first release the number is a promise somebody
has already read: running instances poll `releases/latest` for the update banner, images carry the
tag, and moving a published tag rewrites what an operator has already installed. At that point the
answer is a new number, and the two repos go back to moving on their own clocks.

## Which digit

Deplo is in **beta**, so every release is `0.x.y` and there are exactly two buckets.

| Bump              | When                                                                                                              | Example                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| **minor** `0.2.0` | The user notices: a new feature, changed behaviour, a DB migration, or a release that needs a newer `deplo-agent` | Preview environments ship       |
| **patch** `0.1.1` | Everything else: a fix, copy, performance, security, an invisible refactor                                        | A dialog stops swallowing Enter |

**No major during the beta.** `1.0.0` is the launch itself, and the owner decides when that is. It
is not something you reach by accumulating minors.

After launch the same table holds with a third row: **major** is a release that cannot be applied by
pulling the new image, because it needs a manual step from the operator. Ideally that row stays
empty forever.

## How

Two commands, and the first one is what keeps the number honest:

```bash
bun pm version minor --message "chore(release): Deplo %s"   # or: patch
git push --follow-tags
```

`bun pm version` writes `package.json`, commits only that line, and derives the tag **from the file
it just wrote**. That matters: the drift it makes impossible has already happened once here.
`chore(release): Deplo 1.2.0` bumped the file, the tag and the image while a hand-written constant
in `lib/version.ts` stayed at `1.1.0`, so every fully updated instance announced a phantom update
forever. The constant is now read from `package.json` (`lib/version.ts:18`) and the tag is derived
too, so there is exactly one place a version can be wrong, and no script of ours in between.

**Before you tag**, run the same checks CI runs, because a red tag has already published an image:

```bash
bun run lint && bun run test && bunx next typegen && bunx tsc --noEmit
```

`bun run test` needs `DEPLO_DATABASE_URL` **unset** (the suite is pglite in-process) and takes
about 11 minutes. `next typegen` before `tsc` is not optional on a clean tree, see AGENTS.md.

## What the tag sets off

1. `docker-image.yml` builds and pushes `ghcr.io/deplocloud/deplo:latest` and `:X.Y.Z`.
2. **Then** it creates the GitHub Release with generated notes. That order is deliberate
   (`bc600ac`): the release is published last so a release page always has an image behind it.
   `v1.1.0` once had one without, and `install.sh` on that version pulled a tag that never existed.
3. `ci.yml` runs on the tag as well, in parallel. It is **not** a gate on the build: the red arrives
   while the image is being pushed and tells you to pull the release, rather than letting one flaky
   test hold a release hostage.
4. Every running instance sees it within the hour: `getUpdateInfo` (`lib/data/updates.ts`) polls
   `releases/latest`, the dashboard banner offers the update, and `deplo_update_available` fires
   once per version.

## Two things that are not this

- **The server agent** (`DeploCloud/deplo-agent`) versions on its own clock, in its own repo. It is
  on the **0.x line too** since 24 Aug 2026, when its 1.x numbering was reset alongside the control
  plane, but the two numbers move independently and are not meant to match. The same two buckets
  apply. Its offline fallback (`FALLBACK_AGENT_VERSION`, `lib/agent/release.ts`) follows the fleet in
  its own `chore(agent):` commit.
- **The fleet only ever moves forward.** `updateServerAgent` has no version argument anywhere in the
  path: it installs `releases/latest`, whatever that resolves to. So a control-plane release that
  needs a newer agent ships the agent **first**, and the reset above was a deliberate one-off, not a
  thing to repeat. `docs/agents/fleet-rollout.md` §10 has the rollback options.
- **The Beta badge** in Settings → Deplo is derived from the version starting with `0.`. Nothing
  turns it off; shipping `1.0.0` does.
