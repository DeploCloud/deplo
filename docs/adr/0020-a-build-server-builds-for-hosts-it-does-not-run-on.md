# ADR-0020: A build server builds for hosts it does not run on

**Status**: accepted (shipped beta in agent v1.26.0)

## Context

Every build happens on the host that will run the container. `runDeployment` resolves one
`serverId` from the deployment row and hands it to `connectAgent()`; the agent clones or
untars, `docker build`s, and `docker compose up`s, all on the same machine. The image is
born on the destination and never moves, because there is no registry anywhere in Deplo
(`lib/graphql/types/cleanup.ts`: "Deplo pushes to no registry").

That couples a server's size to its worst build rather than its workload. A Next.js app
that serves in 300 MB needs several GB to compile, and while it compiles, the apps already
running on that host compete for the same CPU and RAM. The operator's only lever is to
over-buy every server in the fleet.

## Decision

A server can be marked as a **build server**: it compiles for machines it does not run on.
The deploy splits into build → transfer → release, and the last of those is code that
already existed.

### The image travels through the control plane, not a registry

`ExportImage`/`ImportImage` stream a gzipped `docker save` from the builder to the target,
relayed by the control plane. This is the third use of a shape already used twice
(`ExportVolume`/`ImportVolume` for a server move, `ExportFiles`/`ImportFiles` for the files
dir) and it follows from ADR-0006's trust model: agents are a star, an agent can neither
dial nor trust a peer, so cross-host bytes pass through the control plane or not at all.

A registry was the alternative and is the obvious upgrade path - it would move only the
changed layers, where this moves the whole image every deploy. It was not built now because
it is a component the operator would have to be given (a container, a disk, credentials,
TLS, reachability between hosts), and "use the infrastructure they already have rather than
demanding they stand up more" is the core mission's rule. The relay needs none of that and
works on a fleet whose servers cannot reach each other at all. If transfer time becomes the
complaint, a Deplo-managed registry replaces the transport without changing the UX: the
setting is still "Build on: `<server>`".

### The release leg is the rollback path, unchanged

After the import, the target runs an ordinary `SOURCE_KIND_IMAGE` deploy with
`pull_image=false` - which is exactly what a **Rollback** does, for exactly the same reason:
`deplo/<key>:<dep>` is a bare local tag that exists on one host and in no registry, so
pulling it could only ever fail. No new deploy path was added on the target side.

### Only a source Deplo builds

Compose stacks and `docker-image` sources are out of scope, and this is the same boundary
the data model already draws: `deployments.image_ref` is written only by the arms Deplo
builds (git, upload), which is also the set that supports Rollback. A compose stack has no
single image to move; a prebuilt image is not built at all. The agent rejects `build_only`
for both rather than reporting a success that produced no artifact.

### The archive is not trusted to name itself

`docker load` restores whatever RepoTags the archive declares, not the tag the caller
announced, so a compromised builder could ship a second image alongside the real one and
replace `deplo/<other-app>:<its deployment id>` on every host it builds for - which that
app's next rollback would then run. The star topology otherwise prevents exactly this
kind of lateral movement, so the agent diffs its tag list either side of the load and
refuses (removing them) if any other `deplo/` tag appeared.

Scoped to that namespace, and to the ref pattern `deplo/<name>:<tag>` on both halves of
the relay, for two different reasons. Deleting outside it would be wrong: other deploys
mutate the same host concurrently, and a base image someone else just pulled would read
as smuggled. Accepting a ref outside it would be worse: `remove_after` deletes, so
without the prefix a malformed request could `docker rmi` a base image out from under
every app on the box. Re-enforcing the control plane's naming agent-side is the house
rule anyway - `validateSlug` does it at nineteen call sites.

### An architecture mismatch is a refusal

`HelloResponse.host_arch` is new, observed like `docker_version`, and persisted on
`servers.host_arch` so the picker can grey out the impossible choices without dialing every
agent. A builder and a target of different architectures are never paired. This is the one
failure the feature could otherwise introduce that reports itself as a SUCCESS: an amd64
image loads onto an arm64 host perfectly well, the deploy goes green, and the container then
crash-loops on `exec format error` with nothing in the deploy log to explain it.

### The fallback is narrow, and it is the app's to disable

An unreachable build server falls back to building on the app's own server, with a warning
line in the deploy log; `apps.build_fallback_local` (default true) turns that off for
whoever chose a small deploy server deliberately. The fallback fires ONLY on an unreachable
agent - never on a build that ran and failed (it would fail identically elsewhere), and never
on a transfer that broke after the builder already did the expensive part.

This does not contradict ADR-0006's "no in-process fallback". The control plane still builds
nothing itself; both paths are an agent, and which agent is the whole question.

### Automatic, with a per-app override

A `build_only` host exists to be built on, so apps use one without opting in: `null` on
`apps.build_server_id` means "a build-only server this team can reach whose architecture
matches, else build where it runs". The override is per app, in Advanced. "Build on this
app's own server" is stored as that server's id rather than a sentinel in a column of ids,
and `updateAppSource` carries the pin across a server move, next to where it already
re-hosts the app's domains.

### The deploy occupies the builder's queue lane

`coalesce(build_server_id, server_id)`. The build is where the cost is; the release is a
`compose up` measured in seconds. Counting a deploy against the tiny host it lands on would
let ten servers at concurrency 1 aim ten simultaneous builds at one builder, which is the
opposite of the point. The known cost is the mirror image - apps sharing a builder can now
reach their own hosts at once - and that is the cheap phase.

### It ships as beta

Same chip the Git providers carry, on the three surfaces that expose it: the "Only build"
role, the server role card, and the app's "Build on" setting. The machinery is proven
against two real hosts (`scripts/buildserver-e2e.mts` - build here, run there, builder
reclaimed), but the path through the dashboard has far fewer real fleets behind it than
the rest of the product. It is not a warning label: nothing gets a build server by
accident, because an instance admin has to mark a host for it first.

## Consequences

- A build server needs no domain, no proxy and no ports: the installer's only build-only
  branch is skipping Traefik, and the readiness report skips that row instead of warning.
- Because the role is only a control-plane decision, it is reversible from Manage, unlike
  `storage_only` (which skips installing Docker, and no database write undoes that).
  Turning it on is refused while the host still has apps or databases.
- **The source and decrypted env of every app that builds there cross to that host.** It
  obeys the existing `all_teams` / `server_teams` grants and nothing new: the exposure is
  the same one any shared server already has, but it is now shared by apps that do not run
  there. The Add server dialog says so where the choice is made.
- The whole image moves on every deploy, twice through the control plane. Acceptable on a
  LAN, the main argument for the registry upgrade over a WAN.
- Requires an agent release: `deploy.build-only` and `image-copy` capabilities, plus
  `host_arch`. `deploy.build-only` is a HARD gate - an older agent would read the unknown
  field as absent and deploy the app on the build server.
- The queue's same-stack exclusion had to become GLOBAL rather than per-lane. Two
  production deploys of one app used to be guaranteed into the same lane; with a build
  server they can land in different ones, and per-lane sets would let them not only
  overlap but finish out of order, leaving the app on the older commit. It is keyed on
  the deploy key, so a preview and production of one app still run in parallel.
- A build server that cannot be reached is two error classes, not one
  (`AgentUnreachableError` from the dial, `AgentUnavailableError` from the deploy path).
  Both have to count as "down", or the fallback never fires for the case it exists for.
