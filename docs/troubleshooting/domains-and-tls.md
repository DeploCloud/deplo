# Domains and TLS

## Waiting for DNS, or misconfigured

| State           | Means                           | Fix                                                       |
| --------------- | ------------------------------- | --------------------------------------------------------- |
| `pending`       | No record found at all          | Create the A record the row prints                        |
| `misconfigured` | It resolves, but somewhere else | Point it at this app's server. The row prints the address |

Check it yourself:

```bash
dig +short app.example.com
```

If that prints nothing, it is DNS propagation or a typo in the record. If it
prints an address that is not the server's, the record points elsewhere: an old
host, a proxy, or a wildcard record you forgot about.

**The server matters.** An app running on server B needs its domain pointing at
**B**, not at the machine the panel runs on.

## Certificate warning in the browser

Almost always one of four things.

1. **Port 80 is closed.** Let's Encrypt validates over HTTP, even for a site you
   only serve on 443. Open it.
2. **DNS was not resolving here when Traefik asked.** Fix the record, then force
   a retry: **Reload** the app, or redeploy.
3. **The domain is on `nip.io`.** A `nip.io` hostname can **never** hold a
   certificate: one registered domain, one issuance budget, shared with the
   internet. Use a domain you own.
4. **The certificate provider is None.** New domains are created with no
   certificate. Set **Certificate** to **Let's Encrypt** under **Advanced
   settings -> HTTPS**.

Two rarer causes:

- **The team hit the 50 Let's Encrypt domain cap.** Every team on this instance
  shares one ACME account. Remove a certificate-backed domain, or add this one
  with no certificate.
- **The default resolver uses DNS-01.** A `nip.io` name needs HTTP-01. Point
  `DEPLO_CERT_RESOLVER` at an HTTP-01 resolver.

## A custom certificate is not being served

- **It never loaded.** Usually a missing intermediate in the chain, or a key
  that does not match the certificate. Traefik falls back to its own default.
- **It is on the wrong server.** Certificates are per host. An app on two
  machines needs it on both.
- **The domain is set to None.** A domain with no certificate is on plain HTTP
  and will never pick one up.
- **It expired.** Nothing renews a custom certificate. The certificates page
  warns for the last three weeks.

## 404 from the proxy

The request reached Traefik and no router matched.

| Check                                    | Why                                                        |
| ---------------------------------------- | ---------------------------------------------------------- |
| Is the app running?                      | A stopped app has no container to route to                 |
| Is the domain on the app you think?      | One hostname, one app, per path                            |
| Is the DNS state routable?               | Only `valid` and `cloudflare` are routed                   |
| Is it the right server?                  | The domain resolves to whichever machine you pointed it at |
| For a Compose app, is **Container** set? | The router needs to know which service                     |

## A redirect loop

Cloudflare in **Flexible** mode plus an HTTPS redirect on this side. Flexible
talks HTTPS to the browser and plain HTTP to your server, so your side redirects
to HTTPS, Cloudflare requests HTTP again, forever.

Switch Cloudflare to **Full** or **Full (strict)** and give the domain a real
certificate here.

## Two apps on one hostname

Supported and deliberate: `example.com/` and `example.com/api` are two rows and
may point at two apps. A path router always outranks a whole-host one, longest
prefix first.

If the wrong one answers, check the **Internal path** on both rows, and whether
**Strip path before forwarding** is set the way the receiving app expects.

## A hostname is refused

**One hostname belongs to one team.** If another team on this instance already
holds it, you cannot add it. The same applies to a preview base domain, compared
across the whole DNS zone in both directions.

## The panel itself is unreachable

`http://<server-ip>:3000` always answers, domain or not. Go in that way and fix
the address in **Settings -> Deplo**.

If even `:3000` is silent, the control plane container is down. On the host:

```bash
docker ps
docker logs deplo
```

## See also

- [Domains and HTTPS](../guides/domains-and-https.md)
- [Custom certificates](../advanced/custom-certificates.md)
- [The panel's own address](../operations/panel-address-and-certificates.md)
