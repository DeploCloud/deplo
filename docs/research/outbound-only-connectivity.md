# How machines that only connect outward reach each other

Research for [#149](https://github.com/DeploCloud/deplo/issues/149), map [#147](https://github.com/DeploCloud/deplo/issues/147) (clusters). November 2026.

## Summary

1. Two machines that both refuse incoming connections cannot meet without a third party that does accept them. Today the only such door in Deplo is the panel's HTTPS address ([S1], [S2]). Every option below either relays through a door like that or uses one briefly to introduce the two machines.
2. Relaying through the control plane is the simplest option, and it fails both needs. It stops whenever the Next.js process stops, because the link listener runs inside that process ([S3]), and every database query would cross Deplo's own uplink twice.
3. A direct WireGuard path, set up by hole punching, is the right data path. It succeeds for about 70% of pairs in the largest recent measurement ([P3]), costs one internet round trip, keeps working while Deplo is down ([T3]), and its socket answers nothing that cannot prove it knows the receiver's key ([P1] §5.1, §5.3).
4. The other ~30% of pairs, and every network that blocks UDP, need a relay. The relay must run over HTTPS on 443 ([T1], [R5] §3.1) and must not be the Next.js process.
5. Control traffic (need a) and database traffic (need b) can ride the same mesh. They differ only in which failure each can tolerate.

**Recommendation.** Give every cluster a **WireGuard mesh run inside the server agents and the cluster leader** (userspace, [G1]), with keys and endpoints handed out over the agent links that already exist. Each pair goes **direct when hole punching works**. Otherwise it falls back to a **small relay process on Deplo's machine, behind the same 443 door as the agent link but outside the Next.js process**. The relay only ever carries WireGuard ciphertext. A Deplo-run public relay can be added later as a second fallback for the managed service. Do not use the control plane as the relay, and do not use anything that needs an open port (Docker's overlay network, Nebula-style lighthouses, Tailscale-style peer relays). For need (b), do not route container addresses across the mesh. Carry one stream per managed database, so that ADR-0028's boundary is still enforced in one place.

**One decision for the map.** A WireGuard socket behind a hole-punched NAT mapping is, strictly speaking, a reachable UDP port while the mapping lives. It holds no state and sends no reply to anything unauthenticated ([P1] §5.1), so it is not a door anyone can flood with work. A volumetric flood saturates the link whether or not a port is open. The map's rule "accepts no incoming connection" should be read as "answers no one it does not already know", or this option is ruled out by wording alone.

## The constraints

- **Every server agent dials out and keeps one agent link open.** No server agent listens on a port ([S1] ADR-0040 l.7). The link is a WebSocket on the panel's public HTTPS address, with the mTLS inside it ([S1] l.9). It is chosen because it passes TLS-terminating and corporate HTTPS proxies ([S1] l.9, l.23).
- **The door decides nothing about trust.** It rate-limits per client address (120 per minute, `lib/infra/agent-link/protocol.ts:17-18`, `lib/infra/agent-link/door.ts:63-70`), and the mTLS handshake decides who is on the other end (`door.ts:45`, [S1] l.11).
- **The door lives in the control-plane process.** `startAgentLinkListener` is started from `instrumentation-node.ts:41-43`. It has its own HTTP listener only because Next's standalone server cannot hold an upgraded connection (`lib/infra/agent-link/listener.ts:24`). It goes down whenever the control plane does.
- **Agents are a star.** An agent "can neither dial nor trust a peer, so cross-host bytes pass through the control plane or not at all" ([S4] ADR-0020 l.24-30; `AGENTS.md:185`). Images, volumes and backups are already relayed this way (`lib/data/backup-transport.ts:154`, `relayBackup`).
- **An Environment owns a network, and nothing crosses it** ([S5] ADR-0028 l.26-31). That ADR exists because "any container could open a TCP connection to any port of any other app on the machine" ([S5] l.17-18). A cluster must not recreate that problem across machines.
- **A link drop is noticed in 10 s, and the agent backs off up to 30 s** (`protocol.ts:10-15`, [S1] l.15). These are the reaction times the cluster leader inherits if it rides the same mechanism.
- **From the map:** the leader runs on Deplo's machine by default, can be installed on another server, accepts no incoming connection, and must control its members while the control plane is down. Servers in different places that cannot reach each other must be supported.

