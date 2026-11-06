# Databases and volumes across cluster members

Research for [#150](https://github.com/DeploCloud/deplo/issues/150) (map [#147](https://github.com/DeploCloud/deplo/issues/147)).
Repo citations are against `main` at `708a467f`; agent citations against `DeploCloud/deplo-agent` at `b124c95d`.

## Summary

1. Today every managed database is one container with one local volume, and its only copy elsewhere is a **logical dump** taken on a schedule the user must create; nothing creates one by default, the floor is every 15 minutes and the suggested default is daily.
2. **Restore-on-failover** works for all six engines with no new network path, but loses everything since the last dump, and a dump replays slowly (single stream, indexes rebuilt; ClickHouse is replayed as `INSERT` text).
3. **A live copy** with the engine's own replication cuts the loss to about a second (async) or zero (sync), but every engine's replica dials its primary (MongoDB and ClickHouse need all members to reach each other), none of Postgres/MySQL/MariaDB/Redis detects failure on its own, and all need fencing or quorum against split brain.
4. **Postgres is the exception that fits Deplo**: a standby can be fed WAL from an archive by `restore_command`, so WAL archiving to the existing backup destination gives point-in-time recovery and a warm standby with no member-to-member connection.
5. App Volumes are plain local Docker volumes backed up by a live `tar`; no replicated-storage option fits "members may not reach each other" without a kernel module and a mesh.

**Recommendation.**

- **Default (non-expert, on by default when a database is placed on a cluster):** Deplo turns on a backup schedule by itself (every 15 minutes, to a destination that is not on that member). Failover restores the latest backup on a healthy member. The database page states the window in plain words ("if its server dies, up to the last 15 minutes of changes can be lost; it is back in about N minutes"). For **Postgres**, add continuous WAL archiving to the same destination underneath, so the window drops to about a minute with nothing new to configure. MySQL/MariaDB binlog shipping is the same idea, as a second step.
- **Opt-in (expert, Advanced → "Keep a standby copy"):** a replica on a second member using the engine's own asynchronous replication, promoted by the **cluster leader** only after the old member has fenced itself. The leader relays replication traffic over the existing agent links when members cannot reach each other. Offer it for Postgres, MySQL, MariaDB and Redis. Offer MongoDB only when the cluster has three members. Do not offer it for ClickHouse.
- **Apps with Volumes:** by default no automatic failover. The App waits for its server, with one click to "bring it back on another server from the backup of 14:15". Automatic restore from the latest volume backup is an opt-in per App. Apps with a **Bind** never fail over.

## What Deplo runs today

### Engines and versions

| Engine     | Image                              | Versions offered (fallback list; live tags from Docker Hub merge in) |
| ---------- | ---------------------------------- | -------------------------------------------------------------------- |
| Postgres   | `postgres:<v>-alpine`              | 18, 17, 16, 15                                                       |
| MySQL      | `mysql:<v>`                        | 9.1, 8.4, 8.0                                                        |
| MariaDB    | `mariadb:<v>`                      | 11, 10                                                               |
| MongoDB    | `mongo:<v>`                        | 8, 7, 6                                                              |
| Redis      | `redis:<v>-alpine`                 | 8, 7                                                                 |
| ClickHouse | `clickhouse/clickhouse-server:<v>` | 25.8, 25.3, 24                                                       |

Images: `lib/deploy/database-compose.ts:12-19`. Versions: `app/api/database-versions/route.ts:15-22`, merged with up to 100 live tags at `:47-58`.

The rendered stack (`lib/deploy/database-compose.ts:166-192`) is one service, `restart: unless-stopped`, one named volume (`<name>-data`) on the default `local` driver, joined to the Environment's network (ADR-0028). Nothing enables replication or a log archive. Engine-specific facts that matter below:

- **Postgres**: only `POSTGRES_*` and `PGDATA` env (`:112-117`). WAL settings are the image defaults.
- **MySQL**: no flags, so binary logging is on by default in 8.4 (see sources [M3]). **MariaDB**: no flags, so the binary log is off ([Ma2]).
- **MongoDB**: no `--replSet`, so it is a **standalone** with no oplog (`:120-123`).
- **Redis**: `redis-server --requirepass …` with no config file (`:131-134`), so the built-in persistence defaults apply. Those are RDB snapshots after 3600 s/1 change, 300 s/100 changes, or 60 s/10000 changes, and `appendonly no` ([R3]). A hard crash can lose minutes even on the same disk.
- **ClickHouse**: `CLICKHOUSE_*` env only. Tables are whatever engine the user's SQL creates.

### How a database is backed up and restored

- A backup is a **schedule the user creates** (`lib/data/backups/schedules.ts:140`). Provisioning creates none (`lib/data/databases/provision.ts` has no backup call; the only creators are the GraphQL/MCP mutation, the UI wizard and the migration importer). Every team does get a destination by default (ADR-0019, "Every team starts with one").
- Schedules can run no more often than **every 15 minutes** (`lib/data/backups/schedules.ts:121-129`, `lib/schedule.ts:205-215`). The default expression is daily at 03:00 (`lib/schedule.ts:77`).
- The owning server's agent runs the engine's **logical** dump inside the container and streams it, gzipped and age-encrypted, to a bucket or to another server's disk (ADR-0007, ADR-0019; `lib/data/backup-transport.ts:55-90`). The dump commands (agent `internal/server/backup_database.go:44-69`):
  - Postgres `pg_dump -Fc`
  - MySQL/MariaDB `mysqldump`/`mariadb-dump --add-drop-table --databases <db>`, with no `--single-transaction` or `--source-data`
  - MongoDB `mongodump --archive`, with no `--oplog`
  - Redis `redis-cli --rdb -`
  - ClickHouse: a `SELECT *` per table written out as `INSERT` SQL (`backup_clickhouse.go:54-90`)
- Restore replays into the running container: `pg_restore --clean` from stdin, the `mysql`/`mariadb` client, `mongorestore --drop`, a Redis-specific path, and the ClickHouse client (`backup_database.go:71-95`, `backup_clickhouse.go:100-117`).
- A server-kind destination is written by **that destination's** agent (`lib/data/destinations/credentials.ts:79-84`). If the destination sits on the member that died, there is no backup to restore. A cluster has to refuse that pairing.

### How App Volumes work

- A **Volume** is a Docker named volume `deplo-<slug>-<name>` on the server's `local` driver. A **File** is a path in the App's files directory on the host. A **Bind** is any host folder, behind `canMountHostVolumes` (`CONTEXT.md`, "Volume"). Docker's local volumes live in a directory on that host; only a different volume driver stores them elsewhere ([D1]).
- An App backup is a `tar` of its volumes taken **while the App keeps writing**. The agent logs "a file likely changed during read" and carries on (`backup_project.go:90-113`). Restore stops the stack, wipes the volumes and unpacks (`:155-193`, `:270-310`).
- **Server move** already copies a database's or App's volume from one agent to another, relayed through the control plane with the stack stopped (`lib/data/databases/server-move.ts:123-133`, `lib/data/volume-migration.ts:244-300,470`). That is the one-off version of "put this data on another member", and a dead source cannot be read.

### The network constraint

Agents dial out and accept nothing (ADR-0040, `docs/adr/0040-…:7`). They are a star: "an agent can neither dial nor trust a peer" (`:26`; ADR-0019). The map settles that members which cannot reach each other must be supported (#147). Every engine's native replication assumes the opposite (below), so **a live copy needs either a relay through the leader or a shared intermediary such as the backup destination**. The leader learns a member is gone from its link going quiet (ADR-0040: offline after about 10 s, `:15`). From the leader's side a dead member and a partitioned one look the same, and that is the split-brain risk in every row below.

## Per-engine comparison

Terms: **loss window** = how much acknowledged data can be gone after failover; **back in** = time until the database answers on the new member.

### Postgres

**(1) Restore the latest backup**

- Loss window = time since the last successful dump started (`pg_dump` reads one snapshot). That is up to the schedule interval: 15 min at best, 24 h on the daily default.
- Back in = detection + download + `pg_restore` replay. Replay rebuilds every index. Deplo pipes the dump through stdin, and parallel restore (`--jobs`) "can dramatically reduce the time to restore a large database" but requires "a regular file or directory (not … a pipe or standard input)" ([P4]). Today's restore is therefore single-stream. Spooling the artifact to a file first would unlock `-j`.
- **Point-in-time recovery shrinks the window.** A logical dump cannot be used with WAL: "pg_dump … cannot be used as part of a continuous-archiving solution" ([P1] §25.3). PITR needs a physical base backup (`pg_basebackup`) plus archived WAL (`archive_mode`, `archive_command`/`archive_library`) ([P1] §25.3.1-25.3.2).
  - WAL is archived per completed 16 MB segment. `archive_timeout` forces a switch. The docs warn that early-switched files are full-size and that "settings of a minute or so are usually reasonable" ([P1] §25.3.1).
  - With `archive_timeout = 60` aimed at the existing destination, the loss window falls to about **1 minute**. Recovery replays WAL to the end of the archive, or to `recovery_target_time` ([P1] §25.3.5).
  - Cost: a periodic base backup (weekly, say) plus a stream of segments. Restore time = base restore (a file copy, faster than `pg_restore`) + WAL replay since the base.
  - Deplo-side work: the agent must collect segments from the container (an `archive_command` that writes into a spool the agent uploads) and drive a physical restore. Both are new agent verbs.

**(2) Live copy (streaming replication)**

- **Setup**: a standby seeded by `pg_basebackup`, with `primary_conninfo` pointing at the primary and a `replication` entry in `pg_hba.conf` ([P2] §26.2.4-26.2.5). The **standby dials the primary**.
- **Sync vs async**: asynchronous by default, with lag "typically under one second". On a crash "the amount of data loss is proportional to the replication delay" ([P2] §26.2.5, §26.2.8). Synchronous mode is `synchronous_standby_names` with `FIRST n`/`ANY n` ([P2] §26.2.8.1-2). A commit then waits for the standby, so with a single standby an outage of the standby stalls writes. Sync only makes sense with `ANY 1` over two or more standbys.
- **Promotion**: `pg_ctl promote` / `pg_promote()`. Postgres "does not provide the system software required to identify a failure", and a fencing mechanism (STONITH) is "necessary to avoid situations where both systems think they are the primary" ([P3]). The old primary comes back as a standby by rebuild or `pg_rewind` ([P3]).
- **Cost**: a second full copy of the data plus an idle server process on another member (RAM, CPU, disk). The standby can serve reads but not writes.
- **Network path**: standby → primary TCP. Members that cannot reach each other need the leader to relay the stream.
- **Without a path at all**: a standby can run on **file-based log shipping** alone, restoring WAL "from the archive location, calling `restore_command`" ([P2] §26.2.2, §26.2.4). With the archive in the backup destination this is a **warm standby with no member-to-member connection**. Its loss window equals `archive_timeout` (about 1 minute), and it is back in seconds after promotion. It is the best fit for Deplo's star topology of any option in this document.

### MySQL

**(1) Restore**

- Loss window = up to the interval.
- Deplo's dump has no `--single-transaction`. `--opt` (default) includes `--lock-tables` ([M4]), so writes to the database block while it dumps.
- Back in = replay of SQL text through one client connection.
- **PITR**: binary logging is on by default in 8.4, with 30-day expiry ([M3]). PITR is "the set of binary log files generated subsequent to the full backup", replayed with `mysqlbinlog | mysql` ([M1] §9.5.1). The dump must record its binlog coordinates. `--source-data` writes them as a `CHANGE REPLICATION SOURCE TO` statement and needs the binlog enabled ([M4]). Shipping closed binlog files to the destination on a short rotation gives a loss window of about that rotation.
- Deplo-side work: add `--single-transaction --source-data=2` to the dump (InnoDB), plus a binlog-shipping verb.

**(2) Live copy (source/replica)**

- **Setup**: a replica seeded from a dump with coordinates, which then **connects to the source**.
- **Sync vs async**: "asynchronous by default … if the source crashes, transactions that it has committed might not have been transmitted to any replica" ([M2]). Semisynchronous replication ships as plugins (`rpl_semi_sync_source`/`rpl_semi_sync_replica`) ([M5]). It waits for receipt in the replica's relay log, not for apply, and "if a timeout occurs … the source reverts to asynchronous replication" ([M2]). In practice, then, semisync is not "zero loss".
- **Promotion**: manual: `STOP REPLICA; RESET BINARY LOGS AND GTIDS` on the chosen replica, then repoint the others. MySQL documents no automatic failure detection here ([M6]).
- **Split brain**: same as Postgres, so the old source must be fenced.
- **Network path**: replica → source TCP.

### MariaDB

Same shape as MySQL, with three differences:

- The binary log is **off unless `--log-bin` is set** ([Ma2]). Today neither PITR nor replication is possible without changing the rendered command.
- Semisynchronous replication is built into the server ("nothing needs to be installed"). `rpl_semi_sync_master_timeout` defaults to 10000 ms, after which it switches to async ([Ma1]).
- The dump tool is `mariadb-dump` (agent `backup_database.go:31-41`), with the same missing `--single-transaction`.

### MongoDB

**(1) Restore**

- Loss window = up to the interval.
- The dump is **not point-in-time** on a standalone: "Without `--oplog`, if there are write operations during the dump operation, the dump will not reflect a single moment in time", and `--oplog` "only works against nodes that maintain an oplog", meaning replica set members ([Mo3]).
- **PITR**: impossible on a standalone. Running Deplo's MongoDB as a **single-member replica set** gives it an oplog, which makes `--oplog` dumps consistent and allows oplog shipping later. The conversion is `replication.replSetName` + `rs.initiate()`. With auth on, members need a **keyfile** or X.509 for internal authentication ([Mo2]). Deplo would generate that keyfile.

**(2) Live copy (replica set)**

- **Failover**: the only engine here with built-in automatic failover. A secondary calls an election after `electionTimeoutMillis` (10 s), and the median time to a new primary "should not typically exceed 12 seconds" ([Mo1]).
- **Cost and quorum**: elections need a majority. Two data members cannot survive the loss of one, so the third voter is either a third data member or an **arbiter** that "does not hold data" ([Mo1]). The leader's host or a third member could run the arbiter.
- **Loss**: writes not replicated to a majority roll back on the old primary ("new writes to the former primary will eventually roll back") ([Mo1]). `w: "majority"` avoids that, but it is the client's write concern, so Deplo cannot set it for the App.
- **Network path**: every member talks to every other member, so it needs a full mesh or a relay. Clients must use a replica-set connection string listing the members, which changes `buildConnectionString` (`lib/deploy/database-compose.ts:195-217`) and every linked App's variable.

### Redis

**(1) Restore**

- Loss window = up to the interval. On top of that, the live instance itself only snapshots on the default save rules ([R3]): RDB "you should be prepared to lose the latest minutes of data", while AOF with `appendfsync everysec` loses "1 second" ([R3]).
- Back in = loading one RDB file, which is fast.
- **PITR**: no log-based PITR. Redis 8.10 adds a `BACKUP START/SEAL` family that produces a BASE+INCR set restorable "at the seal boundary" ([R3], "Online backups"). It exists only from 8.10 on and is still interval-based.
- Many Redis databases are caches. For those, "start empty on another member" is a legitimate, instant failover, but only the user knows which kind theirs is.

**(2) Live copy (replica)**

- **Setup**: `replicaof <host> <port>` plus `masterauth` on the replica, which **dials the master** ([R1]).
- **Sync vs async**: always asynchronous. `WAIT` "does not turn a set of Redis instances into a CP system … acknowledged writes can still be lost during a failover" ([R1]). `min-replicas-to-write`/`min-replicas-max-lag` bound the window to a number of seconds ([R1]).
- **Promotion**: `REPLICAOF NO ONE`, which Deplo's leader would issue. Sentinel, Redis's own failover manager, needs "at least three Sentinel instances" on independently failing machines, and "does not guarantee that acknowledged writes are retained" ([R2]). Docker port mapping breaks Sentinel's discovery ([R2]). The leader doing the promotion is simpler than shipping Sentinel.
- **Trap**: a master restarting with persistence off comes back empty, and its replicas then "effectively destroy their copy of the data" ([R1]). With `restart: unless-stopped`, Deplo must keep persistence on wherever a replica exists.
- **Network path**: replica → master TCP.

### ClickHouse

**(1) Restore**

- Loss window = up to the interval.
- Back in is the **worst of the six**. Deplo dumps each table as `INSERT` statements and replays them through `clickhouse-client` (`backup_clickhouse.go:54-117`), which is slow for analytics-sized tables.
- ClickHouse's own `BACKUP … TO S3(…)`/`Disk(…)` writes native parts and supports incremental backups via `base_backup` ([C3]). Moving to it would cut both backup and restore time sharply.
- **PITR**: none documented; there is no log replay to a moment ([C3]).

**(2) Live copy**

- Replication covers only `Replicated*MergeTree` tables ([C1]). Users' own `MergeTree` tables must be converted (`convert_to_replicated` flag or `ATTACH TABLE … AS REPLICATED`) ([C1]), which means **Deplo rewriting the user's schema**.
- Needs ClickHouse Keeper, a Raft service. It can run inside the server, but surviving one failure takes a three-node Keeper ([C2]).
- Replication is asynchronous and multi-master, with `insert_quorum` for stronger inserts ([C1]). Replicas copy data from each other, so members need a mesh.
- **Not worth offering.**

### Side by side

| Engine     | Restore: loss window today           | With log archiving to the destination       | Live copy: loss (default)       | Auto-promote built in | Members must reach                       | Live copy offered?      |
| ---------- | ------------------------------------ | ------------------------------------------- | ------------------------------- | --------------------- | ---------------------------------------- | ----------------------- |
| Postgres   | interval (≥15 min)                   | ~`archive_timeout` (~1 min); warm standby   | ~1 s (async)                    | no (leader promotes)  | standby→primary; **none** if log-shipped | yes (recommended first) |
| MySQL      | interval; writes blocked by lock     | ~binlog rotation, needs coordinates in dump | ~1 s (async/semisync)           | no                    | replica→source                           | yes                     |
| MariaDB    | interval; writes blocked by lock     | needs `--log-bin` first                     | as MySQL                        | no                    | replica→source                           | yes                     |
| MongoDB    | interval; dump not a single moment   | needs a (1-member) replica set first        | rollback of non-majority writes | **yes** (≈12 s)       | all↔all                                  | only with 3 members     |
| Redis      | interval (+ minutes unsaved on disk) | none                                        | ~1 s (async)                    | no (Sentinel needs 3) | replica→master                           | yes                     |
| ClickHouse | interval; slowest replay             | none                                        | async, schema rewritten         | via Keeper (3 nodes)  | all↔all + Keeper quorum                  | no                      |

## Failover rules every option needs

1. **Fence before promoting.** Postgres says it outright ([P3]); Redis calls a Sentinel deployment "last failover wins" ([R2]) and DRBD describes the same split brain ([V2]). The leader cannot reach a dead member to stop it. The agent must fence itself: a server agent that has lost its link for longer than T stops the primaries it hosts, and the leader promotes or restores only after T plus a margin. The agent link's ~10 s offline window (ADR-0040) is the natural base for T.
2. **Keep the old copy.** When the dead member returns, its database becomes a stale copy. Keep it (renamed, stopped) rather than wiping it, so an expert can recover the lost window. Postgres's `pg_rewind` is the fast path back to a standby ([P3]).
3. **The backup destination must not be on the database's member.** This follows from `destinationServerId` (`lib/data/destinations/credentials.ts:79-84`).
4. **Connection strings must not change.** Linked Apps read `db-<slug>` on their Environment's network (ADR-0007, ADR-0028). A failover that moves the database must keep that name answering, which is the cluster networking ticket's problem.

## App Volumes

Options for an App whose Volume lives on the dead member:

| Option                                   | How it works                                                                                                                                                                         | Loss window                                                                     | What it requires                                                                                                                                                            | Fit                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Refuse automatic failover**            | The App waits for its server. The UI offers "bring it back on another member from the backup of HH:MM".                                                                              | none, unless the user clicks                                                    | nothing new                                                                                                                                                                 | **Default.** Honest: silently starting an App on hours-old files is the worst outcome, especially for an App that keeps SQLite on a Volume, which is a database Deplo cannot see. |
| **Periodic copy + restore**              | The existing App backup (volume `tar` + files dir) on a schedule; failover restores the latest.                                                                                      | up to the interval; the `tar` is not crash-consistent (`backup_project.go:113`) | an automatic schedule when the App joins a cluster                                                                                                                          | **Opt-in per App**, for Apps whose files are rebuildable or rarely written.                                                                                                       |
| **Replicated block storage** (e.g. DRBD) | A kernel module mirrors a block device between hosts. Protocol C loses nothing on a single-node failure ([V1]).                                                                      | 0 (sync)                                                                        | a kernel module on every member ([V1]); members reaching each other directly; quorum "requires at least three nodes", or a diskless tiebreaker ([V2]); split-brain handling | **No.** It breaks "members may not reach each other", makes the agent install kernel software, and puts block-device operations on users.                                         |
| **Shared network storage**               | A Docker volume driver storing on NFS or a bucket ([D1]).                                                                                                                            | 0                                                                               | storage outside every member, so a new single point of failure and something to stand up                                                                                    | **Expert only, later.** It asks the user for infrastructure they do not have, against the mission.                                                                                |
| **Files in object storage**              | The App keeps its files in a bucket. Twelve-factor: "processes are stateless and share-nothing. Any data that needs to persist must be stored in a stateful backing service" ([T1]). | 0                                                                               | App code change                                                                                                                                                             | **Guidance**, not a feature: the cloud model the audience already knows.                                                                                                          |

- **Bind** mounts (any host folder) never fail over: the content is outside Deplo.
- **File** entries are content Deplo wrote from the Storage editor (`CONTEXT.md`). They travel with the App backup (`includeFiles`) and could be rewritten on the new member.

## Recommendation, concretely

**For everyone** (default when a database is placed on a cluster):

1. Turn on a 15-minute backup schedule automatically, to the team's destination. Refuse a server destination on the same member.
2. On failover, after the old member has fenced itself, the leader restores the latest backup on a healthy member and keeps `db-<slug>` answering.
3. Tell the user the window and the timestamp restored, in plain words.
4. For Postgres, add WAL archiving (base backup + `archive_timeout = 60`) to the same destination. It needs no extra network and cuts the window to about a minute.
5. Fix the dump flags that hurt any restore: `--single-transaction` for MySQL/MariaDB, a 1-member replica set plus `--oplog` for MongoDB, native `BACKUP` for ClickHouse.

**For experts** (Advanced, "Keep a standby copy"):

- A replica on a second member with the engine's own async replication, promoted by the leader after fencing.
  - Postgres: streaming replication, or log-shipping from the destination when the members cannot reach each other.
  - MySQL/MariaDB: GTID replica, optionally semisync. MariaDB needs `--log-bin`.
  - Redis: `replicaof`, persistence forced on.
  - MongoDB: only with three members.
  - ClickHouse: not offered.
- Replication traffic is relayed by the leader over the agent links when there is no direct path.
- It costs a second copy's disk, RAM and CPU, and the UI says so.

**Apps with Volumes:** no automatic failover by default, one-click restore elsewhere, opt-in automatic restore per App. Binds never.

## Sources

**This repo** (`main` @ `708a467f`):

- `lib/deploy/database-compose.ts:12-37,112-134,166-192,195-217`
- `app/api/database-versions/route.ts:15-22,47-58`
- `lib/data/backups/schedules.ts:121-129,140`
- `lib/schedule.ts:77,205-215`
- `lib/data/backup-transport.ts:55-90`
- `lib/data/backup-objectkey.ts:6-33`
- `lib/data/destinations/credentials.ts:79-84`
- `lib/data/databases/provision.ts`
- `lib/data/databases/server-move.ts:123-133`
- `lib/data/databases/stack.ts:23`
- `lib/data/volume-migration.ts:244-300,470`
- `CONTEXT.md` ("Volume", "Live copy")
- ADR-0007, ADR-0019, ADR-0028, ADR-0040 (`docs/adr/`)

**deplo-agent** (`main` @ `b124c95d`):

- `internal/server/backup_database.go:31-95`
- `internal/server/backup_clickhouse.go:54-117`
- `internal/server/backup_project.go:90-113,155-193,270-310`

**Postgres** (current docs):

- [P1] Continuous Archiving and PITR, §25.3: https://www.postgresql.org/docs/current/continuous-archiving.html
- [P2] Log-Shipping Standby Servers, §26.2: https://www.postgresql.org/docs/current/warm-standby.html
- [P3] Failover, §26.3: https://www.postgresql.org/docs/current/warm-standby-failover.html
- [P4] pg_restore: https://www.postgresql.org/docs/current/app-pgrestore.html

**MySQL 8.4**:

- [M1] PITR using binary log, §9.5.1: https://dev.mysql.com/doc/refman/8.4/en/point-in-time-recovery-binlog.html
- [M2] Semisynchronous replication, §19.4.10: https://dev.mysql.com/doc/refman/8.4/en/replication-semisync.html
- [M3] Binary logging options (`log_bin`, `binlog_expire_logs_seconds`): https://dev.mysql.com/doc/refman/8.4/en/replication-options-binary-log.html
- [M4] mysqldump: https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html
- [M5] Installing semisynchronous replication: https://dev.mysql.com/doc/refman/8.4/en/replication-semisync-installation.html
- [M6] Switching sources during failover: https://dev.mysql.com/doc/refman/8.4/en/replication-solutions-switch.html

**MariaDB**:

- [Ma1] Semisynchronous replication: https://mariadb.com/kb/en/semisynchronous-replication/
- [Ma2] Activating the binary log: https://mariadb.com/kb/en/activating-the-binary-log/

**MongoDB**:

- [Mo1] Replication: https://www.mongodb.com/docs/manual/replication/
- [Mo2] Convert a standalone to a replica set: https://www.mongodb.com/docs/manual/tutorial/convert-standalone-to-replica-set/
- [Mo3] mongodump: https://www.mongodb.com/docs/database-tools/mongodump/

**Redis**:

- [R1] Replication: https://redis.io/docs/latest/operate/oss_and_stack/management/replication/
- [R2] Sentinel: https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/
- [R3] Persistence: https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/, plus the defaults in `redis.conf` (8.0 branch, lines 438-445, 1405, 1464): https://github.com/redis/redis/blob/8.0/redis.conf

**ClickHouse**:

- [C1] Data replication: https://clickhouse.com/docs/engines/table-engines/mergetree-family/replication
- [C2] ClickHouse Keeper: https://clickhouse.com/docs/guides/sre/keeper/clickhouse-keeper
- [C3] Backup and restore: https://clickhouse.com/docs/operations/backup

**Storage**:

- [D1] Docker volumes: https://docs.docker.com/engine/storage/volumes/
- [V1] DRBD 9 user guide (protocols A/B/C, kernel module): https://linbit.com/drbd-user-guide/drbd-guide-9_0-en/
- [V2] DRBD 9 user guide (split brain, quorum): same URL
- [T1] The Twelve-Factor App, "Processes": https://12factor.net/processes
