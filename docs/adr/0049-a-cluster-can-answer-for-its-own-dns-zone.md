# ADR-0049: A cluster can answer for its own DNS zone

**Status**: accepted with the owner's four amendments (20 Nov 2026: the name server runs unprivileged, how a visitor is placed without ECS, how the location database is updated, the apex in the manual). **Phase 1 built and checked on the lab**: agent DeploCloud/deplo-agent#66 (Hello `dns.zone`, released in v0.5.3-canary.17), panel #267 (migration 0268, released in v0.8.2-canary.47), manual DeploCloud/docs#12. Phases 2 and 3 not built. Follows from [ADR-0048](0048-a-cluster-domain-answers-on-every-server.md), whose third DNS backend (`native`) it is.

A domain that answers on every server (ADR-0048) needs one DNS record per healthy server. With a connected provider Deplo keeps them; without one, a person types them and edits them again on every change of the cluster, which is exactly the DNS work the mission keeps off the happy path. **The servers of a cluster answer for a DNS zone themselves: the person delegates a zone (or points one name into it) once, and from then on the cluster's own answers name its healthy servers, with no record to edit, Deplo up or down.**

## Decision

### Where the name server runs: beside every server agent, with none of its privileges

- **Every server of the cluster answers, not the leader.** The leader is one process on one server (or Deplo's machine); a name server there is a single point of failure the moment it matters, a server stopping. The server agent already runs on every server, keeps the cluster's private network on disk and running without Deplo (ADR-0047), and is the only thing allowed to touch the host (ADR-0006), so it is what starts and supervises the name server.
- **The name server is a separate process with nothing of the agent's** (amendment 1). The agent runs as root, holds the Docker socket and its mTLS key, and the name server parses packets from anyone on the internet, so a bug in that parser must reach none of them. The agent binds port 53 itself and starts `deplo-agent dns` (the same binary, like the screenshot browser and the name forwarders) as `nobody` (uid and gid 65534, no supplementary groups, so no `docker` group), chrooted into an empty directory, in a network namespace of its own: it cannot open a single connection, only answer on the sockets it was handed. It never sees the Docker socket, the agent's directory or its keys, and holds no capability. What it receives, over a pipe on its standard input, is the **answer table** and nothing else: the zones and the names in them, the name servers' addresses, and for each cluster the servers to answer with, or "answer with an error". The agent decides health and the majority; the process only answers. If it exits, the agent starts it again on the same sockets, so queries wait in the socket's queue rather than meet a closed port.
- **Port 53, UDP and TCP, on the server's own addresses, never the wildcard**: every address of its network interfaces but loopback, link-local and Docker's, private ones included, since a server behind NAT receives its public address's traffic on its private one. `127.0.0.53` belongs to the host's own resolver on most distributions and `10.201.0.1` to Deplo's DNS cache, and binding the wildcard would collide with both. A server whose port 53 is taken (another DNS server) says so in `SetClusterZone`'s reply, address by address, and Deplo names it as a name server nowhere: the zone works from the others, and the cluster's DNS settings say why.
- **Authoritative only, and small**: no recursion, `REFUSED` outside the delegated zones, no zone transfers, no `ANY` (answered with the one `HINFO` of RFC 8482). Response rate limiting per client network (a /24 for IPv4, a /56 for IPv6; past the limit every second answer is a truncated one, so a real resolver retries over TCP, and the rest are dropped), a cap on TCP connections and on how long each may sit idle. A UDP answer never exceeds what the resolver offers, nor 1,232 bytes: past that it is sent truncated and the resolver asks again over TCP. So the servers are no amplifier. Library: `github.com/miekg/dns` (BSD-3-Clause), the one every Go DNS server uses.

### What it answers, and how it knows who is healthy

- **Deplo hands each agent the zone** (`SetClusterZone`, gated on Hello `dns.zone`): the zones and names delegated, every member's certificate and public addresses, which members are being emptied, the name servers, and the two times. The agent keeps it on disk like the network table, so it answers after a restart with Deplo down.
- **Health is the agent's own view, not Deplo's** (ADR-0048's lab: a stopped server left in the answers also fails certificate checks that land on it): a server is in the answer when this agent heard it over the private network within the removal time (10 s by default; every agent says it is alive every 2 s, so that is five missed), or it is this server, and Deplo has not marked it as being emptied. Each name server answers from what it sees, so the answers outlive Deplo and the leader; the leader's lease state is not needed and not read.
- **Each answer is every healthy server's A and AAAA** for a name of a domain that answers on every server; the NS and SOA of the zone, and the name servers' own addresses; nothing else in phase 1 (no MX, no TXT the person writes: a zone that needs those is delegated one level down, see below). Answers are shuffled per query.

### When a server cannot see enough of its cluster

A name server counts the members of its cluster it hears, itself included, against all of them, servers being emptied included (they are members; they only leave the answer):

- **More than half: it answers** with the healthy servers, and keeps that set on disk as the **last agreed set**.
- **Fewer than half: it answers `SERVFAIL`** for every name of the zone, so resolvers ask another name server, which in a split is one on the bigger side. It never answers "only myself": a server cut off from the server that runs the App cannot pass a visitor on (ADR-0048), so naming itself would send visitors into a 30 s wait. A server cannot tell being cut off from the others having stopped, so this holds when more than half of the servers stop at once too: the zone then waits for them, or for an admin to remove the stopped ones from the cluster, which gives the smaller cluster a majority again.
- **Exactly half, where no side can hold a majority** (an even split of an even cluster, or half of it stopped at once): every server answers **the last agreed set**, stale rather than empty. Two halves each answering it point visitors at servers some of which still carry the App, which is the best a split allows; an empty answer would take every domain down.
- **Just started**: until the agent has listened for one removal time, a server it has not heard yet may simply not have spoken, so it answers the last agreed set (or `SERVFAIL` when it has none) rather than count it as stopped.
- This mirrors the leader's quorum rule (`cluster-rollout.md` §5) without depending on it: DNS never needs a leader to answer.

### The delegation, the only thing typed at the registrar

- **Two shapes, both one step**: delegate a whole zone the person owns only for the cluster (`example-apps.com`), or a subdomain of their main one (`go.example.com`). A name inside the zone needs nothing more. A name outside it gets one `CNAME` into it, named after the domain so no two domains share one: `shop.example.com CNAME shop-example-com.go.example.com`.
- **A `CNAME` cannot carry the bare apex of a domain** (amendment 4): DNS forbids a `CNAME` beside the apex's own `NS` and `SOA`. The screen says so for an apex, and the manual gives the two ways out: make that domain the zone delegated to the cluster, or use an `ALIAS`/`ANAME` record at a DNS provider that offers one, pointed at the same name.
- **Name servers are named inside the zone**, `ns1` to `ns4.<zone>`, so the registrar needs **glue**: an `NS` record and an `A` (and `AAAA`) per name server. Deplo picks at most **four** servers of the cluster, those that answer on port 53 and joined longest ago (in different regions when phase 2 knows them), and keeps the choice stable: it changes the list only when a chosen server leaves the cluster or stops being able to answer, and the zone then says which records to change at the registrar. Four because registrars commonly cap the list there and more adds nothing a resolver uses.
- **The screen shows the exact records with copy buttons and checks them itself**: it asks the parent zone's name servers for the delegation and the glue, and each name server of the cluster for the zone, and says "delegated" or what is missing. It never says "NS" or "glue" before the person opens the details; the first line is "Add these records where you bought the domain."
- **A zone belongs to the cluster, so an instance admin delegates it**, in the cluster's settings, as for everything else about a cluster. Any team with Apps on the cluster then points its domains at it from the domain screen with `manage_domains`, and the zone answers only the names of those domains.

### Geography (phase 2)

- **Each server gets a region**: a city or coordinates an instance admin sets, prefilled by looking up the server's own address once.
- **A visitor is placed by EDNS Client Subnet when the resolver sends it, else by the resolver's own address** (amendment 2): a resolver that hides its client is usually near it. **When neither has a location** in the database, the answer is every healthy server, as in phase 1, never a guess.
- **The address database is DB-IP "IP to City Lite"** (CC BY 4.0: free, redistributable, attribution required). Rejected: MaxMind GeoLite2 (free, but its licence needs an account and a key per install and forbids redistributing the file, so a host offering Deplo could not ship it).
- **It ships with each release and is updated by updating Deplo** (amendment 3). The release workflow downloads that month's file, checks it, and reduces it to what an answer needs (networks and a rounded position, a few MB instead of the full file); the image carries it, and Deplo hands it to the agents with the zone. No instance and no server ever fetches it from the internet, so an offline install has it too. The cluster's DNS settings show its date and "IP geolocation by DB-IP" with a link to db-ip.com, as the licence asks; a database more than three months old says so there.
- **Nearest first, never alone**: the answer lists the healthy servers nearest the visitor, at least two when two are healthy, so a server that stops between answers still leaves the browser one to try.

### Times

| What                               | Default | Range         | Why                                                              |
| ---------------------------------- | ------- | ------------- | ---------------------------------------------------------------- |
| A / AAAA of an App's name          | 30 s    | 10 s to 300 s | How long a resolver keeps naming a server that stopped.          |
| A stopped server leaves the answer | 10 s    | 5 s to 60 s   | Five missed "alive" messages on the private network.             |
| Negative answers (SOA minimum)     | 30 s    | fixed         | A name added a moment ago appears quickly.                       |
| NS and glue                        | 1 day   | fixed         | The registrar's side; it changes only when a name server leaves. |

So a server that stops leaves the answers within 10 s, and leaves every resolver within 40 s; meanwhile a browser that tries it falls back to the next address after a few seconds (ADR-0048, "Deplo down is a degradation"). Both values are per cluster, in the cluster's settings, behind Advanced.

### DNSSEC: out of scope

The zone is served unsigned, and the delegation must carry no `DS` record (the screen checks it). Signing on every server needs the zone's signing key on every server, or a scheme to hand signatures around that no one server can forge; that is its own decision, with a key-at-rest story like ADR-0045's. Nothing here closes the door: signing can be added to the same answers later.

## Phases

1. **Health-aware answers, no geography.** The unprivileged name server and `SetClusterZone`; the `native` backend in the domain screen with the delegation check; the majority and the last agreed set; the two times in the cluster's settings. The agent ships first behind `dns.zone`, then the panel.
2. **Geography.** Server regions, the DB-IP table shipped in the image and handed with the zone, ECS or the resolver's address, nearest-first answers.
3. **Certificate checks over DNS (DNS-01).** `_acme-challenge.<name>` points into the zone (a `CNAME` once, or nothing for a delegated whole zone), and each agent serves on its own loopback the endpoint Traefik's HTTP-request DNS provider calls to set a TXT record; the agent hands it to every other name server over the private network within a second. No DNS provider's token reaches any server. It reopens what ADR-0048 rejected: wildcard certificates, and a certificate on every server that runs a replica (#228, load balancing without Cloudflare), still ordered once and carried as ADR-0048 carries it, so the duplicate limit is not spent per server.

## What the lab showed (phase 1)

Released agent v0.5.3-canary.17, panel v0.8.2-canary.47, leader v0.1.0-canary.7; three servers, `lab.test` delegated to them through a lab resolver (unbound with a stub zone, since the lab owns no public domain), default times (removal 10 s, TTL 30 s). A prober on the LAN asked each name server and the resolver every 0.5 s.

- **Normal answers**: 160 of 160 named exactly the three servers, from each name server and through the resolver; A, AAAA and NS as specified.
- **A server powered off** (three runs): it left each other name server's answers 9.4 to 11.0 s after the cut (the removal time, plus up to one 2 s "alive" interval), and the resolver's after 21.2 to 21.7 s, when its cached answer expired; never an error or an empty answer from a healthy server.
- **A server isolated from the others** (three runs): it answered `SERVFAIL` 11.5 to 12.0 s after the cut, the other two dropped it after 10.0 to 12.0 s and the resolver after 20.7 to 21.2 s, and none of them ever answered an error. Back on the network, it was answering and named by every server again within 2 to 4 s.
- **The process on a lab server**: `nobody`, no supplementary group, no capability, `NoNewPrivs`, its root a directory holding only its binary, its own network namespace; on the server's own IPv4 and IPv6, beside Deplo's DNS cache on `10.201.0.1:53`.
- **An ADR-0048 failover** (power cut of the Apps' server), the non-regression check: the Volume App took writes on its new server about 41 s after the cut, the database never stopped, and no two copies took writes at once.
- **Seen, not a fault**: an agent's first seconds log "answers fail, hearing 3 of 3": just started with nothing agreed yet, it answers `SERVFAIL` for one removal time, as decided above.

## Test plan

**CI only, for every change** (each repo's own job, plus the cross-repo contract job ADR-0048 set up):

- `deplo-agent`: the name server in process on a loopback port, queried with the same library: answers for each record type, NXDOMAIN and REFUSED outside the zone, no recursion, no `ANY`, truncation and the TCP fallback for a long answer, response rate limiting, and a fuzzed parser path (malformed packets never crash it or draw a large answer). Health from a fake private network: a peer silent for the removal time leaves the answer, one heard again comes back, an emptied server never appears. The majority: fewer than half gives SERVFAIL, exactly half the last agreed set, a partition on both sides at once, never "only myself". The zone survives a restart from disk. A taken port 53 is reported, not a crash. **The process itself**, started as the agent starts it, as root on the runner: it runs as `nobody`, and cannot open the Docker socket, read the agent's directory or open a connection. Phase 2: nearest-first with a fixed small database and ECS present and absent, the resolver's address used without it, all servers without a location, at least two in an answer. Phase 3: the challenge endpoint sets and clears a TXT, which another agent of a fake mesh serves within a second, and refuses a name outside the zone.
- `deplo`: the zone table Deplo renders (golden file shared with the agent, as `answer-routes.golden.json` is); name server choice is stable and changes only when one leaves; the delegation check against a fake parent zone (delegated, missing glue, a stray DS, an apex asked to take a `CNAME`); refusals in the person's words; the times' ranges; the backend switching from `manual` and back. Phase 2: the DB-IP table is verified and handed only to agents with the capability.

**One small lab check per phase**, on LXC 103-106, with a lab resolver given the delegation as a stub zone, since the lab owns no public domain:

1. Phase 1: (a) normal answers list every healthy server; (b) power off a server: when it leaves each name server's answers (want the removal time) and the resolver's (want removal time + TTL); (c) isolate one server from the others: it answers `SERVFAIL` and the others keep answering without it; (d) one ADR-0048 failover run, so nothing regressed. Three runs of (b) and (c), one of (d).
2. Phase 2: two lab servers given distant regions, queries with ECS for each region and without: nearest first, both listed.
3. Phase 3: Pebble validating DNS-01 for a wildcard name through the lab resolver, with no token on any server; the certificate then travels with its App as in ADR-0048.

## Considered options

- **Records at a connected provider (ADR-0048)**: kept. It is the backend for whoever already has one.
- **Hand-written records (ADR-0048)**: kept as the backend that needs nothing, with its limits stated.
- **The name server inside the agent's own process**: this ADR's first version, rejected by amendment 1. It is the only code on the server that parses packets from anyone, and inside the agent a single bug there would hold root, the Docker socket and the agent's key.
- **The name server in a container**: as isolated, but it would hang on Docker (an image to pull, a daemon that restarts) and need the host's network to see a visitor's address; the agent's own child process needs neither.
- **The name server in the leader**: rejected. One process on one machine answers for the zone exactly when that machine may be the one that stopped.
- **A separate DNS daemon (CoreDNS, PowerDNS) beside the agent**: rejected. A second program per server to install, update and supervise, and a config format to render, for what is one table and a few hundred lines; the agent's own binary, started unprivileged, gives the same isolation.
- **Health from the leader's leases**: rejected. Answers would stop changing whenever the leader is away, and two leaders in a split would disagree; the private network's own "alive" messages are on every server already.
- **A DNS service Deplo runs for every instance**: rejected. It would make every install depend on a service outside it, which the installable product must not.
- **The location database downloaded by each instance every month**: rejected for amendment 3's way. Every install would fetch from the internet on its own clock, an offline one never would, and two instances on the same release would place visitors differently.
- **MaxMind GeoLite2**: rejected for its licence, above.

## Consequences

- **Port 53 opens on the servers that answer for a zone.** It is authoritative only, rate-limited and served by a process with no privileges, but it is a new public port; a host that blocks it simply is not a name server.
- **The person types records once**, at the registrar, and the screen checks them; a name server leaving the cluster asks for that once more.
- **Answers can differ between name servers for a few seconds** (each sees the private network from where it stands); every answer is a set of servers that answer for the App, so a visitor reaches it either way.
- **More than half of a cluster stopping at once takes its zone down** until they return or are removed from the cluster: the price of never answering from the wrong side of a split.
- **A two-server cluster keeps naming a stopped server**: either one alone is exactly half, so it answers the last agreed set. Three servers is the smallest cluster whose zone drops a stopped one.
- **No DNSSEC** until a later decision.

## See also

- [User documentation](https://deplo.build/docs) - the manual, in `DeploCloud/docs`
- [`AGENTS.md`](../../AGENTS.md) - the architecture rules these decisions produced
- [`CONTEXT.md`](../../CONTEXT.md) - the glossary
