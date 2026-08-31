# ADR-0028: An Environment owns a network

- **Status**: Accepted - 2026-08-30.
- **Amends**: the shared-`deplo`-network model described in `AGENTS.md`
  ("The shared `deplo` network is the PLATFORM\'s, not the stack\'s"). The reserved-name
  list it introduced stays, for the names the proxy still resolves.

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
   `networks: [deplo]`, and every key that resolves to a network DEPLO OWNS - the
   platform's own or another tenant's - COLLAPSES onto that one key rather than being
   refused: the same YAML arrives from an import, and a copy-pasted compose file has to
   keep working. It collapses rather than being re-pointed where it stands, because two
   keys naming one network is a container attached to it twice, which docker refuses.

5. **The reserved-name list survives.** Traefik sits on every tenant network and still
   resolves the platform's own names by DNS - `deplo` (the panel route) and
   `docker-socket-proxy` (its Docker provider) are the two that matter, and the list
   keeps the older spellings beside them (`RESERVED_SHARED_NETWORK_NAMES`, six in all).
   They remain claimable and remain refused. Pinning them to addresses instead needs
   subnet-pinned networks and is deliberately out of scope here.

   A service claims a name by JOINING a network, and a service that declares no
   `networks:` joins `default` - so a `default` aimed at a network Deplo owns is a join
   like any other, and every rule here reads that shape too. `network_mode:` is the
   other way in and takes a free-form string, so it is an allowlist (`none`, `default`)
   and is refused at the render when it names one of ours or interpolates a variable -
   that value comes from the env-file, where no static check can follow it.

   Every service of a stack joins, not only the routed ones: a worker with no domain is
   still the app, and leaving it on the compose project's private `default` put it out of
   reach of the very database its Environment owns. Two stay off - a service holding a
   reserved name (`postgres` is an ordinary name for a stack's own database) and every
   service of a compose whose author named the networks themselves - and in both cases the
   stack keeps a private `default`, or leaving one service off would split it in two and
   the lookup between them would stop resolving.

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
- **More networks per host.** One per Environment in use, plus one per preview, ON TOP of
  the `<project>_default` every compose stack already created. Both installers widen
  Docker\'s address pool, but only at install time and only from the daemon\'s next
  restart, so a host set up before that keeps its ~31 ceiling: an exhausted pool is
  explained in the deploy log (`explainNetworkError`), and the cleanup gained a
  `leftover_networks` scope, fail-closed on an empty live list.
- **Upgrading is a one-time sweep at boot**, serial per host. A stack it cannot move stays
  where it is and keeps running; the count is on the Overview and the reasons are in
  Activity.
