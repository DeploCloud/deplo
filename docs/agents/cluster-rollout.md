# Cluster rollout: shipping a `deplo-cluster` release

How a change to the cluster binary gets from a commit to the machines that run it. It is the
sibling of [`fleet-rollout.md`](fleet-rollout.md) and follows the same rules; this file only says
where the cluster binary differs. Read that one first for the pin, the asset contract and the
forward-only rule.

`deplo-cluster` (`DeploCloud/deplo-cluster`) is one static Go binary: a **cluster leader**, or with
`relay` a **cluster relay** ([ADR-0043](../adr/0043-a-cluster-is-led-by-its-own-leader-not-kubernetes.md),
[ADR-0044](../adr/0044-cluster-members-meet-through-a-relay-over-tcp.md)). The control plane never
dials it: the **server agent** that supervises it installs it and forwards calls, gated on the Hello
capability `cluster.host`.

## 1. The ship path

1. **Push a `v*` tag** in `DeploCloud/deplo-cluster`. The tag is the version: `release.yml` stamps
   `internal/cluster.Version` from `${GITHUB_REF_NAME#v}`.
2. **`release.yml` gates on `go test ./...`**, then builds static (`CGO_ENABLED=0 -trimpath`)
   `linux/amd64` + `linux/arm64`, writes `checksums.txt` with `sha256sum`, attests the binaries'
   provenance (the signature, Sigstore keyless) and publishes them. A canary tag is a pre-release.
3. **Pin it** in `package.json`: `"deplo": { "cluster": "<tag without v>" }`, and `clusterMin` only
   when the panel can no longer lead with an older one. Both are read by `lib/version.ts`
   (`CLUSTER_VERSION`, `CLUSTER_MIN_VERSION`, `clusterPinned()`).
4. **Ship the panel.** `docker-image.yml` refuses to publish one whose `deplo.cluster` has no
   `checksums.txt`.

**An unset pin is allowed, on purpose, while nothing is released.** Both keys are empty strings;
`clusterPinned()` is false, the tag workflow prints a notice instead of failing, and
`lib/version.test.ts` accepts "unset" only when the floor is unset too. The first release sets both.

## 2. The asset-name contract

```
deplo-cluster-linux-amd64
deplo-cluster-linux-arm64
checksums.txt          # sha256sum format: "<64-hex>  <filename>" per line
```

The agent verifies the sha256 from `checksums.txt` (and the attestation) before it installs or
replaces the binary, as SelfUpdate does for itself. A release without `checksums.txt` is refused,
never installed unverified.

## 3. The panel carries the leaders

**Deplo updates every leader and relay behind the pin on its own**
(`lib/data/clusters/binary-rollout.ts`), the way it carries the agent fleet (`fleet-rollout.md` §3).
A pass runs once a minute from the cluster watch tick, under its lease, so one Deplo instance does
it. Nothing runs while `deplo.cluster` is empty or while the instance is frozen by a Deplo move.

- **Who**: every server that runs the cluster binary - each cluster's `leader_server_id`, then
  Deplo's own machine, which runs the relay and stands in for every other leader. **One at a time,
  another server's leader first, Deplo's machine last**, for the reason in `fleet-rollout.md` §4.
- **Forward only**: the pass asks the agent what runs (`ClusterStatus`) and installs only when the
  pin is newer. One on the pin or ahead of it is left alone; the agent refuses a downgrade too. A
  server that does not answer is skipped, not failed: nobody knows it is behind.
- **The agent first**: a server whose agent is behind `deplo.agent` is skipped until the agent
  rollout has updated it (§4). Not a failure: that rollout says where the server stands.
- **What ran beside the leader still does**: the install keeps the relay flag the status reports.
- **Activity**: "Updated the cluster leader and relay on <server> to v<pin>", by Deplo, in the team
  of the admin who moved a leader there (`clusters.leader_team_id`), else the instance's first team,
  where the agent rollout's entries land.
- **A failure is one row** in `cluster_binary_updates` (none means idle; success deletes it), so the
  wait survives a restart. Retries back off 1, 2, 4 … 60 minutes and never stop. The first failure
  is one Activity entry ("Could not update … Deplo retries on its own."), and the cluster card shows
  the sentence until it clears (`ClusterLeader.updateMessage`). A new pin ignores the old rows.
- **`busy`**: a leader is not restarted while a server of a cluster it leads stopped answering in
  the last 45 minutes. A restart there starts the 81 s failover clock over and holds it for the 5
  minutes of §5's extension.
