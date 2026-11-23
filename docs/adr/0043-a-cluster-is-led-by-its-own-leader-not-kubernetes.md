# ADR-0043: A cluster is led by its own leader, not by Kubernetes

**Status**: proposed; amended 23 Nov 2026 (the leader lives inside the cluster, below). Builds on [ADR-0006](0006-server-agent-is-a-per-host-go-binary.md) and [ADR-0040](0040-a-server-agent-links-to-its-control-plane.md).

Kubernetes is the usual answer to running Apps across several machines. The need underneath it is several machines that act as one: an App keeps answering when its server dies, and it can run on more than one server. Deplo gets that from a **cluster**: servers grouped together, which Apps and managed databases are placed on as if it were one server. The cluster decides which member runs each workload and moves it there (**failover**) when a member goes offline.

**Each cluster has a leader: a Go binary from its own repository.** It runs on one of the cluster's own servers, which Deplo picks (amended 23 Nov 2026, below; it first ran on Deplo's own machine). That lets failover keep working while Deplo is down. When a remote leader goes offline, a leader process on Deplo's machine leads the cluster until it returns. The leader picks members and orders moves. **It never builds compose files**: it re-sends to a new member the last stack the control plane built for that App, so AGENTS.md's rule that compose and routing logic never moves into Go still holds.

**The leader accepts no incoming connection,** like every server since ADR-0040. The way it reaches its members, which only connect outward too, is still open.

## Considered options

- **Kubernetes underneath, hidden from the user**: rejected. It needs every machine to reach every other one on a fast private network, while Deplo is built for servers that cannot reach each other. It would also replace the whole deploy layer, which is written for Docker Compose: rendering, routing labels, the network per Environment, the compose security checks and user-written stacks. It costs up to 2 GB of RAM for its control plane, and it still leaves traffic switching and data on a dead disk to solve.
- **Docker Swarm**: rejected for the same networking requirement, and because it accepts only part of the compose format.
- **The control plane as the only leader**: rejected. Failover would stop exactly when Deplo's own machine is down.
- **A leader elected among the members**: rejected. It needs members that can reach each other, and it puts the decision on machines that are themselves failing.

## Consequences

- To redeploy without Deplo, a leader needs an App's decrypted variables, which today only the control plane holds. What a leader may keep, and how it is protected, is decided separately.
- A remote leader and Deplo's machine can both be running, each cut off from the other. A leader therefore leads only while more than half of the cluster's servers answer it, or exactly half and Deplo does. Failover without Deplo needs more than half of the servers up: a two-server cluster that loses one while Deplo is down moves nothing, and its databases stop until Deplo is back (`docs/agents/cluster-rollout.md` §5).
- "Cluster" is the user-facing word. Nothing of Kubernetes is involved, and the Add dialog says so in one plain line.

## The leader lives inside the cluster, with a line of succession (23 Nov 2026)

On 23 Nov 2026 the provider of Deplo's machine lost connectivity for an hour; eu's leader ran there, so every member stopped its Apps with data until it was back. Decided by the owner:

1. **The leader lives on one of the cluster's own servers.** Deplo installs it on the member that reaches every other member directly and has the most free memory, once the members have reported a direct path (`leaderHome`, `placeClusterLeaders`, once a minute); a cluster led from Deplo's machine is moved there at the update that carries this. The picker offers the cluster's own servers only. Deplo's machine stays as the last stand-in. A leader an admin already put on a server outside the cluster stays where it is.
2. **A line of succession.** Every renewal names the line (`Order.Line`, heir first, then the next, `Order.Last` Deplo's machine): members Deplo named as heirs (`Roster.Heirs`: directly connected, an agent with Hello `cluster.succession`, at most two, in join order, and only while every member's agent pre-votes), less any the leader has not heard within 3 s. An heir it stops hearing leaves the next renewal and comes back at the end of the line. Each heir runs a leader of its own, standing by with the roster Deplo gives it (`leader.standby`) and the sealed bundles (ADR-0045).
3. **An heir takes over only with a quorum and a pre-vote.** Its agent asks the leader beside it to lead (`leader.succeed`) once its own lease went unrenewed for the removal time (`lease.PreVoteFor`, 10 s), 5 s more for each place down the line, never while the lease is extended for a planned restart. The leader then asks a pre-vote (`Order.PreVote`, which nobody takes), and probes with `Order.Succeed` only once a quorum said yes; a member refuses both while its own leader renewed it within the removal time, so a cut between leader and heir changes nothing, and an heir cut off alone takes nothing. A member gives each epoch to one leader only (`Order.From`). The quorum is the same rule as before. An heir honours extended leases as Deplo's machine does (§5), so the work of a dead leader's member moves after the plain fence when no extension was announced. Deplo adopts an heir that leads at its own epoch and replays its events from where that epoch began (`adoptHeir`, `ClusterView.since`); Deplo's machine, standing in, asks the same pre-vote.

**23 Nov 2026, later (ADR-0049, "A move goes leader first")**: a move between two members is handed to the leader before the deploy (`placeAtLeaderFirst`); handing a cluster back from Deplo's machine replays the stored leader's events from the last one Deplo applied (`clusters.resume_event_seq`) before the roster goes back; and while no member answers Deplo, Deplo writes no lease change a leader standing in reports. A second heir does not lead on its own when two of four servers are lost: exactly half, and Deplo's word goes only to the leader it stores, so Deplo's machine stands in.
