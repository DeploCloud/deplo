# ADR-0048: A cluster domain can answer on every server

**Status**: proposed. Builds on [ADR-0047](0047-a-cluster-shares-a-private-network-over-wireguard.md) (the private network carries the traffic) and [ADR-0045](0045-a-cluster-leader-holds-sealed-failover-bundles.md) (the bundle carries the certificate).

A failover moves an App, and its address must follow it **without Cloudflare being required**. Today only a domain served by a Cloudflare tunnel follows; a generated name follows by being renamed (it is a server's IP); any other domain keeps pointing at the server that stopped. **A domain of a cluster App can be set to answer on every server of the cluster: each server passes its encrypted traffic, untouched, over the private network to the server that runs the App, and DNS names every healthy server.** Cloudflare stays a supported way to follow, not the only one.

- **Opt-in per domain.** "Answer on every server" is a switch on the domain, off by default: every server then carries some traffic of an App it does not run.
- **Passed through, never terminated elsewhere.** On every other server the proxy routes the hostname by SNI with TLS passthrough to a forwarder, which reaches the App's server through the private network. The certificate stays on the App's server. Port 80 is routed by `Host` the same way, for redirects and certificate checks.
- **The App sees the visitor's address.** The forwarding proxy sends a PROXY protocol v2 header (a TCP `serversTransport` with `proxyProtocol.version: 2`; Traefik 3.7 takes it from the file provider only, so it ships in the proxy's own file configs, like `deplo-cluster-relay.yml`). The App's server reads it on a **dedicated entrypoint that is not published** (`proxyProtocol.trustedIPs` = the host side only), and the App's routers for such a domain list that entrypoint too. The public `websecure` never trusts a PROXY header: where Docker's userland proxy makes every visitor look local, trusting it would let any visitor forge its address.
- **Certificates keep the HTTP-01 check.** Let's Encrypt checks from several places, and each may reach any server. Every server's port 80 routes the domain's `/.well-known/acme-challenge/` to the server that asked. That needs `allowACMEByPass: true` on `web`: without it Traefik answers every challenge itself at the highest priority and returns 404 for a token it did not ask for. A TLS-ALPN check already passes through with no change, because Deplo configures no TLS challenge.
- **The certificate travels with the App.** A failover must not wait for a new certificate (HTTPS errors meanwhile) nor ask for one each time: Let's Encrypt issues 5 duplicate certificates per name set per week, and an App that moves back and forth would lock its domain out for days. The App's server agent exports the certificate and key of each such domain from its proxy; Deplo seals them into the App's failover bundle on every renewal, beside its secret variables; the server the leader starts it on installs them before the App answers.
- **DNS lists every healthy server.** Deplo computes the record set (one A, and one AAAA where there is IPv6, per server that is online and not being emptied) and a **DNS backend** applies it:
  - **a connected provider** (Cloudflare today, `DnsProviderKind`): Deplo writes the set as plain records (`pointAtAddress` writes one today), TTL 60 s, and rewrites it when a server joins, leaves, goes offline or comes back. Removing a server that stopped is what keeps a visitor's browser from trying it first.
  - **manual**: the domain lists every address to add, verification checks that each one is there, and a change of the cluster flags the domain until its records match again.
  - **native** (later, not built): a DNS server the cluster runs for the zone. The backend is chosen per domain, so it plugs in without changing the rest.

## Considered options

- **DNS-01 where a provider is connected**: rejected for now. Traefik's DNS challenge needs the provider's API token in the proxy's environment on every server, while today a token never leaves the control plane, encrypted (`dns_providers`). Reconsider if Deplo ever requests certificates itself.
- **TLS-ALPN-01 instead of HTTP-01**: works through passthrough as well, but means a second certificate resolver on every server. HTTP-01 with `allowACMEByPass` keeps the one there is.
- **Every server requests its own certificate ahead of time**: rejected. Through passthrough only the App's server can answer a check, and N servers renewing the same names would spend the duplicate limit.
- **A new certificate after each failover**: rejected for the HTTPS gap and the duplicate limit above.
- **Terminating TLS on every server**: rejected. The key would sit on every server, and the App's own headers, auth and redirects would run twice.
- **Cloudflare only**: it already follows, and stays; it cannot be the only way.

## Consequences

- **Every server's proxy changes once**: a new unpublished entrypoint, `allowACMEByPass` on `web`, and a `serversTransport` file. Applying it restarts each server's proxy, one server at a time.
- **A hostname two Apps share by path** cannot answer on every server unless both run on the same server: SNI passthrough sends a whole hostname to one server. The switch is refused for a hostname another App serves a path of.
- **The server agent gains a forwarder that targets the App server's proxy** rather than a workload, behind a Hello capability, and accepts it only for a domain Deplo says that server runs.
- **DNS follows only while Deplo is up**: the leader moves the App without Deplo, but only Deplo rewrites records. Until it does, a visitor's browser falls back from the stopped server to the next address, which takes seconds per visit without a provider. The manual says so.
- **TLS keys enter failover bundles.** They are sealed to the leaders' keys like the secret variables already are, and never reach a DTO or a log.
- **Generated names are out of scope.** A generated name is one server's IP by construction; it keeps following by being renamed.
- **Open before code**: whether Traefik's resolver asks for its own certificate when a file certificate already covers the host. That decides whether the travelling certificate is installed as a file certificate or into the proxy's ACME store, and is checked on a lab server first.

## See also

- [User documentation](https://deplo.build/docs) - the manual, in `DeploCloud/docs`
- [`AGENTS.md`](../../AGENTS.md) - the architecture rules these decisions produced
- [`CONTEXT.md`](../../CONTEXT.md) - the glossary
