# How a domain reaches whichever cluster member runs its App

Research for [#148](https://github.com/DeploCloud/deplo/issues/148) (map [#147](https://github.com/DeploCloud/deplo/issues/147)). November 2026.

## Summary

1. **Cloudflare Tunnel is the only option that fits every constraint**: no incoming port on any member, members in different places, free up to 1,000 tunnels per account, and Deplo already creates tunnels, routes and DNS records for app domains from an API token ([R1], [R2], [C1]).
2. **Give each cluster App its own tunnel, and run that tunnel's connector on every member that runs the App.** Cloudflare then picks a live member on its own: when a member dies, its connections drop within about 5 seconds and Cloudflare retries another connector ([C3], [C9], [C10]). The DNS record never changes, so failover needs no DNS edit and no Cloudflare API token on the leader.
3. **Changing DNS records through a provider's API is a poor fit**: a 30-60 second minimum TTL ([C5], [D1]), Chrome's own 1-minute cache ([B1]), browsers that wait for a dead address to time out before trying the next ([B2], [B3]), and Let's Encrypt's HTTP challenge, which Deplo uses ([R5]), breaks when a name points at several servers ([L1]).
4. **One entry server forwarding to the others** brings back an incoming connection to every member (or a relay Deplo would have to build), doubles traffic, and takes every cluster App offline when the entry server dies. Floating IPs only move inside one provider's zone ([F1], [F2]).
5. **Recommendation**: a tunnel per cluster App (or per group of Apps placed on the same members), connector shipped by the leader with the App. A cluster App's domain must be in a Cloudflare zone connected for automatic DNS. Default `deplo.site` addresses carry one server's IP and cannot follow a failover ([R7]). The spec has to decide what those Apps get.

## What Deplo already has

- **Automatic DNS through Cloudflare.** A person connects a Cloudflare zone with an API token (`dns_providers`, `lib/db/schema/control-plane/dns-providers.ts:16`). For a domain in that zone Deplo creates either an A/AAAA record pointing at the server, or a proxied CNAME to a tunnel (`provisionDomainDns`, `lib/data/dns-providers/provision.ts:129`).
- **One tunnel per provider account and server** (`dnsProviderTunnels`, `lib/db/schema/control-plane/dns-providers.ts:56`). `ensureServerTunnel` creates it on first use, adds the hostname to its ingress and runs a `cloudflared` connector beside that server's proxy (`lib/data/dns-providers/tunnels.ts:92-165`). The ingress sends every hostname to the server's own Traefik (`appTunnelIngress`, `lib/deploy/panel-tunnel-stack.ts:43`). The DNS record is a proxied CNAME to `<tunnel>.cfargotunnel.com` (`pointAtTunnel`, `lib/cloudflare/tunnel-api.ts:240`, `proxied: true` at :268).
- **The address-record path points at one address only**: `targets.v4[0]` / `targets.v6[0]` (`lib/data/dns-providers/provision.ts:152-157`), `proxied: false`, TTL automatic (`lib/cloudflare/tunnel-api.ts:283-313`).
- **Certificates come from Let's Encrypt's HTTP challenge on each server's Traefik** (`install.sh:2225`, `install-agent.sh:1331`). A custom certificate lives on one server only (`CONTEXT.md:1070`).
- **Default addresses embed one server's IP**: `<name>-<hex ip>.deplo.site` (`lib/wildcard-dns.ts:1-3`). A server move rewrites the name (`rehostWildcard`, `lib/deploy/domains.ts:399`), so the address changes.
- **A server counts as offline about 10 seconds after its link drops** (ADR-0040, `docs/adr/0040-a-server-agent-links-to-its-control-plane.md:15`). The leader must keep failing Apps over while Deplo is down, and it never builds compose files (ADR-0043, `docs/adr/0043-a-cluster-is-led-by-its-own-leader-not-kubernetes.md:7`).

## Comparison

|                        | 1. Cloudflare Tunnel                                                                                       | 2. DNS records through a provider's API                                                                                    | 3. One entry server forwarding                                                                | 4. Floating IP                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Asks of the user       | Domain in a Cloudflare zone, connected once with a token (already the automatic DNS flow)                  | An API token for their DNS provider, plus a supported provider (Namecheap: IP allowlist and a spend threshold, [D3])       | Nothing extra if Deplo runs it, but an incoming port on every member, or a relay Deplo builds | A provider with floating IPs, all members in one zone, OS network config |
| Members behind routers | Yes, outbound only [C2]                                                                                    | No: each member needs a public address and open 80/443                                                                     | No, unless members dial the entry server                                                      | No                                                                       |
| Switch-over            | Replicas: ~5 s (connection drop) [C9][C10]. Single copy: detection plus starting the App on the new member | TTL (min 30-60 s) plus resolver and browser caches (Chrome 1 min) plus connect timeouts up to ~2 min on a silent dead host | Seconds (proxy health check), but the entry server itself has no failover                     | Seconds to a minute, provider API; not documented                        |
| Cost                   | Free up to 1,000 tunnels per account, then $4.50 per tunnel per month [C4]                                 | Free at Cloudflare, DigitalOcean, GoDaddy. Route 53 health checks are paid [D4]                                            | All traffic crosses the entry server twice                                                    | Provider's IP price                                                      |
| Certificates           | Cloudflare's edge certificate; nothing to issue per member                                                 | HTTP challenge breaks with several A records [L1]; needs DNS challenge or shared certificates                              | Only the entry server needs certificates                                                      | Unchanged                                                                |
| Fits Deplo             | Yes; code exists                                                                                           | Partly; one adapter per provider                                                                                           | Conflicts with ADR-0040 and the no-single-point goal                                          | Only for experts on one provider                                         |

### 1. Cloudflare Tunnel

**How several connectors share one tunnel.** One tunnel may run up to 25 active `cloudflared` replicas ([C1]). "When a request arrives at Cloudflare, it is forwarded to the geographically closest replica. If that connection fails, Cloudflare retries with other replicas, but there is no guarantee about which one is chosen." Replicas "do not support traffic steering (such as round-robin or hash-based routing)" ([C3]). So connectors give **failover, not load balancing**. Each connector opens four connections by default (`ha-connections`, `cmd/cloudflared/tunnel/cmd.go:781-784` [C8]), over QUIC unless UDP is blocked ([C8] `connection/protocol.go:10`).

**How fast.** `cloudflared` sets a QUIC idle timeout of 5 s and pings every second (`quic/constants.go:6-8`, [C9]). In QUIC the effective idle timeout is the smaller of the two sides' values ([C10]), so a powered-off member's connections close within about 5 s. Cloudflare does not publish how fast its edge then stops choosing that connector; the spec should measure it.

**What it does not do.** Retrying happens on a failed connection, not on an HTTP error. A member whose connector is up but whose App has died still gets the traffic, and Traefik answers with Deplo's offline page. So a connector must run only where the App runs, and stop when the App stops there. A connector must also never sit on a standby member: the closest connector wins ([C3]), so an idle standby could take the traffic.

**Why a tunnel per App, not per member or per cluster.**

- _Per member (today's model)._ A hostname has one CNAME, so it can reach one member's tunnel only. Failover would mean rewriting the CNAME to the next member's tunnel and that tunnel's ingress. Visitors' resolvers hold only Cloudflare's anycast addresses for a proxied record ([C6]), so a rewrite does not wait on resolver TTLs, but Cloudflare documents no edge propagation time and says changes can take up to the 300 s proxied TTL to be seen ([C5]). It also needs the account API token on whoever performs failover: the leader, while Deplo is down (ADR-0043). That token can edit the whole zone.
- _Per cluster, a connector on every member._ Every member would get requests for Apps it does not run, and Cloudflare does not retry on a 404 or 503. It would only work if members could forward to each other, which they may not.
- _Per App._ The App's hostnames are in its tunnel's ingress, the CNAME never changes, and failover is "start the App and its connector on the new member". The leader needs only that tunnel's run token, which can run that one tunnel and nothing else. It can ship it the way it re-sends the App's last stack. Replicas on several members work with no extra step.

**Cost and limits.** Tunnels are free; 1,000 per account are included and more cost $4.50 each per month ([C4]). Each tunnel takes up to 25 replicas ([C1]). That is one connector process per App per member, so Apps placed on exactly the same members could share one tunnel to save processes. The trade-off is that an App moving to a different set of members then changes CNAME. Cloudflare Load Balancing could balance between member tunnels instead, from $5 per month ([C7]), with health checks no faster than every 60 s below the Business plan ([C11]). It treats replicas of one tunnel as one endpoint and supports a tunnel endpoint only active-passive per pool ([C12]). That makes it an expert extra, not the default.

**What it asks of the user.** Their domain must use Cloudflare's nameservers, a one-time DNS change. Today that is only asked by the expert automatic DNS screen. Clusters are expert and opt-in (#147), so requiring it for a cluster App's own domain is consistent. Visitors' traffic passes through Cloudflare, which terminates TLS.

### 2. Deplo updating DNS records through a provider's API

**Providers with usable APIs.** Cloudflare (already integrated), DigitalOcean, AWS Route 53, and GoDaddy, which since April 2026 opens its DNS API to accounts with one domain ([D2]). Namecheap requires 20 domains, a $50 balance or $50 spent in two years, plus an IPv4 allowlist of the calling machines ([D3]). That is hard for an install whose leader can move between machines.

**Minimum TTLs.** Cloudflare DNS-only records: 60 s (30 s on Enterprise); proxied records are fixed at 300 s ([C5]). DigitalOcean: 30 s ([D1]).

**Caches on the way.** Cloudflare warns that local caches can take longer than the TTL ([C5]). Chrome caches the operating system's answers for 1 minute regardless of TTL (`HostResolverSystemTask::kTtl = base::Minutes(1)`, `net/dns/host_resolver_system_task.h:149` [B1]).

**Several A records when one member is down.** Chrome tries the next address only after the current connect fails (`transport_connect_sub_job.cc:134-152` [B2]). Its 300 ms race is only between IPv6 and IPv4 (`kIPv6FallbackTime`, `transport_connect_job.h:133` [B2]). RFC 8305 recommends starting the next address after 250 ms without waiting ([B3]), but Chrome does not do that for addresses of the same family. A dead machine that sends no reply fails only on the operating system's connect timeout, about 131 s on Linux by default ([B4]). Route 53's multivalue answers return only healthy addresses, up to eight, with health checks ([D4]), but those cost extra for non-AWS endpoints ([D5]) and still meet the same caches.

**Certificates.** With several A records Let's Encrypt's HTTP challenge may reach a member that did not ask for it: "If you have multiple web servers, you have to make sure the file is available on all of them" ([L1]). Deplo would need the DNS challenge, which needs the DNS API credentials on every member ([L1]), or a shared certificate store.

**Verdict.** It needs an open port on every member, gives visitors one to several minutes of errors after a failure, and needs one adapter per provider. It is only worth considering as an expert fallback for domains not on Cloudflare.

### 3. One entry server forwarding to the others

Traefik can do it: a `failover` service sends traffic to a fallback when the main service fails its health check (default interval 30 s) or answers listed status codes. Its health check works only with the file provider ([T1]). But:

- The entry server must reach members that accept no incoming connection. Deplo would have to build a tunnel from each member to it, which is what Cloudflare Tunnel already is.
- Every request crosses the entry server's network twice.
- When the entry server dies, every cluster App is down, and nothing moves its address. That is the single point of failure clusters exist to remove. Using Deplo's own machine as the entry is ruled out too: Deplo's own survival is out of scope (#147).

It only makes sense when all members sit on one private network, which #147 says must not be assumed.

### 4. Floating IPs from a hosting provider

Hetzner Floating IPs move between servers in one network zone, and must be configured in each server's operating system ([F1]). DigitalOcean Reserved IPs move between Droplets in the same datacenter, three per account by default ([F2]). True anycast needs your own address space and routing, far outside a non-expert's reach. This is an expert option for clusters on one provider in one region, never the default.

## Open questions for the spec

- **Default addresses.** A cluster App without a domain in a connected Cloudflare zone has only a `deplo.site` address tied to one IP ([R7]). Either clusters require a connected zone, or the App's address changes on failover, which the UI must say.
- **Who holds which secret.** Under the per-App tunnel design the leader needs connector tokens only. Under the CNAME-swap design it would need the account API token (ADR-0043 leaves what a leader may keep open).
- **Edge timing.** Measure how long Cloudflare keeps sending to a member that lost power, before promising a number in the UI.
- **Process count.** Measure a connector's memory, to decide between one tunnel per App and one per group of members.
- **Custom certificates.** These live on one server ([R6]). They must be copied to every member, or a tunnel-served domain stops needing them.

## Sources

Repository (this checkout, `main` at `0aa4d810`):

- [R1] `lib/data/dns-providers/provision.ts:129-197`, `provisionDomainDns`
- [R2] `lib/data/dns-providers/tunnels.ts:92-165`, `ensureServerTunnel`
- [R3] `lib/cloudflare/tunnel-api.ts:240-313`, `pointAtTunnel`, `pointAtAddress`
- [R4] `lib/deploy/panel-tunnel-stack.ts:43-105`, ingress and connector service
- [R5] `install.sh:2225-2226`, `install-agent.sh:1331-1332`, Let's Encrypt HTTP challenge
- [R6] `CONTEXT.md:1067-1072`, custom certificate on one server
- [R7] `lib/wildcard-dns.ts:1-3`, `lib/deploy/domains.ts:399-405`
- ADR-0040, ADR-0042, ADR-0043 in `docs/adr/`

Cloudflare:

- [C1] Account limits, Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/account-limits/
- [C2] Cloudflare Tunnel overview: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- [C3] Tunnel availability and failover (replicas): https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/
- [C4] Tunnels for Platforms (1,000 free, $4.50 each after): https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/
- [C5] Time to Live (TTL): https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/
- [C6] Proxy status: https://developers.cloudflare.com/dns/proxy-status/
- [C7] Plans, Network & CDN add-ons (Load Balancing from $5/mo): https://www.cloudflare.com/plans/network-cdn.md
- [C8] `cloudflared` source, commit `3106f949`: https://github.com/cloudflare/cloudflared (`cmd/cloudflared/tunnel/cmd.go:781-784`, `connection/protocol.go:10`)
- [C9] `cloudflared` QUIC constants: https://github.com/cloudflare/cloudflared/blob/master/quic/constants.go (lines 6-8), used in `connection/quic_config.go:27-29`
- [C10] RFC 9000 §10.1, Idle Timeout: https://www.rfc-editor.org/rfc/rfc9000#section-10.1
- [C11] Load Balancing, create a monitor (60 s Pro, 15 s Business, 10 s Enterprise): https://developers.cloudflare.com/load-balancing/monitors/create-monitor/
- [C12] Public load balancers with tunnels: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/public-load-balancers/

DNS providers:

- [D1] DigitalOcean DNS limits (30 s minimum TTL): https://docs.digitalocean.com/products/networking/dns/details/limits/
- [D2] GoDaddy, "DNS API now works with a single domain" (28 Apr 2026): https://www.godaddy.com/resources/news/godaddy-dns-api-now-works-with-a-single-domain
- [D3] Namecheap API FAQ and intro: https://www.namecheap.com/support/knowledgebase/article.aspx/9739/63/api-faq/ , https://www.namecheap.com/support/api/intro/
- [D4] Route 53 multivalue answer routing: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-multivalue.html
- [D5] Route 53 health check values: https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/health-checks-creating-values.html

Browsers and protocols:

- [B1] Chromium `net/dns/host_resolver_system_task.h:149`: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/dns/host_resolver_system_task.h
- [B2] Chromium `net/socket/transport_connect_sub_job.cc:134-152` and `transport_connect_job.h:133`: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/socket/
- [B3] RFC 8305 §5, Happy Eyeballs v2 connection attempts: https://www.rfc-editor.org/rfc/rfc8305#section-5
- [B4] Linux `tcp_syn_retries`: https://www.kernel.org/doc/html/latest/networking/ip-sysctl.html
- [L1] Let's Encrypt challenge types: https://letsencrypt.org/docs/challenge-types/
- [T1] Traefik HTTP services, failover and health checks: https://doc.traefik.io/traefik/reference/routing-configuration/http/load-balancing/service/

Floating IPs:

- [F1] Hetzner Floating IP FAQ: https://docs.hetzner.com/cloud/floating-ips/faq/
- [F2] DigitalOcean Reserved IPs and limits: https://docs.digitalocean.com/products/networking/reserved-ips/ , https://docs.digitalocean.com/products/networking/reserved-ips/details/limits/
