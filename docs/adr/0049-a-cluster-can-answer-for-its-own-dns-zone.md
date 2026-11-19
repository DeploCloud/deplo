# ADR-0049: A cluster can answer for its own DNS zone

**Status**: proposed, not built: this is the plan to approve before phase 1. Follows from [ADR-0048](0048-a-cluster-domain-answers-on-every-server.md), whose third DNS backend (`native`) it is.

A domain that answers on every server (ADR-0048) needs one DNS record per healthy server. With a connected provider Deplo keeps them; without one, a person types them and edits them again on every change of the cluster, which is exactly the DNS work the mission keeps off the happy path. **The servers of a cluster answer for a DNS zone themselves: the person delegates a zone (or one name under it) to the cluster once, and from then on the cluster's own answers name its healthy servers, with no record to edit, Deplo up or down.**

## Decision

### Where the name server runs: inside every server agent

- **Every server agent of the cluster answers, not the leader.** The leader is one process on one server (or Deplo's machine); a name server there is a single point of failure the moment it matters, a server stopping. The agent already runs on every server, already keeps the cluster's private network on disk and running without Deplo (ADR-0047), and is the only thing allowed to touch the host (ADR-0006). One binary, no new process, no new container.
- **Port 53, UDP and TCP, on the server's public addresses only**, never on `0.0.0.0`: `127.0.0.53` belongs to the host's own resolver on most distributions, and binding the wildcard would collide with it. A server whose port 53 is taken (another DNS server, a host that blocks it) says so in Hello (`dns.zone` with a reason), and Deplo lists it as a name server nowhere: the zone works from the others, and the server screen says why.
- **Authoritative only**: no recursion, no answers outside the delegated zones, no zone transfers, response rate limiting per client network (so the servers are no amplifier). Library: `github.com/miekg/dns` (BSD-3-Clause), the one every Go DNS server uses.

### What it answers, and how it knows who is healthy

- **Deplo hands each agent the zone** (`SetClusterZone`, gated on Hello `dns.zone`): the zones and names delegated, which App's domains live in them, every server's public addresses, the TTLs, and which servers are being emptied. The agent keeps it on disk like the network table, so it answers after a restart with Deplo down.
- **Health is the agent's own view, not Deplo's**: a server is in the answer when this agent heard it over the private network in the last 10 s (the mesh's keepalive is 5 s, so two missed), or it is this server, and Deplo has not marked it as being emptied. Each name server answers from what it sees, so the answers outlive Deplo and the leader; the leader's lease state is not needed and not read.
- **Each answer is every healthy server's A and AAAA** for a name of a domain that answers on every server; the NS and SOA of the zone; nothing else in phase 1 (no MX, no TXT the person writes: a zone that needs those is delegated one level down, see below). Answers are shuffled per query.

### When a server cannot see enough of its cluster

- **A name server that hears fewer than half of the cluster's servers answers `SERVFAIL`**, so resolvers ask another name server, which in a split is one on the bigger side. It never answers "only myself": a server cut off from the server that runs the App cannot pass a visitor on (ADR-0048), so naming itself would send visitors into a 30 s wait.
- **When no side holds more than half** (an even split, or more than half of the servers gone at once), every server answers **the last set it answered with while it did**, stale rather than empty. Two halves each answering the last agreed set point visitors at servers some of which still carry the App, which is the best a split allows; an empty answer would take every domain down.
- This mirrors the leader's quorum rule (`cluster-rollout.md` §5) without depending on it: DNS never needs a leader to answer.

### The delegation, the only thing typed at the registrar

- **Two shapes, both one step**: delegate a whole zone the person owns only for the cluster (`example-apps.com`), or a subdomain of their main one (`go.example.com`) and point each name at it with a `CNAME` (`shop.example.com CNAME shop.go.example.com`). A subdomain cannot carry the bare apex of the parent; the screen says so and offers the whole-zone shape for it.
- **Name servers are named inside the zone**, `ns1` to `ns4.<zone>`, so the registrar needs **glue**: an `NS` record and an `A` (and `AAAA`) per name server. Deplo picks at most **four** servers, the ones online longest and in different regions when it knows them, and keeps the choice stable: it changes the list only when a chosen server leaves the cluster, and the domain then says which records to change at the registrar. Four because registrars commonly cap the list there and more adds nothing a resolver uses.
- **The domain screen shows the exact records with copy buttons and checks them itself**: it asks the parent zone's name servers for the delegation and the glue, and says "delegated" or what is missing. It never says "NS" or "glue" before the person opens the details; the first line is "Add these records where you bought the domain."

### Geography (phase 2)

- **Each server gets a region**: a city or coordinates an instance admin sets, prefilled by looking up the server's own address once. Visitors are placed by **EDNS Client Subnet** when the resolver sends it, else by the resolver's own address.
- **The address database is DB-IP "IP to City Lite"** (CC BY 4.0: free, redistributable, attribution required), downloaded monthly by Deplo and handed to the agents with the zone, never fetched by each server from the internet. Rejected: MaxMind GeoLite2 (free, but its licence needs an account and a key per install and forbids redistributing the file, so a host offering Deplo could not ship it). Without a database (an offline install) geography is off and answers stay as in phase 1.
- **Nearest first, never alone**: the answer lists the healthy servers nearest the visitor, at least two when two are healthy, so a server that stops between answers still leaves the browser one to try.

### Times

| What                               | Default | Range         | Why                                                              |
| ---------------------------------- | ------- | ------------- | ---------------------------------------------------------------- |
| A / AAAA of an App's name          | 30 s    | 10 s to 300 s | How long a resolver keeps naming a server that stopped.          |
| A stopped server leaves the answer | 10 s    | 5 s to 60 s   | Two missed keepalives on the private network.                    |
| Negative answers (SOA minimum)     | 30 s    | fixed         | A name added a moment ago appears quickly.                       |
| NS and glue                        | 1 day   | fixed         | The registrar's side; it changes only when a name server leaves. |

So a server that stops leaves the answers within 10 s, and leaves every resolver within 40 s; meanwhile a browser that tries it falls back to the next address after a few seconds (ADR-0048, "Deplo down is a degradation"). Both values are per cluster, in the cluster's settings, behind Advanced.

### DNSSEC: out of scope

The zone is served unsigned, and the delegation must carry no `DS` record (the screen checks it). Signing on every server needs the zone's signing key on every server, or a scheme to hand signatures around that no one server can forge; that is its own decision, with a key-at-rest story like ADR-0045's. Nothing here closes the door: signing can be added to the same answers later.

## Phases

1. **Health-aware answers, no geography.** The agent's name server and `SetClusterZone`; the `native` backend in the domain screen with the delegation check; quorum and stale answers; the two times in the cluster's settings. Ships hidden behind the backend choice until its lab check passes.
2. **Geography.** Server regions, the DB-IP database handed with the zone, ECS, nearest-first answers.
3. **Certificate checks over DNS (DNS-01).** `_acme-challenge.<name>` points into the zone (a `CNAME` once, or nothing for a delegated whole zone), and each agent serves on its own loopback the endpoint Traefik's HTTP-request DNS provider calls to set a TXT record; the agent hands it to every other name server over the private network within a second. No DNS provider's token reaches any server. It reopens what ADR-0048 rejected: wildcard certificates, and a certificate on every server that runs a replica (#228, load balancing without Cloudflare), still ordered once and carried as ADR-0048 carries it, so the duplicate limit is not spent per server.

## Test plan

**CI only, for every change** (each repo's own job, plus the cross-repo contract job ADR-0048 set up):

- `deplo-agent`: the name server in process on a loopback port, queried with the same library: answers for each record type, NXDOMAIN and REFUSED outside the zone, no recursion, TCP fallback for a long answer, response rate limiting. Health from a fake private network: a peer silent for 10 s leaves the answer, one heard again comes back, an emptied server never appears. Quorum: fewer than half gives SERVFAIL, an even split gives the last agreed set, never "only myself". The zone survives a restart from disk. Port 53 taken is reported in Hello, not a crash. Phase 2: nearest-first with a fixed small database and ECS present and absent, at least two in an answer. Phase 3: the challenge endpoint sets and clears a TXT, which another agent of a fake mesh serves within a second, and refuses a name outside the zone.
- `deplo`: the zone table Deplo renders (golden file shared with the agent, as `answer-routes.golden.json` is); name server choice is stable and changes only when one leaves; the delegation check against a fake parent zone (delegated, missing glue, a stray DS, a subdomain asked to carry an apex); refusals in the person's words; the times' ranges; the backend switching from `manual` and back. Phase 2: the DB-IP download is verified and handed only to agents with the capability.

**One small lab check per phase**, on LXC 103-106, with a lab resolver (unbound in a lab container) given the delegation as a stub zone, since the lab owns no public domain:

1. Phase 1: resolve a name through the lab resolver, power off the server running the App, and measure when it leaves the answer (want 10 s) and when the resolver stops naming it (want ≤ 40 s); then isolate one server and see it answer SERVFAIL.
2. Phase 2: two lab servers given distant regions, queries with ECS for each region: nearest first, both listed.
3. Phase 3: Pebble validating DNS-01 for a wildcard name through the lab resolver, with no token on any server; the certificate then travels with its App as in ADR-0048.

## Considered options

- **Records at a connected provider (ADR-0048)**: kept. It is the backend for whoever already has one.
- **Hand-written records (ADR-0048)**: kept as the backend that needs nothing, with its limits stated.
- **The name server in the leader**: rejected. One process on one machine answers for the zone exactly when that machine may be the one that stopped.
- **A separate DNS daemon (CoreDNS, PowerDNS) beside the agent**: rejected. A second process per server to install, update and supervise, and a config format to render, for what is one table and a few hundred lines in the agent.
- **Health from the leader's leases**: rejected. Answers would stop changing whenever the leader is away, and two leaders in a split would disagree; the private network's own keepalive is on every server already.
- **A DNS service Deplo runs for every instance**: rejected. It would make every install depend on a service outside it, which the installable product must not.
- **MaxMind GeoLite2**: rejected for its licence, above.

## Consequences

- **Port 53 opens on the servers that answer for a zone.** It is authoritative only and rate-limited, but it is a new public port; a host that blocks it simply is not a name server.
- **The person types records once**, at the registrar, and the screen checks them; a name server leaving the cluster asks for that once more.
- **Answers can differ between name servers for a few seconds** (each sees the private network from where it stands); every answer is a set of servers that answer for the App, so a visitor reaches it either way.
- **No DNSSEC** until a later decision.

## See also

- [User documentation](https://deplo.build/docs) - the manual, in `DeploCloud/docs`
- [`AGENTS.md`](../../AGENTS.md) - the architecture rules these decisions produced
- [`CONTEXT.md`](../../CONTEXT.md) - the glossary
