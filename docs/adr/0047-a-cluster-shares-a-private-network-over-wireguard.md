# ADR-0047: A cluster shares a private network over WireGuard

**Status**: proposed. Supersedes the data path of [ADR-0044](0044-cluster-members-meet-through-a-relay-over-tcp.md), whose relay becomes the fallback; amends [ADR-0040](0040-a-server-agent-links-to-its-control-plane.md) and the cluster amendment of [ADR-0028](0028-an-environment-owns-a-network.md).

Every byte between two servers of a cluster took two internet legs through a relay on Deplo's machine, and stopped with it. **The servers of a cluster share a private network: a WireGuard tunnel between every two of them, run by each server agent in userspace on a network stack of its own** (`wireguard-go` with `netstack`). The host's interfaces, routes and firewall are never touched, so it runs on any Linux host, an unprivileged container included. Streams between servers (name forwarders, replication, image copies, a returning member's leftover data, and the leader's leases through the agent beside it) go through the tunnel; the relay is tried beside a stream only when the tunnel does not connect within a second.

- **Direct where it can be, relayed where it cannot.** Each agent answers on one UDP port (51820 when free) and probes every address Deplo names for a peer, and every address a peer's probes arrive from, once a second. A probe is MAC'd with a key only the two peers can derive from their WireGuard keys, so a path counts only once the peer itself answered on it, and a pair behind NAT punches its own hole. A pair with no direct path sends the tunnel's packets over a relay stream instead, still end-to-end encrypted. Path changes keep every open connection.
- **It needs nobody once it is up.** Each agent keeps its key, its address and its peers on disk, so the network comes back after a restart and keeps carrying traffic while Deplo or the leader is down. Only adding or removing a server, or a changed key, waits for Deplo. A direct pair outlives Deplo's machine; a relayed pair stops with the relays it uses.
- **Deplo hands out the network; the agent only runs it.** A server's tunnel address is derived from its id. Its key never leaves its agent; Deplo stores the public half (`cluster_network_peers`) and hands every server the others' keys, addresses and endpoints (`SetClusterNetwork`, Hello capability `cluster.network`). A server of a cluster that the leader may run on, Deplo's own machine included, is on its network.
- **"Accepts no incoming connection" now reads "answers no one it does not know".** The UDP socket gives nothing to a sender without a peer's key: WireGuard drops unauthenticated packets without a reply, and the agent drops a datagram from an address no peer has proved before WireGuard sees it.
- **Names still cross by name forwarders.** The tunnel connects agents, not containers: nothing routes container addresses between servers, so ADR-0028's boundary is still checked by the receiving agent alone.

## Considered options

- **Kernel WireGuard with routed container subnets**: rejected for now. It needs a kernel module, a host interface and firewall rules beside Docker's, the subnet of every Environment's network chosen per server, and still a name forwarder for DNS.
- **A relay only (ADR-0044)**: kept as the fallback. Alone it adds two internet legs to every query and stops with Deplo's machine.
- **A full mesh of TCP connections between agents**: rejected. Every pair would need an open TCP port, and NAT punches holes far more reliably for UDP.

## Consequences

- The tunnel to a peer is either direct or relayed, and the cluster's servers page says when it is relayed or down (`ClusterMember.network`). The database page's relay note follows the pair's path.
- A first handshake two servers start at once undoes itself in WireGuard and waits 5 s; the agent's transport lets the lower key's go on, so the network is up within milliseconds.
- `deplo-cluster` keeps its relay and dials members through the agent beside it (`DEPLO_CLUSTER_MESH_SOCKET`), and through the relays when that agent is away. Ship the agent first.
