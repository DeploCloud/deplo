# ADR-0028: An Environment owns a network

- **Status**: Accepted - 2026-08-30.
- **Amends**: the shared-`deplo`-network model described in `AGENTS.md`
  ("The shared `deplo` network is the PLATFORM\'s, not the stack\'s"). The reserved-name
  list it introduced stays, reduced to the two names the proxy still resolves.

## Context

Every app, every managed database and the control plane shared **one** Docker network
per instance. Two consequences, both measured on a live host:

- **Name theft.** Every container registers its service name in that network\'s DNS, and
  Docker round-robins a name two containers both claim. Two apps that happened to call a
  service `garage` split its traffic 5 answers to 3.
- **Reachability by address.** Any container could open a TCP connection to any port of
  any other app on the machine - no DNS, no name, no claim. A tenant reached another
  team\'s Postgres at `10.200.1.11:5432`. Nothing stood in the way of this at all.

The defence was a list of six names the platform answers to. A list covers the names
somebody remembered to write down; it cannot cover tenant against tenant on an ordinary
name (`api`, `db`, `gamewatcher-db`), and those are not enumerable.

## Decision

1. **The Environment is the boundary.** An app deploys onto `deplo-env-<environmentId>`.
   Nothing crosses it - not two environments of one project, not two projects, not two
   teams. `apps.environment_id` is nullable, so an app at the top level or in a folder
   deploys onto its team\'s `deplo-team-<teamId>` instead; a solo instance therefore
   behaves exactly as it did. A pull request preview gets a network of its own and
   reaches nothing.

2. **Folders do not affect the network.** They are grouping and permissions. Dragging an
   icon must not disconnect a database.

3. **A managed database takes the same placement an app does** (`databases.environment_id`,
   nullable). Same rule for both, so there is one sentence to explain rather than two, and
   no app-to-database link table to keep true.

4. **The compose KEY stays `deplo`; only its `name:` changes.** The rendered stack declares
   `networks: {deplo: {name: deplo-env-…, external: true}}`. A hand-written
   `networks: [deplo]`, and every key that resolves to a platform network under an alias,
   is REWRITTEN onto the stack\'s own network rather than refused - the same YAML arrives
   from an import, and a copy-pasted compose file has to keep working.

5. **The reserved-name list survives, at two names.** Traefik sits on every tenant network
   and still resolves `deplo` (the panel route) and `docker-socket-proxy` (its Docker
   provider) by DNS, so those two remain claimable and remain refused. Pinning them to
   addresses instead needs subnet-pinned networks and is deliberately out of scope here.

6. **No compatibility with older agents.** The agent creates the network named in the
   Deploy/Reroute request and connects Traefik to it; one that does not is a hard failure
   at `compose up`, not a silent fall back to a shared network. Taken before the public
   release, when the fleet is small enough to move forward whole.

## Consequences

- **Moving an app is no longer a metadata write.** Every placement change
  (`moveAppToEnvironment`, `moveAppToProject`, `moveAppToFolder`, `deleteEnvironment`\'s
  reparenting, `transferApp`) brings the stack up again on the new network. Starting a
  stopped app re-renders it too, because `compose start` would otherwise return it to the
  network it was created on.
- **An app naming a service in another environment stops resolving it.** The deploy warns,
  with the name and where it lives, before the container tries; it never refuses, because
  the match is a heuristic (`S3_REGION=garage` is a region, not a host).
- **More networks per host.** One per environment in use, plus previews, against one per
  compose stack before. Both installers already widen Docker\'s address pool, and the
  cleanup gained a `leftover_networks` scope, fail-closed on an empty live list.
- **Upgrading is a one-time sweep at boot**, serial per host. A stack it cannot move stays
  where it is and keeps running; the count is on the Overview and the reasons are in
  Activity.
