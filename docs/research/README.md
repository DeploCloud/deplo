# Research archive

> **Historical. These documents do not describe the running system.**

Four planning documents kept for the reasoning they contain. Each was written
**before** the thing it plans existed, in the present tense about a world that
has since changed, so reading one as documentation will mislead you.

For how Deplo behaves today, read the [user documentation](../README.md). For
the decisions that came out of these plans, read the
[architecture decisions](../adr/README.md).

| Document                                                       | What it planned                                              | Status                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`server-agent/PLAN.md`](server-agent/PLAN.md)                 | Moving execution off the control plane onto a per-host agent | **Fully shipped.** Its context describes the world before that agent existed: "there is no agent, no remote exec path". That is now the architecture, recorded in [ADR-0006](../adr/0006-server-agent-is-a-per-host-go-binary.md) |
| [`dbs-backups/PLAN.md`](dbs-backups/PLAN.md)                   | Real backups and restore, replacing a stub                   | **Shipped, and since extended.** Written before destinations could be a server's disk, which [ADR-0019](../adr/0019-a-backup-destination-is-a-bucket-or-a-server.md) added                                                        |
| [`relational-store/PLAN.md`](relational-store/PLAN.md)         | Migrating a single JSON blob into relational tables          | **Completed.** Postgres with about 55 tables is now the only control-plane store. The document still says it is "not yet approved for build"                                                                                      |
| [`plugin-sections/DECISIONS.md`](plugin-sections/DECISIONS.md) | The Plugins feature                                          | **On hold** per [ADR-0013](../adr/0013-plugins-are-deferred-and-the-mcp-plugin-is-withdrawn.md). Kept as the design record a revival would start from, and honest about its own changed premises                                  |

Nothing here should be treated as a specification of current behaviour, and
nothing new should be added to this folder.