## Background: why direct connections between NATed machines are hard

- **NAT mapping behaviour decides whether hole punching works.** RFC 4787 requires endpoint-independent mapping, because "failure to meet REQ-1 will force the use of a UDP relay" ([R1] §4.1). With address- and port-dependent mapping ("symmetric NAT"), the public port a peer learns from a reflector is not the port it gets toward the other peer. TURN's RFC says that when both hosts are behind such NATs, "hole punching techniques generally fail" ([R4] §1).
- **Filtering decides who may send to a mapping once it exists.** RFC 4787 recommends endpoint-independent filtering "if application transparency is most important", and address-dependent filtering where strictness matters more ([R1] §5, REQ-8). Carrier-grade NATs must meet RFC 4787 ([R2] §3 REQ-1), are RECOMMENDED to use endpoint-independent filtering ([R2] REQ-7), and may cap the ports per subscriber ([R2] REQ-4).
- **Hairpinning matters behind a shared carrier NAT.** Two peers behind the same carrier NAT reach each other only if the NAT hairpins ([R1] §6 REQ-9 makes it a MUST). "Once CGNAT is involved, hairpinning becomes vital to connectivity" ([T1]). Only 24% of NATs supported UDP hairpinning in the 2005 measurement ([P2] §6.2).
- **Measured success rates:**
  - 82% of NATs (310/380) allowed UDP hole punching and 64% (184/286) allowed TCP hole punching in 2005 ([P2] §6.2).
  - In the largest recent study, 4.4 million attempts across 85,000+ networks in 167 countries, the hole-punching stage succeeded 70% ± 7.1% of the time. TCP and QUIC were statistically indistinguishable, and 97.6% of successes came on the first attempt ([P3]).
  - With a full set of techniques (port-mapping protocols, IPv6, birthday-paradox probing), one implementer _estimates_ "over 90%" direct ([T1]). That figure is an estimate, not a measurement.
- **Some networks block UDP outright.** One example is a guest Wi-Fi that "blocks all outbound UDP except for DNS" ([T1]). For this case TURN carries its traffic over TCP or TLS ([R5] §3.1), and DERP runs over HTTP ([T1], [T4]). A relay that only speaks UDP is not enough.
- **Relays come last by design.** ICE gives relayed candidates type preference 0, which means "only be used as a last resort" ([R3] §5.1.2.1-2). TURN "comes at a high cost to the provider", so use it "only when a direct communication path cannot be found" ([R4] §1).

## The options

### 1. Relay through Deplo's control plane

Leader↔member calls and App↔database streams would travel A → agent link → control plane → agent link → B, the same way images and backups travel today ([S4], `backup-transport.ts:154`).

- **Behind NAT/CGNAT:** always works, as well as the agent link does ([S1]).
- **Latency/bandwidth:** every packet takes RTT(A↔panel) + RTT(panel↔B) instead of RTT(A↔B), plus a hop through Node. Every byte crosses Deplo's uplink twice. The link's frame cap is 4 MiB (`protocol.ts:16`). For a database, the added round trip is paid on every query.
- **While the control plane is down:** nothing works. The listener is part of the control-plane process (`instrumentation-node.ts:41-43`). This alone fails the map's requirement (a).
- **Attack surface/flood:** adds no new door. The door is the existing 443 one ([S1]). But a flood aimed at the panel would now also cut traffic between members, and the panel is the most visible address in the system.
- **Operational weight:** none for the user. For Deplo, it means long-lived, high-volume streams through the single control-plane process, which ADR-0006 decision 9 keeps single-process ([S6]).
- **Fit:** perfect on "the user knows nothing". Wrong on availability and data-path performance.

**Verdict:** acceptable for need (a) only in a degraded form that does nothing while Deplo is down. Unacceptable for need (b).

### 2. A dedicated relay

