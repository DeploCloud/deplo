# ADR-0044: Cluster members meet through a relay over TCP

**Status**: proposed. Answers the open point of [ADR-0043](0043-a-cluster-is-led-by-its-own-leader-not-kubernetes.md); keeps [ADR-0040](0040-a-server-agent-links-to-its-control-plane.md).

A cluster's leader and members accept no incoming connection, so they cannot dial each other. **Every party dials out over TLS on 443 to a cluster relay** and holds one connection; the relay forwards streams between parties of the same cluster. Each stream carries mutual TLS end to end, pinned to the peer's fingerprint, so the relay sees only ciphertext. A party needs a client certificate from the instance's agent CA before the relay registers it.

The relay is the cluster leader's binary in relay mode. Deplo's machine always runs one, outside the Next.js process, behind the 443 door Traefik already forwards. A remote leader's server runs a second one behind its own 443 when it answers there, so failover outlives Deplo's machine.

## Considered options

- **A WireGuard mesh with hole punching, relay as fallback**: what the research recommended (direct for about 70% of pairs). Rejected as too much to build and own: NAT traversal, path upgrades, and a reachable UDP socket that needed the "no incoming connection" rule reread. A direct path may be added later behind the same streams, only if worth it.
- **The control plane as the relay**: rejected. It stops whenever Next.js stops.
- **Docker overlay networks, peer relays on a member**: rejected. Both need an open port.

## Consequences

- Every byte between members takes two internet legs. Placement keeps an App next to its database when it can, and a database reached through the relay says so.
- With Deplo's machine down, a cluster whose leader also runs there cannot fail over.
