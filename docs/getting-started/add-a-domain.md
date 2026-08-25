# Add a domain

## What it is

Putting a hostname you own in front of an app, and serving it over HTTPS with a
certificate Deplo gets for you.

## How it works

A domain in Deplo is one row keyed on **hostname plus path**, and it is the only
thing the routing renderer reads. Adding one gives Traefik on that server a
router whose rule is `Host(...)`, pointing at your container.

The certificate is a separate choice on the same row. **A brand new domain is
created with no certificate**, on plain HTTP, and you opt into TLS by picking a
provider. Nothing is ever registered with Let's Encrypt behind your back.

Deplo checks the DNS itself, on a schedule and on demand. A hostname is only
routed once that check returns `valid`, or returns `cloudflare` for a name
proxied through Cloudflare.

## Point the domain at the server

1. Find the server's public IP. It is on the server card in
   **Settings -> Servers**, and it is also the hexadecimal part of the app's
   generated `nip.io` URL.
2. At your DNS provider, create an **A record** for the hostname, pointing at
   that IP. For `app.example.com` on `203.0.113.10`:

   ```
   Type   Name   Value          TTL
   A      app    203.0.113.10   auto
   ```

3. Give it a minute. DNS caches, and Deplo will keep checking.

## Add it in Deplo

1. Open the app and go to **Domains**.
2. Click **Add Domain**.
3. Type the hostname, for example `app.example.com`.
4. Open **Advanced settings**, then the **HTTPS** group, and set
   **Certificate** to **Let's Encrypt**.
5. Click **Add domain**.
6. The row shows **Waiting for DNS** until the record resolves to this server.
   It becomes routable on its own once it does.
7. Open the row's menu and choose **Set as primary**. The primary hostname is
   the one shown in the app header and used as the production URL.

The certificate is requested by Traefik the first time somebody loads the site
over HTTPS. It takes a few seconds and renews itself from then on.

## No domain yet?

The **Add Domain** dialog has a **Generate** button that mints another free
`nip.io` hostname on the spot. Useful for a second entry point, a staging name,
or just a shorter URL than the generated one. It cannot hold a certificate, so
it stays on plain HTTP.

## Limits and gotchas

- **A `nip.io` hostname can never get a certificate.** It is one registered
  domain shared with the whole internet, and its issuance budget is shared with
  it. Use a domain you own for HTTPS.
- **Behind Cloudflare's orange cloud, pick Cloudflare.** Deplo detects a proxied
  domain and selects it for you. The DNS check then reads `cloudflare`, which
  means proxied and therefore unverifiable from here, not confirmed. It is
  routed anyway, because a correct orange-cloud setup could never verify.
- **Let's Encrypt validates over HTTP.** Port 80 must be reachable from the
  internet even for a site you only intend to serve on 443.
- **50 Let's Encrypt domains per team.** Every team on this instance shares one
  ACME account, so the cap stops one team from exhausting the budget for
  everyone. Domains with no certificate do not count.
- **One hostname belongs to one team.** Another team cannot claim
  `app.example.com` once you have it, and the same is true of a preview base
  domain.
- **The same hostname can serve two apps on different paths.** `example.com/`
  and `example.com/api` are two rows and may point at two different apps. That
  is a feature, and a path router always wins over a whole-host one.

## If it does not work

- **Stuck on Waiting for DNS** - the record has not propagated, or it points at
  a different machine. Check with `dig +short app.example.com`.
- **The browser shows a certificate warning** - the certificate has not issued.
  Almost always port 80 is closed, or the domain resolves elsewhere.
- **404 from Traefik** - the domain resolves and the certificate is fine, but
  no router matches. Usually the app is stopped, or the domain sits on an app
  running on a different server.
- More in [Domains and TLS](../troubleshooting/domains-and-tls.md).

## See also

- [Domains and HTTPS](../guides/domains-and-https.md) - path routing, redirects, entrypoints, every field
- [Custom certificates](../advanced/custom-certificates.md) - wildcards and certificates you already hold
- [Pull request previews](../guides/pull-request-previews.md) - a hostname per pull request
