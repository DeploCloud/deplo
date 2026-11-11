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

### A leader that extends its leases and never comes back

Deplo's machine takes over after two missed checks and 25 s without a beat (below), and it cannot
read what the old leader extended:
that file is on the server that is gone. So the rule holds without it. **A leader presumes that a
member it has never heard holds the longest lease any leader may grant** (60 s + `lease.ExtendFor`,
5 minutes), counted from the moment it first knew the member: a takeover, a hand-back, a moved
leader, a leader that restarted, a member that just joined (`member.presumed` in `internal/leader`).

- **A member that answers** the new leader once holds a plain 60 s lease from it, and the usual
  clock applies from then on: 81 s of silence, then its work moves.
- **A member that never answers** keeps its databases and Apps with a Volume for
  60 s + 5 min + the 21 s margin = **6 min 21 s after the leader started leading**, then they move
  (or are promoted, or wait for a backup) as in any failover. A person's "bring it back from a
  backup" is refused for the same time (`still_answering`). Its Apps without a Volume still move
  after 81 s: two copies of those harm nothing, and the member removes its own when it returns.
- So a server that stops **together with the leader that ran on it** gets its Apps back after about
  2 minutes (half a minute to notice, 81 s) and its databases after about 7. That is the honest
  number for this case; the 81 s everywhere else is for a leader that was already leading.

Why it is safe: an older epoch is refused by a member that heard the new one, and a leader that
hears that refusal stops sending within one renewal, so the last extension an old leader can still
land comes seconds after the takeover; the 21 s margin covers it, as it covers a plain lease. And
the bound does not rest on the leader's version: **the agent cuts `extendSeconds` to 5 minutes
itself** (`lease.ExtendFor` in `deplo-agent`), so raise it in `deplo-cluster` first and in the agent
last, never the agent alone.

An old leader that never hears that refusal, because a network split keeps it and the members beside
it from everyone else, is the next section's subject.

### Two leaders at once: only one of them leads

Deplo's machine stands in for a leader it cannot reach, and that leader may be alive on the far side
of a split, renewing the members beside it. An epoch does not stop it: nobody it reaches holds the
newer one. So **a leader leads only while it is sure a quorum of its members takes its epoch**, and
one that is not sure renews nobody, extends nothing, moves nothing and refuses a person's move
(`cluster.leads` in `internal/leader`).

- **A quorum** is more than half of the members in its roster, or **exactly half while Deplo named
  its epoch in the last 20 s** (`DeploFor`). Deplo's word is the **beat**: every 5 s
  `beatClusterLeaders` (`lib/data/clusters/leader-beat.ts`) sends `leader.beat {epochs}` through the
  agent to the leader each cluster is stored on (`leaderHost`), and to no other.
- **Sure** lasts 10 s (`SureFor`, two renewals) from the start of a round a quorum answered. A leader
  that is not sure sends a **probe** first (`lease.Order.Probe`): the member takes the epoch, refuses
  every older one from then on, and its lease is not renewed. With a quorum of answers the renewals
  follow in the same tick. A drain always asks again before it extends.
- **Deplo waits before it lets another leader lead**: the two missed checks, and 25 s
  (`TAKEOVER_AFTER_MS`) since the last beat that left for the old leader, answered or not. A Deplo
  that just started counts from its start. That is longer than a leader trusts a beat, so two halves
  never both hold Deplo's word. **Change `DeploFor` and `TAKEOVER_AFTER_MS` together.**
- **A leader Deplo can reach is told** it was replaced, on a hand-back and on a move
  (`tellLeaderReplaced`, the beat with the newer epoch): it stops at once and takes no older roster.
- **A leader that becomes sure after it was not** presumes again that each member it never heard
  holds the longest lease, from that moment: an older leader may have led them meanwhile.

**Why it is safe.** A member answers one epoch at a time and never an older one, so an answer is a
vote. Two groups of more than half share a member, so do a half and more than half, and two halves
never both have Deplo's word. Once the newer leader is sure, at `s`:

