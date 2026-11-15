# ADR-0046: Replication streams member to member

**Status**: proposed. Builds on [ADR-0044](0044-cluster-members-meet-through-a-relay-over-tcp.md) and [ADR-0045](0045-a-cluster-leader-holds-sealed-failover-bundles.md).

An App that keeps a Volume or Files fails over only with its data on the server that takes it. **A cluster with replication on streams that data to every other member as it changes**: Deplo hands each member's server agent the cluster's replicated Apps (`SetClusterReplicas`); the agent that runs one watches its Volumes and Files (inotify) and sends every change, over the cluster relay, to the agents of the other members, which keep a copy of their own apart from any live data. A failover's bundle carries a restore marked `from_replica` and naming no member: the member the leader picks stops receiving, puts its copy in place of the App's data and starts it; one without a whole copy refuses, and the leader tries the next. It is the only way an App with stored data fails over: the per-App "fail over from the latest backup" opt-in is gone. A database gets its engine's own log replication instead: with replication on, every database of the cluster keeps a standby copy.

The agent walks every path by handle, never by name, so a symlink an App plants in its own volume is copied as a link and never followed out of it, though the agent runs as root. A member never receives for an App whose stack it still holds: a server that comes back after a failover keeps its old data as its own until the return saved and removed it, and only then follows the new one.

## Considered options

- **A backup every minute, written to every member**: built first and replaced. It paused the App at every copy and lost up to a minute of writes, for no gain over streaming once the agents can talk to each other.
- **The control plane relaying the stream**: rejected. Replication would stop while Deplo is down, which is when a cluster of three is meant to fail over on its own.
- **Sending a changed file whole**: built first and replaced. A few bytes written into a big file sent all of it again.
- **A replicated filesystem, or block-level replication**: rejected for now. It needs a kernel module or a daemon on every member, and a second writer would still be unsafe.

## Consequences

- Replication is asynchronous: what had not reached a copy when the App's server stopped is lost, usually under a second.
- It needs `cluster.replicas` on the members: a member whose agent lacks it keeps no copy and the cluster's page says why.
- Only what changed in a file travels. Both sides cut every file into content-defined chunks (FastCDC, about 64 KiB), the receiver says which it holds, and a changed file arrives as ranges to copy from what the copy already holds plus the chunks it lacks, wherever in the file the change is. The rebuilt file goes in place only when its size and SHA-256 are the sender's; one that is not makes the copy read itself again.