A process whose only job is to forward opaque, end-to-end-encrypted packets between parties that both dial out to it. DERP is the reference design: it "routes packets to clients using curve25519 keys as addresses" and proxies "encrypted WireGuard packets" ([T4]). It also carries discovery traffic before a direct path exists ([T2]). Relayed traffic stays encrypted end to end, and "it's impossible for a DERP server to decrypt your traffic" ([T2]). A modern standard alternative for the transport is MASQUE CONNECT-UDP, which proxies UDP over any HTTP version ([R6]).

Where it runs changes everything:

| Placement                                                            | Needs an incoming port?                                                                                                                                        | Survives control plane down? | Survives Deplo's machine down? |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------ |
| **2a. On Deplo's machine, own process, behind the panel's 443 door** | No new one: Traefik already forwards the agent link there ([S1] l.9)                                                                                           | **Yes** (separate process)   | No                             |
| **2b. Deplo-run public relays** (the managed-service future)         | Not on the user's side                                                                                                                                         | Yes                          | Yes                            |
| **2c. On a member with a public address** (self-run)                 | **Yes.** Peer relays need "the UDP port … open and accessible" ([T5]), and Nebula relays need "firewall rules that permit Nebula's UDP traffic inbound" ([N1]) | Yes                          | Yes                            |

- **Behind NAT/CGNAT:** always works, because both ends dial out. Over HTTPS on 443, it also works through networks that block UDP ([R5] §3.1, [T1]).
- **Latency/bandwidth:** detour latency as in option 1, minus the Node hop. Throughput is bounded by the relay's link. Even Tailscale says its relays "can introduce additional latency, especially for high-throughput applications" ([T5]).
- **While the control plane is down:** 2a and 2b keep forwarding. A client can keep a cached relay list across restarts ([T2]).
- **Attack surface/flood:** 2a adds no new port. It adds a second route behind the existing door, which should get its own rate limit like `door.ts:63-70`. A flood that takes out 443 on Deplo's machine takes out both the panel and the relay. 2b moves the flood target to infrastructure Deplo runs. 2c opens a port on a user's server, which the map forbids.
- **Operational weight:** 2a is one more process Deplo ships and supervises next to Traefik. 2b is a service Deplo operates. 2c is an expert-only knob.
- **Fit:** 2a and 2b are invisible to the user. 2c is expert, opt-in.

**Verdict:** the fallback for every pair hole punching cannot connect, and the rendezvous that introduces them. 2a by default, 2b later.

### 3. A direct connection Deplo introduces (hole punching + WireGuard)

Each machine runs WireGuard. The control plane, or the relay acting as rendezvous, tells each peer the other's key and its observed public address. Both send at once to open their NAT mappings, and traffic flows directly. When that fails, the same WireGuard packets go through the relay from option 2 ([T1], [T2]). WireGuard follows the peer's latest authenticated source address, so roaming and NAT rebinding repair themselves ([P1] §2.1).

- **Behind NAT/CGNAT:** direct for about 70% of pairs ([P3]), more with port-mapping protocols and IPv6 ([T1]). Symmetric NATs, NATs without hairpinning behind a shared carrier NAT, and networks that block UDP fall back to the relay ([R4] §1, [T1]). With a relay, it works everywhere.
- **Latency/bandwidth:** direct pairs pay one internet round trip and get close to the link's own throughput. Relayed pairs behave as in option 2.
- **While the control plane is down:** established direct paths keep working with keys cached on each device ([T3]). New paths can still be found while the relay (2a/2b) is up, because the relay carries discovery ([T2]). Adding a member, rotating keys and revoking a key all wait for the control plane ([T3]). Revocation is also where ADR-0011 already puts the trust decision.
- **Attack surface/flood:**
  - The WireGuard socket allocates no state for, and sends no reply to, unauthenticated packets. It is "invisible to illegitimate peers and network scanners" ([P1] §5.1).
  - Every handshake must carry a valid `mac1` keyed by the receiver's public key, so a sender who does not know that key gets nothing ([P1] §5.3).
  - Under load, the peer demands a cookie MAC (`mac2`) bound to the sender's IP, and the cookie reply is smaller than the message, so it cannot amplify an attack ([P1] §5.3, §5.4.7). Handshakes run on a low-priority worker ([P1] §7).
  - The mapping is reachable by anyone who learns it if the NAT filters endpoint-independently ([R1] REQ-8, [R2] REQ-7), but what answers is that silent socket. The address is never published; it travels only inside the mTLS links.
  - A volumetric flood fills the uplink whether or not a port exists, so no option here defends against one.
