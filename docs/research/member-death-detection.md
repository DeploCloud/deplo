# Detecting a dead cluster member

Research for [#151](https://github.com/DeploCloud/deplo/issues/151) (map [#147](https://github.com/DeploCloud/deplo/issues/147)). Code references are to `main` at `0aa4d810` and to `DeploCloud/deplo-agent` at `b124c95d`.

## Summary

1. Today Deplo notices a silently dead server **35 to 60 s** after it dies (the agent pings every 20 s, the panel cuts a link silent for 45 s, then waits a 10 s grace before writing **offline**); a clean shutdown shows in about **10 s**. Nothing acts on that verdict except alerts.
2. "Offline" means "no link to Deplo", not "dead": the agent stops nothing when its link drops, and every App keeps serving visitors under `restart: unless-stopped`. Failing over on that signal alone runs the App twice.
3. Established systems all separate _suspecting_ a node from _acting_ on it, and act only after the node is known to have stopped: by fencing it from outside (STONITH), by a lease the node itself honours (Chubby, Patroni, Nomad `stop_on_client_after`, Raft leader leases), or by a token the resource checks (fencing tokens).
4. Deplo cannot fence from outside: nothing dials a server (ADR-0040), and many servers have no power API. Member-to-member gossip (SWIM) is also out, because it needs every member to accept connections. **Self-fencing under a lease is the only fence available.**
5. Its cost is the one Nomad documents: a member cannot tell "I am cut off" from "the leader is down", so it stops its fenced workloads in both cases. Fence only what running twice actually breaks, and size the lease above routine restarts.

**Recommendation.** The leader grants each member a **lease** renewed every 5 s over whatever path #149 settles. A member that has had no renewal for **60 s** (its own monotonic clock) stops its **single-writer workloads only** (a managed database primary, an App with a volume, a scheduled job) and starts them again only under a fresh lease. Stateless Apps never self-fence. The leader suspects a member after 15 s of silence and starts failover no earlier than **lease × 1.01 + stop time (15 s) + 5 s ≈ 81 s after the last renewal it _sent_**. It fails over nothing when it lost its own path, or when more than half of the members went silent together. Every grant and order carries the leader's **epoch** (a fencing token), which the agent checks. Before a planned restart of Deplo, an agent or the leader, leases are extended so the restart costs nothing.

## 1. How Deplo detects a lost agent link today

### The heartbeat

- The **agent** opens the link and pings the panel every **20 s**, and drops the link when a pong is not back within **10 s** (`deplo-agent` `internal/link/link.go:45-46`, loop `link.go:213-230`, drop `link.go:202-205`). The comment says the 20 s interval is chosen to stay under proxy idle timeouts, because gRPC keepalives stop when no call is open (`link.go:44`).
- The **panel** never pings. It records "heard" on any ping, pong or message (`lib/infra/agent-link/door.ts:93`) and terminates a link it has heard nothing from for **45 s** (`LINK_WATCHDOG_MS`, `lib/infra/agent-link/protocol.ts:10-11`), checking every `min(5 s, 45 s / 3)` = **5 s** (`door.ts:95-100`, default wired at `listener.ts:71`).
- A link that ends (watchdog, close, error) emits a `down` event, but only if it is still the server's current link (`registry.ts:136-140`). A newer verified link replaces the old one and emits `up` (`registry.ts:124-134`). So when an agent reconnects before the old link times out, the panel never sees a `down` at all.

### The grace window

- On `down`, server status starts a timer of `LINK_WAIT_MS` = **10 s** (`protocol.ts:12-13`; `lib/data/server-health.ts:278-289`, `311-315`). If no link has come back when it fires, **offline** is written (`server-health.ts:318-323`). A link that comes back cancels the timer and writes the status from its Hello (`server-health.ts:326-342`).
- A call that finds no link waits the same 10 s for one before failing as offline (`lib/infra/agent-client/channel-pool.ts:61`, message at `errors.ts:25`). ADR-0040 states both rules (`docs/adr/0040-a-server-agent-links-to-its-control-plane.md:15`).
- During the probe path, a server inside the grace is reported as "waiting" and nothing is written (`server-health.ts:177-178`, `302-309`). A Hello lost on a live link proves nothing and writes nothing (`server-health.ts:185-187`).
- After the panel itself restarts, every link is closed with code 1001 (`registry.ts:147-154`) and no server is judged for `LINK_SETTLE_MS` = **45 s** (`protocol.ts:14-15`, `registry.ts:61-65`). The registry lives in memory, in one process (`registry.ts:36`), so what the panel knew about each link is lost on restart.

### Reconnecting

- The agent waits a **jittered** backoff before redialing, starting at 1 s and doubling up to **30 s** (`link.go:33-34`, `122`, `139`). Jitter spreads each wait over its upper half (`link.go:168-171`). A link that lasted **30 s** resets the backoff to 1 s (`link.go:47-48`, `119-121`). A dial gives up after **15 s** (`link.go:32`).

### What that adds up to

| Event                                                                       | When the panel says **offline**                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Power cut, cable pulled, network partition (no TCP close reaches the panel) | 25-50 s to cut the link (last ping up to 20 s before death, cut after 45 s of silence, checked every 5 s), then +10 s grace: **35-60 s**                                                                                          |
| Agent process exits or the machine shuts down cleanly                       | Close at once, +10 s grace: **≈10 s**                                                                                                                                                                                             |
| Agent restart or update that relinks within 10 s                            | Never                                                                                                                                                                                                                             |
| A network blip                                                              | Never, unless the agent stays unable to relink for longer than the watchdog window. A blip over 10 s that swallows a pong makes the agent drop and redial (`link.go:202-205`); its new link replaces the old one without a `down` |

Two limits matter for a cluster:

- **The verdict is about the link, not about the machine.** The link passes through the panel's proxy (`protocol.ts:3`), so even TCP-level signals describe the proxy's connection, not the member. Only the application-level ping is evidence.
- **Nothing acts on it.** The stored status is a cache the UI qualifies, never a gate (CONTEXT.md, **Server health**); the only consequence of offline is an alert (`server-health.ts:119`, `133-167`). The agent's link package imports nothing that touches containers (`link.go:4-21`). Apps and managed databases keep running and serving under `restart: unless-stopped` (`lib/deploy/build/compose-render.ts:144`, `lib/deploy/database-compose.ts:171`). An offline server is very often a server that is still serving visitors.

## 2. How established systems decide a node is dead

### Kubernetes: a short timeout to suspect, a long one to act

- Each kubelet renews a Lease in `kube-node-lease`. "The lease is currently renewed every 10s", and the lease lasts **40 s** by default (`nodeLeaseDurationSeconds`) [K-kubelet]. Node status is posted on change or every 5 min [K-kubelet]; every heartbeat is an update to `spec.renewTime` [K-leases].
- The node lifecycle controller checks every **5 s** (`--node-monitor-period`) and marks a node unhealthy after **50 s** without a heartbeat (`--node-monitor-grace-period`) [K-kcm]. It then sets `Ready` to `Unknown` and taints the node `node.kubernetes.io/unreachable:NoExecute` [K-nodes][K-taints].
- Pods get an automatic toleration of `tolerationSeconds=300`, so "Pods remain bound to Nodes for 5 minutes after one of these problems is detected" [K-taints]. Detection-to-eviction is therefore about **5 min 50 s** by default. The 5 min wait is described the same way on the Nodes page [K-nodes].
- **Correlated failure is not believed.** Evictions run at 0.1 node/s. When at least 55 % of a zone's nodes are unhealthy, the rate drops to 0.01/s, and to zero in clusters of 50 nodes or fewer. When every zone is unhealthy, the controller "assumes that there is some problem with connectivity between the control plane and the nodes, and doesn't perform any evictions" [K-nodes][K-kcm].
- **Eviction does not stop the old copy.** "The decision to delete the pods cannot be communicated to the kubelet until communication with the API server is re-established. In the meantime, the pods that are scheduled for deletion may continue to run on the partitioned node" [K-taints].
- **Stateful workloads are not moved on a timeout at all.** A StatefulSet guarantees "at most one Pod with a given identity", and "a Pod is not deleted automatically when a node is unreachable". Force-deleting it "can lead to the duplication of a still-running Pod" and "may lead to data loss (e.g. split brain scenario in quorum-based systems)" [K-sts]. A human must confirm the node is down, by deleting the Node or with the `out-of-service` taint, which "should be verified that the node is already in shutdown or power off state" [K-shutdown].
- Its own controllers use a lease for leadership: 15 s lease, renew deadline 10 s ("must be less than the lease duration"), retry 2 s. A leader that cannot renew by the deadline stops leading [K-kcm].

### Nomad: heartbeat TTL, and the client stops its own work

- The heartbeat TTL scales with cluster size (`clients / max_heartbeats_per_second`, default 50/s), never below `min_heartbeat_ttl` (10 s), with random spread up to 2× and `heartbeat_grace` (10 s) added. After a leader election, clients get `failover_heartbeat_ttl` (5 min) [N-server].
- The `disconnect` block replaced `stop_after_client_disconnect`, `max_client_disconnect` and `prevent_reschedule_on_lost` in 1.8. Those fields were removed in 1.10 [N-upgrade].
  - `lost_after`: how long the server waits for a disconnected client before declaring its allocations lost. `replace`: whether a replacement runs meanwhile. `reconcile`: which copy wins when the node returns (`keep_original`, `keep_replacement`, `best_score`, `longest_running`) [N-disconnect].
  - `stop_on_client_after`: "a duration after which a disconnected Nomad client will stop its allocations". This is client-side self-fencing. In the documented example the server replaces the group after `heartbeat_grace` + 90 s, while the client stops it at 90 s [N-disconnect].
  - Its documented costs: "a group using this feature will be stopped on the client if the Nomad server cluster fails", and with unsynchronised clocks the server may replace the group before the client has stopped it ("Operators should ensure that clock drift between servers is as small as possible") [N-disconnect].

### Consul / Serf: SWIM gossip and Lifeguard

- Consul's LAN gossip is Serf, built on memberlist, which is "based on SWIM" (Das, Gupta, Motivala, DSN 2002) and extended with **Lifeguard** [C-gossip][M-readme][SWIM].
- SWIM detection: each member probes one random member per period. If there is no ack, it asks `k` others to probe indirectly, then marks the member _suspect_ before _dead_. memberlist's LAN defaults are a 1 s probe interval, 500 ms timeout and 3 indirect checks. Suspicion lasts `SuspicionMult × log(N+1) × ProbeInterval` (4× on LAN; 5 s / 3 s / 6× on WAN) [M-config].
- Lifeguard found that "slow message processing can cause SWIM to mark healthy members as failed" and adds local-health awareness, which "drastically reduces the rate of false positives" [Lifeguard].
- **It needs every member to accept connections**: Serf LAN uses port 8301 TCP and UDP, inbound and outbound, between servers and clients in a datacenter [C-ports].

### Phi-accrual failure detectors

- Instead of a yes/no timeout, the detector outputs a suspicion level `phi = -log10(1 - F(timeSinceLastHeartbeat))`, where `F` is fitted to the heartbeat intervals seen so far (Hayashibara et al., SRDS 2004) [Akka-fd][Phi].
- Akka's default threshold is 8, and it suggests 12 on EC2. "A low threshold is prone to generate many false positives but ensures a quick detection in the event of a real crash" [Akka-fd].
- It adapts to a jittery link, but it is still only a detector. It decides nothing about fencing.

### Leases and the clock assumption (Raft, Chubby)

- Raft can serve reads from a leader lease: followers will not elect before an election timeout, so the leader may act for `election timeout / clock drift bound`. "The lease approach assumes a bound on clock drift across servers", and "if the assumptions are violated, the system could return arbitrarily stale information" [Raft-thesis]. The bound concerns clock **rate**, not synchronised wall clocks. Each side measures a duration on its own clock.
- Chubby's client keeps "a local lease timeout that is a conservative approximation of the master's lease timeout". When it expires, the client is "in jeopardy" and waits a further "grace period, 45s by default" [Chubby]. The holder deliberately believes its lease ends **before** the server does.

### Fencing: STONITH and fencing tokens

- Pacemaker defines fencing as "the ability to make a node unable to run resources, even when that node is unresponsive to cluster commands" (typically by cutting power). It warns against assuming an uncommunicative node is down, because then several copies of a resource could start [Pacemaker].
- Chubby's **sequencer** carries the lock's generation number, and servers check it before acting. A lock freed because its holder failed can be held back by a **lock-delay** of up to one minute [Chubby].
- Kleppmann's **fencing token**: a number that grows with every grant. A holder paused past its lease still sends its old token, and the storage "remembers that it has already processed a write with a higher token number" and refuses it. It "requires the storage server to take an active role in checking tokens" [Kleppmann].
- Patroni (PostgreSQL high availability) is the self-fencing version of the same idea. When the primary cannot renew its leader key it stops PostgreSQL, because PostgreSQL must not accept commits after the key expires. As a backstop for a hung Patroni it arms a watchdog that resets the machine. With `ttl=30`, `loop_wait=10` it fires 5 s before the key expires [Patroni].

## 3. Self-fencing on a member

### What a member can do alone

A member that loses its leader can only act on its own clock. The pattern common to Nomad `stop_on_client_after`, Patroni, Chubby jeopardy and the Kubernetes renew deadline is: **the holder gives up before the grantor gives the work away**. That makes it safe if three conditions hold:

1. The member counts its lease from when it **received** the grant. The leader counts from when it **sent** it, and from the last grant sent, not the last one acknowledged, because an unacknowledged grant may still have arrived. So the member's lease always ends before the leader's view of it does.
2. The leader waits `L × (1 + ρ) + T_stop + margin`, where `ρ` bounds clock-rate drift [Raft-thesis] and `T_stop` is how long stopping the workload takes. Both sides use monotonic clocks, so no time sync is needed.
3. The fence still runs when the agent is unhealthy. A hung agent fences nothing while Docker keeps the containers running. Patroni solves this with a hardware watchdog [Patroni]. The cheap equivalent is a systemd `WatchdogSec=`: a service that stops sending keep-alive pings "is placed in a failed state" and is restarted with `Restart=on-watchdog` [systemd]. On every start, the agent should check its saved lease expiry and fence before doing anything else. What remains is an agent that never starts again, a residual risk to name in the spec.

### The trade-off with false failovers

- A member cannot tell **"I am cut off"** from **"the leader (or the path to it) is down"**. Nomad states the consequence plainly: with self-fencing on, a server-side outage stops the work on every client [N-disconnect]. For Deplo this is sharp: Deplo restarts on every update (all links drop with 1001, then 45 s to settle, `registry.ts:147-154`, `protocol.ts:14-15`), and the leader path is still open (#149). A short lease turns every routine restart into an outage of every fenced workload.
- A short network blip is cheap at the detection layer (section 1: the agent relinks, no `down`), but expensive at the fencing layer if the lease is shorter than the blip.
- So the lease is the one knob that trades split-brain safety against false stops, and two rules shrink what is at stake:
  - **Fence only what running twice breaks.** A stateless App running on a cut-off member is just one more replica: its writes still go to the one database primary. The harm comes from **single-writer** workloads: a managed database primary (two primaries diverge), an App with a volume (two copies of the data diverge), a scheduled job (runs twice). This is the Kubernetes split between Deployments, moved on a timeout, and StatefulSets, which need proof [K-sts]. It also means a leader outage never takes a stateless App down.
  - **Extend leases before a planned restart.** Deplo knows when it restarts itself, an agent or a leader. A long lease issued just before covers it, so only unplanned outages longer than the lease cost a stop.

## Recommendation

### Detection signals, in order of trust

1. **Lease renewals from the leader, acknowledged by the member**, over whatever path #149 settles, every **5 s**. The leader measures silence on its own monotonic clock.
2. **The member's agent link to Deplo** (section 1), as a second, independent witness when the leader is not on Deplo's machine. A member alive on **any** path is not dead.
3. **Correlation.** A member is not judged while the leader's own path is down. When more than half of a cluster's members go silent within one lease, the problem is assumed to be on the leader's side (as Kubernetes does with a whole zone [K-nodes]), and nothing fails over. Members are failed over one at a time.
4. **Visitor reachability** (optional, informative only). The leader can request one of the member's Apps on the member's own address (CONTEXT.md, **Agent link**: "a server's address stays, for its apps' domains"). An answer proves the member is up and cut off, which is what the user should be told. A stateless App still answering on a cut-off member is expected, so this is a message, not a safety veto.
5. Close codes and TCP closes are hints for "reconnecting", never evidence of death: an agent restart closes the link too (section 1).

Phi-accrual is not needed for v1. With a few members and one path each, a fixed timeout is simpler to explain, and phi decides nothing about fencing. SWIM is ruled out by the outbound-only rule [C-ports].

### Default timings

|                                                                  | Default                                                                              | Why                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lease renewal                                                    | every 5 s                                                                            | 12 chances per lease. The existing 20 s ping stays for the link itself                                                                                                                                              |
| Member shown as **not responding**                               | 15 s of silence                                                                      | 3 missed renewals. Display only                                                                                                                                                                                     |
| Member lease `L`                                                 | **60 s**                                                                             | Longer than an agent restart (backoff starts at ≤1 s, `link.go:33`) and than Deplo's own relink settle (45 s, `protocol.ts:15`), and on the order of Patroni's 30 s `ttl` and Chubby's 45 s grace [Patroni][Chubby] |
| Leader may fail over a single-writer workload                    | `L × 1.01 + T_stop + 5 s` ≈ **81 s** after the last renewal _sent_ (`T_stop` = 15 s) | Condition 2 above. Kubernetes takes ~5 min 50 s and moves stateful work only on proof [K-taints][K-sts]. Nomad's example is grace + 90 s [N-disconnect]                                                             |
| Leader may move a stateless App                                  | same moment                                                                          | No fencing is needed, but waiting keeps one rule. A stateless App is only moved when routing (#148) sends visitors to the dead member                                                                               |
| Leader's own lease (remote leader → Deplo's machine taking over) | 15 s lease, stops leading at 10 s                                                    | The Kubernetes controller defaults [K-kcm]. Well inside `L`, so members' leases survive a leader handoff                                                                                                            |

The lease length could be an expert setting per cluster (advanced mode), never on the creation path.

### Fencing rule for outbound-only members

1. **A member holds one lease from its leader.** At `L` without a renewal, the agent stops its single-writer workloads, and only those. It refuses to start them again until a fresh lease arrives. Stateless Apps keep running. One-member clusters never fence (the map: failover starts at two).
2. **The leader never hands a single-writer workload to another member before `L × 1.01 + T_stop + margin`** after the last renewal it sent that member.
3. **Every grant and every order carries the leader's epoch**, a number that grows with every leader handoff, and with every failover for that workload. The agent refuses an order from an older epoch, so the agent itself is "the storage server" that checks the token [Kleppmann][Chubby]. A member that comes back stops its copy of a workload that has moved before its new lease is granted. The copy that stays follows the rule picked at failover, `keep_replacement` by default [N-disconnect]. The managed-database promotion term in #150 should be the same token.
4. **The fence does not depend on a healthy agent:** a systemd watchdog restarts a hung agent, and the agent checks its saved lease expiry first thing on start [systemd][Patroni].
5. **Planned restarts of Deplo, an agent or a leader extend leases first**, so routine maintenance never stops a database.

Open edges for the spec: an agent that never restarts after a crash (rule 4's residual risk), and how a lease travels before #149 decides the leader↔member path.

## Sources

Deplo (this repo at `0aa4d810`):

- `lib/infra/agent-link/protocol.ts:3-15`, `door.ts:93-107`, `registry.ts:36`, `61-65`, `124-154`, `listener.ts:71`
- `lib/data/server-health.ts:119`, `133-167`, `177-187`, `278-342`
- `lib/infra/agent-client/channel-pool.ts:61`, `errors.ts:25`
- `lib/deploy/build/compose-render.ts:144`, `lib/deploy/database-compose.ts:171`
- `docs/adr/0040-a-server-agent-links-to-its-control-plane.md:15`, `docs/adr/0043-a-cluster-is-led-by-its-own-leader-not-kubernetes.md`, `CONTEXT.md` (**Agent link**, **Server health**)

deplo-agent at `b124c95d9b2ccfbaa65e467d4133e0c7360a6a26`:

- `internal/link/link.go:4-21`, `32-48`, `99-140`, `168-171`, `183-230`: https://github.com/DeploCloud/deplo-agent/blob/b124c95d9b2ccfbaa65e467d4133e0c7360a6a26/internal/link/link.go

External:

- [K-kcm] kube-controller-manager flags: https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/
- [K-nodes] Nodes (node controller, rate limits on eviction): https://kubernetes.io/docs/concepts/architecture/nodes/
- [K-leases] Leases: https://kubernetes.io/docs/concepts/architecture/leases/
- [K-kubelet] Kubelet configuration v1beta1: https://kubernetes.io/docs/reference/config-api/kubelet-config.v1beta1/
- [K-taints] Taints and tolerations, taint-based evictions: https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/
- [K-sts] Force delete StatefulSet pods: https://kubernetes.io/docs/tasks/run-application/force-delete-stateful-set-pod/
- [K-shutdown] Node shutdowns, non-graceful: https://kubernetes.io/docs/concepts/cluster-administration/node-shutdown/
- [N-server] Nomad server configuration (heartbeats): https://developer.hashicorp.com/nomad/docs/configuration/server
- [N-disconnect] Nomad `disconnect` block: https://developer.hashicorp.com/nomad/docs/job-specification/disconnect
- [N-upgrade] Nomad upgrade guides (1.8 deprecation, 1.10 removal): https://developer.hashicorp.com/nomad/docs/upgrade/upgrade-specific
- [C-gossip] Consul gossip protocol: https://developer.hashicorp.com/consul/docs/concept/gossip
- [C-ports] Consul ports: https://developer.hashicorp.com/consul/docs/install/ports
- [M-readme] hashicorp/memberlist README: https://github.com/hashicorp/memberlist
- [M-config] hashicorp/memberlist `config.go`: https://github.com/hashicorp/memberlist/blob/master/config.go
- [SWIM] A. Das, I. Gupta, A. Motivala, "SWIM: Scalable Weakly-consistent Infection-style Process Group Membership Protocol", DSN 2002, doi:10.1109/DSN.2002.1028914
- [Lifeguard] A. Dadgar, J. Phillips, J. Currey, "Lifeguard: Local Health Awareness for More Accurate Failure Detection", arXiv:1707.00788: https://arxiv.org/abs/1707.00788
- [Phi] N. Hayashibara, X. Défago, R. Yared, T. Katayama, "The φ Accrual Failure Detector", SRDS 2004, pp. 66-78; technical report IS-RR-2004-010: https://dspace02.jaist.ac.jp/dspace/bitstream/10119/4784/1/IS-RR-2004-010.pdf
- [Akka-fd] Akka phi accrual failure detector: https://doc.akka.io/libraries/akka-core/current/typed/failure-detector.html
- [Raft-thesis] D. Ongaro, "Consensus: Bridging Theory and Practice", Stanford 2014, §6.4 (`clients/clients.tex`): https://github.com/ongardie/dissertation
- [Chubby] M. Burrows, "The Chubby lock service for loosely-coupled distributed systems", OSDI 2006, §2.4, §2.8: https://www.usenix.org/legacy/event/osdi06/tech/full_papers/burrows/burrows_html/
- [Kleppmann] M. Kleppmann, "How to do distributed locking", 2016: https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html
- [Pacemaker] Pacemaker Explained, Fencing: https://clusterlabs.org/projects/pacemaker/doc/3.0/Pacemaker_Explained/html/fencing.html
- [Patroni] Patroni watchdog support: https://patroni.readthedocs.io/en/latest/watchdog.html
- [systemd] systemd.service(5), `WatchdogSec=`: https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
