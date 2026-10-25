# ADR-0039: The screenshot browser has no network

**Status**: accepted

After a deployment turns Ready, Deplo takes a light and a dark picture of it and shows it on the app's page. The page's JavaScript is untrusted - any member who can deploy writes it - and a browser that renders it from inside the platform would reach whatever the platform reaches: the panel's database network, the server's own ports, a cloud's metadata address. A picture of an iframe pointed at one of those is a leak anyone with `view` on the app can read.

**The browser runs on the app's own server agent, in a container with `--network none`.** The agent runs its own binary inside a pinned `headless-shell` image (`deplo-agent capture`), with every capability dropped, a read-only root, a memory cap and an OOM score that loses to every app. Its only way out is a unix socket the agent serves on the host: an HTTP proxy that resolves each name once, refuses any address that is not public or that belongs to the server itself, and dials the address it vetted. With no route out of the container there is no side door to close - not QUIC, not WebRTC, not a renderer exploit opening sockets of its own.

**The deployment's own host never goes through DNS.** It is dialed at this server's proxy, on the ports `deplo-traefik` publishes, so a domain whose DNS is not pointed yet, a server that cannot reach its own public address, and a loopback-only takeover install all still work - and a team cannot point its domain at an internal address to aim the browser there. Another host that resolves to one of the server's own addresses on 80 or 443 reaches that same proxy, the way any visitor reaches it; every other port on the server stays refused.

**Credentials go to the app's own login and nowhere else.** A basic-auth credential is handed to the browser on stdin and answered only to a challenge from the deployment's host. A pull request preview from a fork is never photographed behind basic auth: its code is a stranger's, and the proxy passes the credential through to it.

**Not captured is not shown.** Only a page that answered 2xx and did not come out as one flat colour is stored; anything else leaves the page as it was. Cookie banners are rejected with the vendored `@duckduckgo/autoconsent` (MPL-2.0), known consent tools only, no guessing.

The control plane's own outbound rule (`lib/outbound-url.ts`) is untouched: nothing here dials from the panel.
