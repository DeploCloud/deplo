# ADR-0042: The panel can be served through a Cloudflare Tunnel

**Status**: accepted. Builds on [ADR-0040](0040-a-server-agent-links-to-its-control-plane.md).

ADR-0040 took the incoming connection off every server except one: the machine running Deplo still has to accept the panel's own traffic, and its servers' agent links, on 443. Behind a home or office router or a carrier-shared address that port cannot be opened, so such a machine could run apps for its LAN but never be a panel anyone reaches. A Cloudflare Tunnel turns that last incoming connection into an outgoing one: a connector on the machine dials Cloudflare, and Cloudflare carries the panel's address over it.

**Deplo sets the tunnel up, from an API token.** The admin gives an address and a token with Cloudflare Tunnel and DNS edit access. Deplo finds the address's zone, creates the tunnel, writes its routes, points the address at it with a proxied CNAME and runs the connector. Nothing about the tunnel is configured by hand in Cloudflare's dashboard. It is an expert setting under Advanced, never on the first-run path. The token is stored encrypted, is never returned, and is what Deplo later uses to read the tunnel's status, move it to another address and delete it.

**The connector reaches the panel directly, not through its proxy.** It runs as `deplo-tunnel` in the proxy's stack, on the platform network only (the panel and its proxy, no tenant, [ADR-0028](0028-an-environment-owns-a-network.md)). Its routes send the link door to the link listener and everything else to the panel, which is what Traefik does for the panel's own names. Going through the proxy would make every visitor arrive from the connector's address, so per-address rate limits would count everyone as one caller. Directly, the last `x-forwarded-for` hop is the one Cloudflare appended.

**The panel's own route stays, without a certificate resolver.** It keeps answering on the tunnel's name, but Let's Encrypt can only reach that name through Cloudflare, so ordering a certificate for it would only fail its challenge. The backup address is unchanged. While the tunnel is on, the panel's address and its HTTPS switch belong to it and refuse a direct change. Turning it off moves the panel to its backup address, or one the admin names, and is undone like any address move if that address does not answer. A failed setup undoes every step it took, in Cloudflare too, and it never deletes a DNS record that does not already point at this machine.

**An update keeps it.** The installer re-renders the proxy stack on every update, so it carries the connector over as it finds it while the panel stays on the tunnel's name. A `deplo recover panel-address` onto any other address turns it off as the panel starts, and deletes it in Cloudflare while the saved token still works, because recovery means getting off an address that stopped working.

## Considered options

- **A tunnel token pasted from Cloudflare's dashboard**: rejected. The admin would have to configure both routes by hand, and a missing link route breaks every other server without any visible error.
- **The connector in front of the proxy**: rejected, for the visitor address above.
- **Quick tunnels with no Cloudflare account**: rejected. Their address changes on every restart, and a server that is off at that moment cannot find the panel again (ADR-0040).
- **The connector as a server-agent feature**: rejected. The proxy stack is already the control plane's to render and the agent applies it verbatim, so no agent release is needed.