- **Operational weight:** the hard part is NAT traversal code: a STUN-like endpoint check through the relay, simultaneous sends, retries and path upgrades ([T1]). A userspace WireGuard (`wireguard-go` with `tun/netstack`, [G1]) runs inside the agent and the leader as a library. Peers connect with `DialContext`/`ListenTCP` on the tunnel's own network stack. No kernel interface, host route or firewall rule changes on the server.
- **Fit:** invisible to the user, as long as Deplo hands out the keys over the agent link and the relay is always there.

**Verdict:** the data path for need (b), and the preferred path for need (a).

### 4. Other options considered

- **Docker's overlay network.** Rejected. It needs 2377/tcp, 7946/tcp+udp and 4789/udp open between hosts, encrypts nothing unless `--opt encrypted` is set (IPsec, "a non-negligible performance penalty"), and supports no encryption on Windows ([D1]). It also routes container addresses across hosts, which is exactly the reachability ADR-0028 removed ([S5] l.17-18).
- **Router port mapping (UPnP IGD, NAT-PMP, PCP).** Useful as one more hole-punching technique, but "you can't rely on these protocols being present" ([T1]). It also opens a port on the user's router, so it can only be an extra attempt behind a silent WireGuard socket, never the plan.
- **IPv6.** Often skips the NAT entirely, but "it'll work fantastically well with some pairs of peers, and not at all for others" ([T1]). Worth trying first inside option 3. It is not a plan of its own.
- **The leader on a member with a public address, accepting connections.** Breaks the map's rule outright.

## Comparison

|                            | 1. Control-plane relay         | 2a. Relay on Deplo's machine | 2b. Deplo-run relay         | 3. Direct WireGuard (+2a/2b fallback)  |
| -------------------------- | ------------------------------ | ---------------------------- | --------------------------- | -------------------------------------- |
| Behind home router / CGNAT | Yes                            | Yes                          | Yes                         | ~70% direct ([P3]), rest relayed: yes  |
| UDP blocked                | Yes (443)                      | Yes (443)                    | Yes (443)                   | Via relay                              |
| Added latency              | Two legs + Node hop            | Two legs                     | Two legs (relay near peers) | None when direct                       |
| Bandwidth bound            | Deplo's uplink ×2, one process | Deplo's uplink ×2            | Deplo's relays              | The peers' own links                   |
| Control plane down         | **Stops**                      | Works                        | Works                       | Direct works; relayed per 2a/2b        |
| Deplo's machine down       | Stops                          | Stops                        | Works                       | Direct works; relayed per 2b           |
| New open port              | No                             | No (behind existing 443)     | No                          | Silent UDP socket behind a NAT mapping |
| Flood target               | The panel                      | The panel's 443              | Deplo's relays              | Each peer's uplink (volumetric only)   |
| Weight for Deplo           | Low                            | One process                  | A service to run            | NAT traversal code + relay             |
| User sees                  | Nothing                        | Nothing                      | Nothing                     | Nothing                                |

## By need

**(a) Leader controls members.** The traffic is small and tolerates latency, but it must keep working while the control plane is down, and the leader may run on another server. Carry the leader↔member gRPC (mTLS as today) inside the cluster's WireGuard mesh. Pairs that hole punching cannot connect fall back to relay 2a. While the control plane is down, everything keeps working except changes to membership or keys. While Deplo's whole machine is down, a remote leader still controls every member it reaches directly. Members reachable only through the relay stay out of its reach until 2b exists. That gap is the one honest limit of this design, and it disappears with Deplo-run relays.

