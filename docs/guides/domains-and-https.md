# Domains and HTTPS

## What it is

Everything about the addresses an app answers on: your own hostnames,
certificates, path-based routing, redirects and the entry point traffic arrives
on.

If you just want one domain with HTTPS, [Add a domain](../getting-started/add-a-domain.md)
is the short version. This page is the rest.

## How it works

A domain is **one row keyed on hostname plus path**, and that row is the only
thing the routing renderer reads. On every deploy Deplo turns each row into a
Traefik router carrying:

- the rule, `Host(...)` and optionally a path prefix
- the entry point, `web` for plain HTTP or `websecure` for HTTPS
- the certificate resolver, when a certificate is asked for
- the middleware chain, including basic auth if the app has it
- the target: the container and the port

**A path router is always given priority above a whole-host router**, longest
prefix first. That is what makes `example.com/api` on one app and `example.com/`
on another work at the same time.

Deplo also checks DNS itself, on a schedule and on demand, and only routes a
hostname whose check came back usable.

## Add and manage domains

Open the app, then **Domains**.

| Action                      | Where                                             |
| --------------------------- | ------------------------------------------------- |
| Add a hostname              | **Add Domain**, then **Add domain** in the dialog |
| Get a free hostname         | **Generate** inside that dialog                   |
| Make one the production URL | The row menu, **Set as primary**                  |
| Re-check DNS now            | The row menu                                      |
| Change routing or TLS       | The row menu, then **Save changes**               |
| Delete                      | The row menu, **Remove domain**                   |

Exactly one domain is primary. It is the URL in the app header, in
notifications, and anywhere Deplo needs to name the app's address.

## DNS states

| State           | What it means                                                                                                    | Routed |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ------ |
| `valid`         | The hostname resolves to this app's server                                                                       | yes    |
| `cloudflare`    | Proxied through Cloudflare, so the real origin cannot be seen from here. The row gets a **Cloudflare DNS** badge | yes    |
| `pending`       | No record found yet. The row shows the exact A record to create                                                  | no     |
| `misconfigured` | It resolves, but to a different address. Same hint, with the address it should point at                          | no     |
| `error`         | The lookup itself failed                                                                                         | no     |

`cloudflare` means proxied and therefore unverifiable, not confirmed. It is
routed anyway, because a correct orange-cloud setup could never be verified from
the server side.

## Certificates

One field, **Certificate**, under **Advanced settings -> HTTPS**. Picking a
provider is how a domain opts into HTTPS; there is no separate switch.

| Option                      | Use it when                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **None (no certificate)**   | Plain HTTP on the `web` entry point. **This is the default for a new domain**                                                   |
| **Let's Encrypt**           | You own the domain and it resolves here. Traefik validates over HTTP on port 80 and renews automatically                        |
| **Cloudflare**              | The domain is proxied by Cloudflare. Selected for you when the DNS check detects it                                             |
| **Installed on the server** | You added the certificate yourself under **Settings -> Servers**. See [Custom certificates](../advanced/custom-certificates.md) |

**Entrypoint** is derived from that choice and is best left on **Automatic**.
Set it by hand only when you know you need `web` or `websecure` specifically.

> **Cloudflare's Flexible mode is a trap.** It talks HTTPS to the browser and
> plain HTTP to your server, so the padlock is real and the connection behind it
> is not. Use Full or Full (strict) with a certificate on this side.

## Path routing

**Advanced settings -> Request routing**.

| Field                            | What it does                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| **Internal path (optional)**     | Only requests under this path reach this app. Blank routes the whole host                    |
| **Strip path before forwarding** | Removes the prefix before the request reaches your container                                 |
| **Middlewares (optional)**       | Comma-separated Traefik middlewares, applied in order. Each must already exist on that proxy |
| **Container**                    | Which Compose service to route to. Only shown for multi-container apps                       |
| **Container port**               | Overrides the app's port for this hostname. Single-container apps only                       |

A worked example. Two apps, one domain:

```
example.com/api   ->  the API app,   Internal path /api,  Strip path ON
example.com/      ->  the web app,   no internal path
```

Traefik matches `/api` first because path routers outrank whole-host ones, and
the API container receives `/users` rather than `/api/users` because stripping
is on.

## Redirects

The **Redirect** field pairs one hostname with another so that `www.example.com`
answers a permanent redirect to `example.com`, or the other way round. The
redirecting half is a real domain row with its own DNS check and its own
certificate, which it needs, because a browser must complete TLS before it can
be told to go somewhere else.

The primary flag follows whichever half actually serves.

## Limits and gotchas

- **A `nip.io` hostname can never hold a certificate.** One registered domain,
  one issuance budget, shared with the internet.
- **50 Let's Encrypt domains per team.** Every team shares one ACME account on
  this instance. Domains with no certificate do not count.
- **Port 80 must be open even for an HTTPS-only site.** That is where the
  certificate challenge happens.
- **A hostname belongs to one team.** Another team cannot add it, and the same
  applies to a preview base domain, compared across the whole zone.
- **The same hostname on two paths may belong to two apps in your team.** That
  is deliberate.
- **Two hostnames with different middleware chains cannot share a router.** They
  become two routers, which is fine and invisible.
- **Changing a domain applies on the next deploy or a Reload.** Use **Reload**
  on the app to re-apply routing without rebuilding.

## If it does not work

- **Stuck on pending** - no A record yet. The row prints the exact record.
- **misconfigured** - it resolves somewhere else. Old record, or a proxy in
  front you forgot about.
- **Certificate warning in the browser** - the certificate never issued.
  Port 80 closed, or DNS pointing elsewhere at issuance time.
- **404 from Traefik** - nothing matches the rule: the app is stopped, or the
  domain belongs to an app on a different server than the one you are hitting.
- **A redirect loop** - Cloudflare Flexible mode plus an HTTPS redirect on this
  side. Switch Cloudflare to Full.
- More in [Domains and TLS](../troubleshooting/domains-and-tls.md).

## See also

- [Add a domain](../getting-started/add-a-domain.md)
- [Custom certificates](../advanced/custom-certificates.md)
- [Pull request previews](pull-request-previews.md) - a hostname per pull request
- [Console and files](console-and-files.md) - and basic auth, under **Settings -> Access**
