# ADR-0043: A cluster is led by its own leader, not by Kubernetes

**Status**: proposed. Builds on [ADR-0006](0006-server-agent-is-a-per-host-go-binary.md) and [ADR-0040](0040-a-server-agent-links-to-its-control-plane.md).

Kubernetes is the usual answer to running Apps across several machines. The need underneath it is several machines that act as one: an App keeps answering when its server dies, and it can run on more than one server. Deplo gets that from a **cluster**: servers grouped together, which Apps and managed databases are placed on as if it were one server. The cluster decides which member runs each workload and moves it there (**failover**) when a member goes offline.

**Each cluster has a leader: a Go binary from its own repository.** By default it runs on Deplo's own machine. An admin can install it on another server with one command, the way a server agent is installed. That lets failover keep working while Deplo is down. When a remote leader goes offline, a leader process on Deplo's machine leads the cluster until it returns. The leader picks members and orders moves. **It never builds compose files**: it re-sends to a new member the last stack the control plane built for that App, so AGENTS.md's rule that compose and routing logic never moves into Go still holds.

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