- The older one gets no quorum again. Its last confirming answer came before `s + 4 s` (one send
  timeout), so its last renewal leaves before `s + 14 s` and lands by `s + 18 s`; an extension always
  follows a fresh question, so the last one lands by `s + 12 s`. Every lease it gave is over by
  `s + 78 s`, or `s + 372 s` when extended, and it decides no move after `s + 14 s`.
- The newer one moves the single-writer work of a member it never heard no earlier than `s + 376 s`,
  and of a member it heard, which the older one can no longer renew, after the usual 81 s.
- A leader that hears too few never renews a member, so nothing it would keep alive is running when
  the other side moves that member's work after 81 s.

What each case costs to stay safe (`internal/leader/split_test.go` pins every row):

| Case                                            | Who leads                         | What is lost                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No split                                        | The leader                        | Nothing.                                                                                                                                                                                                                                                                                          |
| Deplo down, every member up                     | The leader, any size of cluster   | Nothing.                                                                                                                                                                                                                                                                                          |
| Deplo down, fewer than half of the members dead | The leader                        | Nothing: their work fails over on the usual clock.                                                                                                                                                                                                                                                |
| Deplo down, exactly half dead (one of two)      | Nobody                            | No failover. 20 s after Deplo's last beat the leader stops renewing the members that are left, and a minute later they stop their databases and Apps with a Volume. Apps without one keep running. It all starts again within seconds of Deplo being back, and the dead members' work moves then. |
| More than half dead at once, Deplo up or down   | Nobody                            | The same for the members that are left, until a member returns or the dead ones are removed from the cluster: a smaller roster has a smaller quorum.                                                                                                                                              |
| Split, old leader with fewer than half          | Deplo's machine                   | The old side stops its single-writer work about a minute into the split. Deplo's leader starts it elsewhere after 6 min 21 s; Apps without a Volume after 81 s.                                                                                                                                   |
| Split, old leader with more than half           | The old leader                    | Deplo's leader hears too few: it renews nobody and moves nothing, so Deplo's side stops its single-writer work after a minute and the old leader moves it after 81 s. Deplo cannot see that side until the split heals.                                                                           |
| Even split                                      | Deplo's machine, on Deplo's word  | The old leader stops renewing 20 s after its last beat; its half stops its single-writer work a minute later and Deplo's leader moves it after 6 min 21 s.                                                                                                                                        |
| Leader on Deplo's machine, the default          | It alone: nobody stands in for it | With exactly half of the members unreachable, a Deplo restart longer than about 80 s stops the other half's single-writer work until Deplo is back.                                                                                                                                               |
| One member                                      | The leader, with or without Deplo | Nothing: one of one is more than half.                                                                                                                                                                                                                                                            |
| The split heals                                 | The newer epoch                   | Nothing: the old leader asks first, hears the newer epoch and steps down without renewing anyone.                                                                                                                                                                                                 |

**A workload the roster calls waiting is not started on its word.** A leader that takes over reads
"waiting for room" in Deplo's picture, and the old leader may have handed that workload back to a
member in an event Deplo never read. For a single-writer one, the new leader starts nothing, and
takes no person's move, until every member has answered it or its longest lease is over. A member
names the stacks its order places nowhere that it still has (`lease.Reply.Unplaced`), the leader
gives them back to it, and such a stack stops with that member's lease like any of its own.

What this still does not cover: a move the old leader made in its last seconds that Deplo had not
read when it handed the cluster on. The new leader's picture places that workload on its old member,
which runs it again if it answers, beside the old leader's copy until that member's lease runs out.

The `no_return` pause still matters: it keeps a bad release from taking the second leader down too.

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
The probe and the stacks a member still has (§5) are part of it: an agent that renewed on a probe
would keep a replaced leader's members alive, so the agent ships first, as always. The beat is a
third: `leader.beat`, 5 s apart, trusted for 20 s by the leader and waited out for 25 s by the panel.
A member refuses an older epoch and keeps the one it holds across restarts, so never lower the epoch a
leader sends; Deplo adopts a newer one the leader reports.

## 8. Rollback is forward-only

Same as the fleet (`fleet-rollout.md` §10): nothing installs an older cluster binary than the one
running, and a bad release is undone by pinning a fixed patch release. Never release a cluster
binary that drops something an older pinned panel still relies on.
