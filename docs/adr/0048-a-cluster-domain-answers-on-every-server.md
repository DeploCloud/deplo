# ADR-0048: A cluster domain can answer on every server

**Status**: proposed. Builds on [ADR-0047](0047-a-cluster-shares-a-private-network-over-wireguard.md) (the private network carries the traffic) and amends [ADR-0045](0045-a-cluster-leader-holds-sealed-failover-bundles.md) (the bundle carries the certificate). [ADR-0049](0049-a-cluster-can-answer-for-its-own-dns-zone.md) is the path that removes the hand-written records.

A failover moves an App, and its address must follow it **without Cloudflare being required**. Today only a domain served by a Cloudflare tunnel follows; a generated name follows by being renamed (it is a server's IP); any other domain keeps pointing at the server that stopped. **A domain of a cluster App can be set to answer on every server of the cluster ("Answer on every server"): each server passes its encrypted traffic, untouched, over the private network to a server that runs the App, and DNS names every healthy server.** Cloudflare stays a supported way to follow, not the only one.

The lab facts below come from Traefik 3.7.17 (the version Deplo installs) with Pebble standing in for Let's Encrypt, validating HTTP-01 for real through a DNS the test controlled.

## Decision

### Which domains

- **Opt-in per domain, off by default.** Every server then carries some traffic of an App it does not run.
- **HTTPS only.** On port 80 an HTTPS host gets only the redirect to HTTPS and the certificate checks: `routing.ts` puts an HTTPS route on `websecure` alone, and the entrypoint's redirect (priority 1) answers the rest. A plain-HTTP domain's requests would be passed on as plain HTTP, which carries no PROXY header, so its App would lose every visitor's address; it cannot turn the switch on.
- **Never for a hostname shared by path.** One team may serve `app.com` and `app.com/api` from two Apps (AGENTS.md). Passthrough by SNI sends a whole hostname to one server and cannot split it by path, and a failover may separate two Apps that run together now, so the switch is refused for any hostname another App serves a path of, and a path cannot be added to a hostname that has it on.
- **Never for a domain the App's Cloudflare tunnel serves**, and such a domain cannot move to the tunnel while it has the switch on. Its visitors reach the App's connector, not the servers' proxies, and the two ways of following would each claim the name's DNS record.
- **Its App runs on one server.** Each proxy that runs the App's router orders a certificate for its hostnames, and only one server can answer the checks. So its replicas stay together, and load balancing passes it by (a new reason beside `LB_KEEPS_DATA`), even when another of its domains is on Cloudflare.

### The path of a connection

The private network connects agents, not containers (ADR-0047): the proxy never sees an address of it. **Every server of the cluster carries the App's entrance, the one that runs the App included**, so a server's answer never depends on Deplo having caught up with a failover:

1. The visitor reaches any server S. S's proxy matches the hostname by SNI on `websecure` (a TCP router with TLS passthrough) and opens a connection with a PROXY protocol v2 header first, to S's **entrance forwarder**. Traefik takes the TCP `serversTransport` that sends it from the file provider only, so it ships in Deplo's own file, `deplo-entrance.yml`.
2. The entrance forwarder is one container per server for every App with the switch, on the proxy's `deplo` network, the same kind as a name forwarder: no privilege, read-only, and only the agent's socket mounted. Each App has two ports of it, one for its TLS and one for its checks, which Deplo assigns.
3. The forwarder hands the connection to S's agent through the socket, with the port the proxy dialed, which names the App.
4. S's agent picks a server the leader placed the App on (below), and opens a stream over the private network to that server's agent, naming the App. When that is S itself, it skips the stream.
5. The App's server's agent accepts it only from a member of the cluster, for an App Deplo said this server answers for, while the leader places the App there and the App is ready. It connects to its proxy's **internal entrypoint**, from inside the proxy's own network.
6. That proxy reads the visitor's address from the PROXY header, terminates TLS with its own certificate, and routes the request to the App like any other. On the lab the App saw the visitor's own address through another server, and through its own.

### Which server, and when there is none yet

- **This server first, then the least busy.** The agent tries the servers the leader placed the App on: itself first when it runs the App, then the others, starting with the one it has the fewest connections open to. A server that refuses (not placed there, not ready, not reached) is passed over for the next. Name forwarders now pick the same way and fall back the same way, which matters where load balancing runs an App on every server. An App with the switch has one server, but a move or a takeover can briefly place it on two.
- **A placement is not an App that answers.** The leader names a server only once its start has an outcome (`told()` shows a start under way as placed nowhere), and a started App may still be booting. The receiving agent calls an App ready when one of its containers runs, is healthy where it has a health check, and has been so for 3 s (Traefik applies a container change up to 2 s after it, `providersThrottleDuration`).
- **During a failover, the visitor waits.** While no server is ready, the connection is held unanswered and looked at again every half second, for up to 30 s, then closed. The visitor sees a page that is slow to load, never a certificate the domain does not have or a proxy without its route; past 30 s, a failed connection the browser can retry. An error page would need TLS on a server that has no certificate for the domain.

### The proxy

- **The internal entrypoint listens on the proxy's own loopback** (`127.0.0.1:<entrance_port>`) and trusts the PROXY header only from there. No other container and nothing outside reaches it (on the lab a connection from the network was refused); the agent reaches it by entering the proxy's network for that one connection, as it already enters a forwarder's to redirect its ports. The public `websecure` never trusts a PROXY header: where Docker's proxy for published ports makes every visitor look local, trusting it would let any visitor forge an address. The App's routers for such a domain list both entrypoints.
- **The routes live in a file the agent writes, not on a container.** Deplo renders each App's routers and services (the TCP router by SNI, the check router, their services) as Traefik dynamic configuration; the agent checks them and writes them all into `entrances.yml`, a file of the proxy's own stack that the proxy mounts into its file provider. Traefik watches each file of that directory by inode, so the agent rewrites it in place and the proxy reloads it without a restart: an App that turns the switch on or off cuts no connection anywhere. Deplo's other files there are compose `configs`, fixed when the proxy starts, which is why the routes are not one of them.
- **The agent takes only the routes' expected forms.** Routers and services named for the App (`deplo-entrance-<App id>`); a TCP router on `websecure` only, by `HostSNI` only, with passthrough, to the App's own TLS port with the PROXY transport; an HTTP router on `web` only, for the App's hostnames and the check path only, to its own check port. No middleware, no other entrypoint, no `@internal` service, and no hostname two Apps claim.
- **No HTTP/3 for these domains.** The private network carries TCP only, so a browser told `Alt-Svc: h3` would try UDP at a server that forwards none. Deplo's proxy enables no HTTP/3; the internal entrypoint never does, and the switch is refused while a server of the cluster runs a hand-edited proxy that does on `websecure`.
- **Port 80 passes the domain's certificate checks on.** Each server routes the App's hostnames' `/.well-known/acme-challenge/` on `web` to the forwarder's check port, and the App's server's agent hands them to its internal entrypoint, where Deplo's file routes that path to Traefik's own challenge handler (`acme-http@internal`). So a check from any vantage point reaches the server that asked, its own included. It never goes back to `web`: there the App's own check router would take it again, a loop. It carries no PROXY header: an HTTP router cannot send one, and a check needs no visitor's address. On the lab, the App's server obtained its certificate through another server, and renewed it through its own.
- **`allowACMEByPass: true` on `web`, and nowhere else, with Deplo's own challenge router.** Without the bypass Traefik answers every check itself at the highest priority, and returns 404 for a token another server asked for. With it, Traefik's router drops to priority 0 (its rule's length), so Deplo's file adds the same router on `web` and on the internal entrypoint at priority 2,000,000,000: above every router Deplo writes (a path route is 1,000,000 plus its length), so every other domain's checks are answered exactly as before, and only an App's own check router, one above, passes first. On the lab a domain on today's flags and one on the new ones both obtained and renewed their certificates, a plain-HTTP domain still answered on `web`, and an HTTPS host on port 80 still redirected. It opens no other surface: only Deplo writes routers (the lint keeps a stack's own Traefik labels to middlewares, `compose-lint/traefik-labels.ts`), a hostname belongs to one team (`assertHostnameNotAnotherTeams`), and the agent takes no check router but for the App's own hostnames. `websecure` is unchanged: a TLS-ALPN check already passes through there, as Deplo configures no TLS challenge.
- **Only where it is used.** The proxy changes (the internal entrypoint, the bypass, Deplo's file, the mount of the routes file) reach only the servers of a cluster with at least one domain with the switch on. Every other server's proxy is untouched and never restarted for it. A server that joins such a cluster gets them as it joins; when the last such domain is turned off, or a server leaves, they come off again, one server at a time.

### The certificate travels with the App

A failover must not wait for a new certificate (HTTPS errors meanwhile) nor order one each time: Let's Encrypt issues 5 duplicate certificates per name set per week, and an App that moves back and forth would lock its domain out for days.

- **Only for domains with the switch on**, sealed to the leader's key like the App's secret variables, never in a DTO or a log.
- **Exported when the switch turns on, and after every change.** The App's server's agent reads the certificate and key from its proxy's store (reading is safe while it runs): at once when the switch turns on, when the domain already has one, then whenever the store's copy changes (first issue, renewal). Deplo seals each into the App's failover bundle. Until the bundle holds the domain's certificate, the domain says its failover is not ready, as a missing version copy does.
- **What the lab showed:**
  1. A proxy that starts with the certificate in its store orders none while it is valid, and renews it itself in its window (an ACME account is not needed: it registers its own).
  2. A certificate written into the store of a running proxy is not seen, and the proxy erases it the next time it writes its store: after another order, the entry was gone.
  3. A certificate given as a file is served and orders nothing, but is never renewed, and is still served once it has expired.
  4. A file wins over the store's entry for the same host, older or newer.
  5. The proxy renews every entry of its store, whether a router still names the host or not.
- **So the agent writes the store only between the proxy stopping and starting.** It keeps beside the store what the store must hold, and merges it in at every start it makes (a configuration change, the restart button, its own restart below). For each domain with the switch the store holds the newest certificate the agent knows, its own or the bundle's, while the App runs on that server, and none while it does not.
- **On the server a failover starts the App on**, the certificate goes in as a file at once, which answers before the App does, and into the store at the proxy's next start, where the file goes: a file left there would hide every renewal of the store's copy.
- **A server that comes back after a failover** never serves the domain from its store: its entrance takes the hostname by SNI before any router of its own, and its copy of the App stays stopped. A renewal it attempts fails, since every check for the domain is passed on to the App's server, which did not ask: no certificate is issued, so no duplicate is spent. Its stale entry goes at its proxy's next start. If the App comes back to it, the bundle's newer certificate goes in as a file, which wins, and into the store at the next start, before the old entry's window opens.
- **One restart, in the quietest hour, recorded.** A store that must change waits for the proxy's next start. When none comes before the renewal window of the entry the store holds (30 days before it expires), the agent restarts the proxy once, at the quietest hour it knows of before then: it keeps an hourly profile of the server's network traffic over the last seven days, and with none yet it picks 04:00 server time. It records each such restart, when and why; Deplo writes it into the Activity of every team with an App on that server when it next hears from the agent, so one made while Deplo was down still appears.

### DNS lists every healthy server

Deplo computes the record set (one A, and one AAAA where there is IPv6, per server that is online and not being emptied) and the domain's **DNS backend** applies it:

- **a connected provider** (Cloudflare today, `DnsProviderKind`): Deplo writes the set as plain records (`pointAtAddress` writes one today), TTL 60 s, and rewrites it when a server joins, leaves, goes offline or comes back.
- **manual**: the domain lists every address to add, verification checks that each one is there, and a change of the cluster flags the domain until its records match again.
- **native**: [ADR-0049](0049-a-cluster-can-answer-for-its-own-dns-zone.md). The backend is a per-domain choice, so it plugs in without changing the rest.

## Rollout

- **The agent first**, behind the Hello capability `cluster.forwarders.entrances`, then the panel in small steps: (1) the proxy change and the entrance table, driven by a domain setting nothing can turn on yet; (2) the certificate in the bundle, with the agent's part of it; (3) the DNS record set; (4) the switch, shown. It stays hidden until step 2 is in: before it, a failover would order a new certificate each time, and the duplicate limit would be the risk this ADR removes.
- **The proxy change rolls out like the agent** (`docs/agents/cluster-rollout.md`): one server at a time, never before that server's agent has the capability. Applying it restarts that proxy: Traefik stops accepting new connections, gives requests in flight up to 10 s (`lifeCycle.graceTimeOut`), and closes every open connection, WebSockets and long downloads included; a visitor reconnects to the new proxy a second or two later, and to another server meanwhile once its domain lists several.

## Considered options

- **One forwarder per App, with its routes on the container's labels**: this ADR's first version. Measured on a lab server, a forwarder costs about 8 MB of memory (4 MB in its container, the rest in its `containerd-shim`), so 100 Apps would have cost about 840 MB on every server.
- **One forwarder whose labels carry every App**: the cost of one, but labels cannot change on a running container, so each change would recreate it and cut every passed-on connection on that server; draining the old one would need a health check, which the forwarder's empty image has no shell to run.
- **The routes in Deplo's own file configs**: each change would restart the proxy.
- **Trusting the PROXY header from the `deplo` network's gateway**: the gateway differs per server, so the proxy's flags would differ per server, and every process on the host could connect from there. The proxy's own loopback needs nothing per server.
- **Breaking the port 80 loop with a `ClientIP` rule**: the address the agent connects from differs per server too.
- **DNS-01 where a provider is connected**: rejected. Traefik's DNS challenge needs the provider's API token in the proxy's environment on every server, and a token never leaves the control plane, encrypted (`dns_providers`). The way to reopen it is a DNS server of the cluster's own that answers the challenge, as `acme-dns` does ([ADR-0049](0049-a-cluster-can-answer-for-its-own-dns-zone.md)): no token on any server.
- **TLS-ALPN-01 instead of HTTP-01**: it passes through as well, but means a second certificate resolver on every server; HTTP-01 with the bypass on `web` keeps the one there is.
- **Every server orders its own certificate ahead of time**: rejected. Through passthrough only the App's server can answer a check, and N servers renewing the same names would spend the duplicate limit.
- **A new certificate after each failover**: rejected for the HTTPS gap and the duplicate limit above.
- **The certificate as a file only, renewed by the control plane**: not needed. Nothing could renew it but a new order on the App's server, and the store already does that.
- **Drop the file when the renewal window opens, and let the proxy order a fresh one**: avoids that one restart, but the host answers with the wrong certificate for the seconds an order takes, and it is a new order of a certificate still valid.
- **Terminating TLS on every server**: rejected. The key would sit on every server, and the App's own headers, auth and redirects would run twice.
- **Cloudflare only**: it already follows, and stays; it cannot be the only way.

## Consequences

- **A failover needs no DNS change, and no change on any server.** Every server answers for the App and picks where each connection goes, so the domain answers again as soon as the App is ready on another server, with Deplo up or not.
- **Deplo down is a degradation, not an outage.** Only taking a stopped server out of DNS waits for Deplo. Until then a visitor's browser that tries the stopped server first falls back to the next address after a few seconds, per visit. With no provider that is permanent until the records are edited, and the manual says so.
- **A member of the cluster can forge a visitor's address.** The App's server trusts the PROXY header its own agent passes on, and its agent passes on what any member sends. So an IP allow list on such a domain holds against visitors, not against a compromised server of the cluster.
- **Failover bundles now carry TLS private keys**, which no member receives at deploy: the one exception to ADR-0045's "exactly what a member already receives". A compromised leader machine also exposes the keys of the domains that answer on every server.
- **The cost is one forwarder per server**, about 8 MB, whatever the number of Apps; a table takes at most 200 Apps with the switch. Each open connection costs at most two copy buffers of 32 KB in every agent it crosses.
- **The App's own server carries its visitors through its agent too.** An agent restart (an update) cuts the open connections of these domains on every server, that one included.
- **A visitor may wait up to 30 s during a failover**, where today they would get an error.
- **Such an App keeps its replicas on one server**, and load balancing passes it by.
- **The store's change can add one restart of a server's proxy**, recorded in Activity, up to two months after a failover: only when that proxy has not started again before the renewal window.
- **Generated names are out of scope.** A generated name is one server's IP by construction; it keeps following by being renamed.

## See also

- [User documentation](https://deplo.build/docs) - the manual, in `DeploCloud/docs`
- [`AGENTS.md`](../../AGENTS.md) - the architecture rules these decisions produced
- [`CONTEXT.md`](../../CONTEXT.md) - the glossary
