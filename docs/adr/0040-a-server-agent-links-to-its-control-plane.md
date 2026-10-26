# ADR-0040: A server agent links to its control plane

**Status**: accepted. **Amends [ADR-0006](0006-server-agent-is-a-per-host-go-binary.md)**, decisions 4 and 8.

The control plane used to dial every server agent on TCP 9443. That meant every server had to accept an incoming connection, and Deplo told its users to open a firewall port. The core mission forbids requiring that knowledge, and behind a home or office router or a carrier-shared address the port cannot be opened at all. Installing an agent already worked anywhere, because it calls home. Only the calls that came after needed a way in.

**The agent dials out and stays on the line.** After it calls home, every server agent keeps one **agent link** (`CONTEXT.md`) open to the control plane, the host running Deplo included. Every call the control plane makes to that server rides it, and no server agent listens on a port. The RPC contract, `connectAgent` and the pinned-fingerprint mTLS do not change. Only the transport under them moves.

**The link is a WebSocket on the panel's public HTTPS address, with the mTLS inside it.** Traefik forwards it like any other request to the panel. It passes the panel's own Traefik, a TLS-terminating proxy in front of it and a corporate HTTPS proxy, and it opens no port on the panel's host. Inside, the control plane and the agent run the same mutual TLS handshake as before. Trust never rests on the outer certificate, whether it is Let's Encrypt, a bare-IP panel's self-signed default or a proxy's, and a proxy sees only ciphertext.

**The handshake decides who is on the other end.** The public door only rate-limits per address and reads which server the agent claims to be. For a given server, the newest _verified_ link replaces an older one. Removing a server ([ADR-0011](0011-server-removal-is-trust-revocation-not-a-host-uninstall.md)) closes its link and refuses new ones. The host running Deplo links over loopback, never through its public address.

**The agent knows at most two addresses, and the control plane chooses both.** One is the primary: the address in the install command, until the control plane replaces it. The other is the panel's fallback address, for as long as the admin keeps it enabled. The agent reports both in its Hello. When they differ from the panel's, the control plane sends the current pair, and the agent keeps only that pair and forgets the rest. Disabling the fallback sends a pair without one. If a server is off while the address of a panel without a domain changes, it cannot find the panel again and has to be enrolled again. Giving the panel a domain avoids this.

**Status reads from the link.** A server with no link for longer than a grace window of about 10 seconds is **offline**. Every other status still comes from a live Hello over the link, and the Hello before a deploy stays. A call that finds no link waits up to the same 10 seconds for it to come back, then fails as offline. The agent reconnects with a jittered backoff from about 1 second up to 30, so a panel restart or an agent update does not fail calls at once.

**Existing servers move over by themselves, and direct dialing goes.** An agent that is new enough to link gets the panel's address over the direct connection. It opens its link, then stops listening once the control plane has seen the link, with no action from the user. Direct dialing stays only while agents too old to link exist. When `agentMin` ([ADR-0037](0037-a-panel-pins-its-agent.md)) passes the first release that links, direct dialing is deleted on both sides. Deplo does not support a panel that its servers cannot reach. Such a panel already loses push-to-deploy, because webhooks need to reach it.

**A server's address stays, for its apps only.** It still feeds app domains and DNS checks. It is set at install and can be edited under Advanced, but the agent port field goes away, and changing the address no longer dials it. Every "open TCP 9443" disappears from the product, and the link adds nothing to any screen.

## Considered options

- **Raw TLS through a Traefik TCP route on 443**: rejected. No TCP route exists today, and raw TLS gets through neither a TLS-terminating proxy nor an HTTP proxy.
- **A dedicated port on the panel's host**: rejected. It moves the firewall rule onto the panel instead of removing it.
- **Direct dialing kept as an expert option**: rejected. It would keep a second transport alive for a setup that already has no push-to-deploy.
- **A signed token at the door, checked before the handshake**: rejected. The mTLS handshake already refuses an impostor, and a token would be a second credential to mint, rotate and revoke.
- **The agent keeping every address it was ever given**: rejected. A list the agent prunes on its own is state that nobody can see. The control plane names the address.