- **`no_return`**: the leader took the binary and did not start on it. The pass stops, and later
  passes try only that server: a release that breaks one leader must not reach the one that stands
  in for it.

There is no manual path and no script. "Try again" on the cluster card installs the pin on a leader
that is not running; a running one is the rollout's.

## 4. Order: agent, then cluster binary, then the panel pin

1. **The agent release, and the fleet on it** (`fleet-rollout.md`). The agent is what installs,
   stops and starts the cluster binary. Ignore this and: a cluster binary that needs a new agent
   behaviour (a new call it forwards, the stop order below) lands on agents without it. The install
   itself is refused with "needs a newer server agent" only when a Hello capability gates it, so
   **a change the cluster binary needs from the agent gets a capability**, or it fails silently.
2. **The cluster release** (§1), published with `checksums.txt`. Ignore this and: the panel's tag
   workflow refuses the pin, or, pinned by hand, every pass finds no release and updates nothing.
3. **The panel, with `deplo.cluster` moved** and `deplo.clusterMin` only when it must. The panel
   then carries each server's agent first and its leader after (§3). Ignore this and: a panel that calls a leader method the pinned binary does not
   serve gets a 404 from every leader, and placing an App on a cluster fails with "the leader did
   not answer".

**Raise `clusterMin` one panel release after the binary it asks for, whenever you can.** Below the
floor a leader is refused at once, before the rollout has updated anything: a cluster led from
another server is handed to Deplo's machine and back (two changes of hands, two epochs), and one led
from Deplo's machine has nobody leading until its own update lands, about a minute. Pin the binary
in one release, raise the floor in the next, and neither happens.

## 5. A leader update costs no failover

On SIGTERM a leader extends every member's lease by 5 minutes before it exits (`Leader.Drain`,
`lease.ExtendFor`), keeps what it extended in its state directory, and holds every failover of a
silent member until that time is up. So a restart of up to 5 minutes stops nothing on any member,
and nothing moves when the leader is back. The agent ends **the leader before the relay** and gives
it 20 s, because those last orders leave through the relay beside it.

While Deplo restarts a leader, nobody stands in for it (`updatingClusterHost`): standing in would
cost two changes of hands for a few seconds of silence.

What it does not cover: a leader that extended its leases and then never came back. Deplo's machine
takes over after two missed checks and does not know about the extension, so a member that is cut
off from it, yet alive, could have its database started elsewhere up to 5 minutes early. Two
failures at once; the `no_return` pause keeps a bad release from causing the first one twice.

## 6. Below the floor

Below `deplo.clusterMin` a leader is refused (`callClusterLeader`), the card says "Needs an update",
and Deplo's own machine leads that cluster from the next epoch until the rollout has updated it;
then the leader leads again, from another epoch. Activity says both, in the team of the admin who
moved the leader: "The leader on <server> is older than this Deplo accepts, so Deplo's machine leads
cluster <name> until it is updated", then "<server> answers again, so it leads cluster <name> again".

## 7. The relay is part of the same release

`deplo-cluster relay` runs beside the leader on Deplo's machine, behind the proxy
([ADR-0044](../adr/0044-cluster-members-meet-through-a-relay-over-tcp.md)). Its names are a contract
across three repos: the path `/api/cluster/relay` and port `3002` (`lib/deploy/cluster-relay.ts`),
the stream headers and mutual TLS rules (`internal/wire` here and in `deplo-agent`'s
`internal/clusterlink/wire`), and the roster push (`relay.roster` on the relay's local socket). Change
one and the other two move in the same step. The agent half needs a Hello capability the panel gates
on: `cluster` (membership and relay dialing), so an agent from before it is named, never failed.

The lease is a second contract of the same shape: the order each renewal carries and the 5 s / 15 s /
60 s timings (`internal/lease` here and in `deplo-cluster`, `internal/clusterlink/lease` in
`deplo-agent`), and the leader's watch (`/watch`, the `ClusterWatch` RPC, `lib/data/clusters/watch.ts`).
A member refuses an older epoch and keeps the one it holds across restarts, so never lower the epoch a
leader sends; Deplo adopts a newer one the leader reports.

## 8. Rollback is forward-only

Same as the fleet (`fleet-rollout.md` §10): nothing installs an older cluster binary than the one
running, and a bad release is undone by pinning a fixed patch release. Never release a cluster
binary that drops something an older pinned panel still relies on.
