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

## Every volume is data (23 Nov 2026)

On cluster eu, fise's Postgres kept its data where no rule looked: its compose binds `./data/db` at `/var/lib/postgresql`, while `postgres:17` declares `/var/lib/postgresql/data` as a volume, so Docker gave it an unnamed volume that every new container replaced. fise was neither replicated nor fenced, and each move started an empty database. Decided by the owner:

1. **A place Docker would leave unnamed becomes a Volume at deploy**: a path the image declares (read from its registry, `Config.Volumes`) that the service does not mount itself, and a compose volume with no name (`- /data`, or `type: volume` with no source). Each becomes a Volume row of the App (`app_volumes.origin` = `image` or `compose`), so it is replicated, fenced, survives a new container, moves with the App and is listed under Storage ("Declared by the image"). A Volume replaces the compose entry that named nothing at its path.
2. **An existing App keeps what its unnamed volume holds**: on the first deploy that names it, the agent copies the newest container's unnamed volume at that path into the new one before `compose up`, once, and leaves the old volume as it was (`DeployRequest.adopt_volumes`, Hello `volumes.adopt`). A failed copy removes only the new volume, starts the container again and fails the deploy. A server whose agent cannot copy gets nothing named.
3. **Out of scope**: an image Deplo builds itself (its `VOLUME` is not read until the image is published) and a private image whose registry Deplo cannot read anonymously; both keep the old behaviour.

## Writes not copied at a cut are set aside, never deleted (23 Nov 2026)

A member that comes back after its work moved used to archive what it still held to the workload's destination and then remove the volume, or, with no destination, remove the stack and leave the volume under its live name, where a later start on that member would read it again. Its volume can hold writes its copy had not sent before the cut. Decided by the owner: **the returning member first copies each volume of a moved stack to a dated copy on itself** (`<volume>-aside-<UTC time>`, labelled `deplo.aside.of`/`deplo.aside.at`), then removes the volume as before (`setAside`, agent Hello `volumes.set-aside`). The leader passes the copies on in `member_returned` (`aside`), Activity says when one is made, and the App's Storage page lists each with its date, server and size until someone with `delete_backups` removes it (`RemoveSetAside`). A database's copies are made the same way and not listed yet.
