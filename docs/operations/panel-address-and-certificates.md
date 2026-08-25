# The panel's own address

## What it is

Where the dashboard itself answers, and the certificate it uses. Moving it is a
real operation with real consequences, which is why it has its own page.

**Settings -> Deplo**, instance admins only.

## How it works

The panel is routed by the host's Traefik like anything else, but through a
**file provider** entry rather than container labels. That is deliberate: a
panel published by labels could never change its own route, because changing it
would need the panel.

The address is also used for more than serving pages:

- It is baked into the **install command** printed for new servers.
- It is where **git provider webhooks** deliver.
- It is the **origin passkeys are bound to**.
- It sets the cookie `secure` flag.

## Change the address

1. Point the new hostname's DNS at this server first. The page shows the exact
   record.
2. Open **Settings -> Deplo**, find **Panel address**, click **Change address**.
3. Enter the new address. An impact check runs and tells you what it found: an
   IP address rather than a hostname, missing HTTPS, a DNS record that does not
   resolve here yet.
4. Use **Serve the panel over HTTPS** once the hostname resolves, so Traefik can
   get a certificate for it.
5. **Save**.

`http://<server-ip>:3000` keeps working throughout, and that is the point. It is
the way back in when a domain, a certificate or the proxy is what broke.

## The certificate account email

**Certificate account email** on the same page is the address Let's Encrypt has
on file for this instance's ACME account. It is where expiry warnings go.

## Limits and gotchas

- **Every passkey breaks when the address changes.** They are bound to a
  hostname by the standard. They show **Not usable here**, the password still
  signs people in, and everyone re-registers a passkey on the new address. Warn
  your team before you do this.
- **Webhooks must be re-pointed.** Deplo re-registers what it can, but a
  provider that cannot reach the new address stops delivering, and pushes stop
  deploying.
- **The install command changes.** Servers already enrolled are unaffected; new
  ones use the new address.
- **Do not use an IP for the panel address** unless you accept no certificate.
  Let's Encrypt does not issue for bare IPs.
- **`DEPLO_PUBLIC_URL` in `/opt/deplo/.env` is the other half.** If you edit the
  environment by hand, keep them consistent.

## If it does not work

- **The new address shows a certificate warning** - DNS was not resolving here
  when Traefik asked, or port 80 is closed.
- **The panel is unreachable at the new address** - go back in on
  `http://<server-ip>:3000` and change it back.
- **"No server accepted the change"** - the host running the panel could not
  apply the route. Check that server's health and its Traefik.

## See also

- [Instance administration](instance-administration.md)
- [Domains and HTTPS](../guides/domains-and-https.md)
- [Account security](../guides/account-security.md) - passkeys
- [Disaster recovery](disaster-recovery.md)
