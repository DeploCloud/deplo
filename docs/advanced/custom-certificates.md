# Custom certificates

## What it is

Installing a TLS certificate you already hold, instead of letting Let's Encrypt
issue one. For wildcards, a company certificate authority, or a hostname no HTTP
challenge can reach.

**Settings -> Servers -> a server -> Certificates.** Instance admins only.

## How it works

The certificate is installed into that host's Traefik store and **nowhere else**.
Deplo keeps no copy: the list you see is read back off the host, and the private
key has no read path anywhere in the product.

A domain reaches it by setting its **Certificate** to **Installed on the
server**. That renders a router with TLS on and **no ACME resolver named**,
because naming one would make Traefik try to issue a certificate for a hostname
whose whole point is that it already has one.

A domain set to **Let's Encrypt** also picks it up, since Traefik will not issue
for a name its store already covers. A domain set to **None (no certificate)**
never does: it is on plain HTTP by definition.

## Install one

1. Open **Settings -> Servers**, choose the server, then **Certificates**.
2. Add the certificate and its private key, both PEM.
3. Set the app's domain **Certificate** to **Installed on the server**.
4. Redeploy the app, or use **Reload** to re-apply routing.

**Refresh** re-reads the store from the host. **Remove** deletes it there.

## Limits and gotchas

- **Nothing renews it.** This is the big one. The page warns during the last
  three weeks, and after that visitors get an expiry error. Put the renewal in
  your own calendar.
- **It is per server.** An app running on two machines needs it on both.
- **Deplo cannot show you the key back.** Keep your own copy.
- **A wildcard is the usual reason to be here.** Let's Encrypt can issue
  wildcards, but only over a DNS challenge, which needs provider credentials in
  Traefik's static configuration. Installing the certificate yourself avoids
  that entirely.

## If it does not work

- **The browser still sees a Let's Encrypt certificate** - the domain is set to
  **Let's Encrypt** and Traefik already had one. Traefik prefers the more
  specific match; check the hostname really is covered by yours.
- **Traefik serves its own default certificate** - the pair did not load. It is
  usually a missing intermediate in the chain, or a key that does not match the
  certificate.
- **It works on one app and not another** - the other app runs on a different
  server.

## See also

- [Domains and HTTPS](../guides/domains-and-https.md)
- [Server settings](../guides/server-settings.md)
- [Domains and TLS troubleshooting](../troubleshooting/domains-and-tls.md)
