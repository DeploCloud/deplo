# ADR-0049: A cluster can answer for its own DNS zone

**Status**: proposed, not built. Follows from [ADR-0048](0048-a-cluster-domain-answers-on-every-server.md).

A domain that answers on every server (ADR-0048) needs one DNS record per healthy server. With a connected provider Deplo keeps them; without one, a person types them and edits them again on every change of the cluster, which is exactly the kind of DNS work the mission keeps off the happy path. **The servers of a cluster can answer for a DNS zone themselves: the person delegates a zone (or one name) to the cluster once, and from then on the cluster's own answers name its healthy servers, with no record to edit.** It is ADR-0048's third DNS backend, `native`.

- **One delegation, then nothing.** The person adds `NS` records for the zone, or one `CNAME` per name into it, pointing at names that resolve to the cluster's servers. After that nothing in DNS is edited by hand: a server that joins, leaves or stops changes the answers, not the records.
- **Every server answers, so it outlives any one of them.** Each server answers for the zone on port 53 from what Deplo last handed it, the way it keeps the private network (ADR-0047): it goes on answering while Deplo or the leader is down, and a stopped server only drops out of the answers the others give.
- **It also answers certificate checks without a token anywhere.** A `_acme-challenge` name can point into the zone, as `acme-dns` does, so a DNS-01 check is answered by the cluster itself: no DNS provider's token ever reaches a server. That is what reopens the DNS-01 option ADR-0048 rejected.

## Open before it is built

- Where it runs: inside the server agent (one binary, no new process) or beside it.
- Port 53 on every server: open to the internet, which some hosts block or already use.
- How long answers live (TTL) against how fast a stopped server drops out.
- What the domain screen says, so delegating a zone reads as one step and not as DNS administration.

## Considered options

- **Records at a connected provider (ADR-0048)**: kept. It is the backend for whoever already has one.
- **Hand-written records (ADR-0048)**: kept as the backend that needs nothing, with its limits stated.
- **A DNS service Deplo runs for every instance**: rejected. It would make every install depend on a service outside it, which the installable product must not.

## See also

- [User documentation](https://deplo.build/docs) - the manual, in `DeploCloud/docs`
- [`AGENTS.md`](../../AGENTS.md) - the architecture rules these decisions produced
- [`CONTEXT.md`](../../CONTEXT.md) - the glossary