**(b) App reaches its managed database on another member.** This traffic is sensitive to latency and heavy in bandwidth, so it needs the direct path. Keep ADR-0028's boundary in one place: do **not** route container subnets over the mesh. On the App's member, the agent puts a forwarder on `deplo-env-<id>` that answers as the database's name. It carries each TCP stream over the mesh to the database's member, whose agent connects only to a database of that same Environment. The control plane renders that wiring (`AGENTS.md:190`: routing logic is never ported into Go), so the agent only runs it. Relayed pairs work, but pay the detour on every query. The UI should be able to say "this database is reached through a relay" rather than hide it.

## Sources

**This repo**

- [S1] `docs/adr/0040-a-server-agent-links-to-its-control-plane.md` (lines cited inline).
- [S2] `CONTEXT.md`, "Agent link".
- [S3] `instrumentation-node.ts:41-43`; `lib/infra/agent-link/listener.ts:24`; `lib/infra/agent-link/protocol.ts:10-18`; `lib/infra/agent-link/door.ts:45,63-70`.
- [S4] `docs/adr/0020-a-build-server-builds-for-hosts-it-does-not-run-on.md` l.24-30; `lib/data/backup-transport.ts:154`; `AGENTS.md:185`.
- [S5] `docs/adr/0028-an-environment-owns-a-network.md` l.17-18, l.26-31.
- [S6] `docs/adr/0006-server-agent-is-a-per-host-go-binary.md`, decisions 9 and 10 (l.188, l.196).

**Standards**

- [R1] RFC 4787, _NAT Behavioral Requirements for Unicast UDP_. <https://www.rfc-editor.org/rfc/rfc4787.html>
- [R2] RFC 6888, _Common Requirements for Carrier-Grade NATs_. <https://www.rfc-editor.org/rfc/rfc6888.html>
- [R3] RFC 8445, _Interactive Connectivity Establishment (ICE)_. <https://www.rfc-editor.org/rfc/rfc8445.html>
- [R4] RFC 8656, _Traversal Using Relays around NAT (TURN)_, §1. <https://www.rfc-editor.org/rfc/rfc8656.html>
- [R5] RFC 8656 §3.1 (TURN over UDP, TCP, TLS). Same document.
- [R6] RFC 9298, _Proxying UDP in HTTP_. <https://www.rfc-editor.org/rfc/rfc9298.html>

**Papers**

- [P1] J. A. Donenfeld, _WireGuard: Next Generation Kernel Network Tunnel_, NDSS 2017, §2.1, §5.1, §5.3, §5.4.7, §7. <https://www.wireguard.com/papers/wireguard.pdf>
- [P2] B. Ford, P. Srisuresh, D. Kegel, _Peer-to-Peer Communication Across Network Address Translators_, USENIX ATC 2005, §6.2. <https://bford.info/pub/net/p2pnat/>
- [P3] D. Trautwein et al., _Challenging Tribal Knowledge: Large Scale Measurement Campaign on Decentralized NAT Traversal_, arXiv:2510.27500 (2025). <https://arxiv.org/abs/2510.27500>

**Implementations and vendor documentation**

- [T1] Tailscale, _How NAT traversal works_ (2020). <https://tailscale.com/blog/how-nat-traversal-works>
- [T2] Tailscale, _DERP servers_. <https://tailscale.com/kb/1232/derp-servers>
- [T3] Tailscale, _What happens if the coordination server is down_. <https://tailscale.com/docs/reference/coordination-server-down>
- [T4] `tailscale.com/derp` package documentation and source. <https://pkg.go.dev/tailscale.com/derp>
- [T5] Tailscale, _Peer relays_. <https://tailscale.com/kb/1591/peer-relays>
- [N1] Nebula, _relay_ configuration. <https://nebula.defined.net/docs/config/relay/>
- [G1] `golang.zx2c4.com/wireguard/tun/netstack` (`CreateNetTUN`, `Net.DialContext`, `Net.ListenTCP`). <https://pkg.go.dev/golang.zx2c4.com/wireguard/tun/netstack>
- [D1] Docker, _Overlay network driver_. <https://docs.docker.com/engine/network/drivers/overlay/>
