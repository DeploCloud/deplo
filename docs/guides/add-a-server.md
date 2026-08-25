# Add a server

## What it is

Bringing another machine into the fleet so you can deploy to it. One command,
pasted on that machine. Deplo never connects to it.

## How it works

The control plane prints a command containing a **one-time bootstrap token**.
On the server, that command:

1. Installs Docker if it is missing, and sets Docker's address pools so the host
   does not run out of networks at about 31 apps.
2. Downloads the agent binary for that architecture and **verifies its
   SHA-256**. A mismatch refuses to run rather than warning.
3. Installs it as a systemd unit listening on `9443`, with its credentials in a
   `0600` environment file rather than on the command line, where any user could
   read them from `/proc`.
4. Installs Traefik on that host, unless one is already running or ports 80 and
   443 are taken.
5. Starts the agent, which generates its own key, sends a certificate signing
   request and **calls home** with the token.

The control plane signs the certificate and pins its fingerprint. The server
flips to online, and from then on everything is mutual TLS on port 9443.

## Add one

You need to be an instance admin.

1. Open **Settings -> Servers**.
2. Click **Connect a remote server**.
3. Fill in **Host or IP**: the address **this control plane** will dial. It must
   be reachable from here on the agent port.
4. Choose **What this server is for**:
   - **Everything** for a normal deploy target
   - **Build only** to compile for other hosts. Beta
   - **Backups only** for a storage box that runs nothing. Beta
5. Click **Add**. Deplo prints the command.
6. Paste it on the server, as root:

   ```bash
   curl -fsSL https://deplo.example.com/install-agent.sh | sudo bash -s -- <TOKEN> <URL> [FINGERPRINT]
   ```

7. Watch the card. It goes from **provisioning** to **online** on its own.

The token is single-use and expires in about an hour. If enrollment fails, the
server's menu can issue a fresh one.

## Open the right ports

| Port        | Direction               | Why                                         |
| ----------- | ----------------------- | ------------------------------------------- |
| `9443`      | Control plane to server | The agent. **Nothing works without it**     |
| `80`, `443` | Internet to server      | Traefik, and the HTTP certificate challenge |

**A green card does not prove Deplo can dial it.** The agent calls home
outbound, over 443, and that is what turns the card green. If port 9443 is
firewalled inbound, the server looks online and every deploy fails. The
installer opens no firewall.

## Check it before you trust it

The server's menu has **Check readiness**. It dials once and reports rows
grouped as agent, docker, routing, capacity, build methods and Deplo
configuration, each `pass`, `info`, `warn`, `fail` or `skip`.

`skip` means it could not be evaluated, which is deliberately different from
`pass`. Nothing gates on this report: it is for you.

## Let teams use it

New servers are usable by every team by default. To narrow that: **Settings ->
Servers -> the server -> Access**, pick the teams, then **Save access**.

## Limits and gotchas

- **Only `linux/amd64` and `linux/arm64`.** Nothing else is published.
- **An app and its database must be on the same server to reach each other by
  name.** The shared `deplo` network is per host.
- **A build server needs the same CPU architecture** as the machine that will
  run the image. Mismatched pairs are shown but disabled.
- **The address is what the control plane dials.** A private IP works only if
  this instance can route to it.
- **If containers are already running when the address pools change**, the
  installer skips the Docker restart and tells you to do it in a maintenance
  window.

## If it does not work

- **Stuck on provisioning** - the agent never called home. On the server, check
  `systemctl status deplo-agent` and `journalctl -u deplo-agent -f`.
- **Online, but every deploy fails** - inbound `9443` is blocked.
- **`Refusing to run an unverified binary`** - the download did not match its
  checksum. Retry; if it persists, something is intercepting the download.
- **The token is expired** - issue a new one from the server's menu.
- More in [Servers and agents](../troubleshooting/servers-and-agents.md).

## See also

- [Server settings](server-settings.md) - cleanup, maintenance, concurrency
- [Server roles](../advanced/server-roles.md)
- [Servers and the agent](../concepts/servers-and-the-agent.md)
- [Ports, networks and files](../reference/ports-networks-and-files.md)
