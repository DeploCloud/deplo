# Servers and agents

## A server is stuck on provisioning

`provisioning` means **no agent has ever called home**. On the machine:

```bash
systemctl status deplo-agent
journalctl -u deplo-agent -f
```

| What you see                           | Cause                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| The unit does not exist                | The install command never ran, or it failed early                                                                                          |
| `Refusing to run an unverified binary` | The download did not match its checksum. Retry; if it persists, something is intercepting it                                               |
| The unit runs but nothing happens      | It cannot reach the control plane's URL. Check outbound network and that the URL is right                                                  |
| `bootstrap token` errors               | The token was used already, or it expired. Issue a new one from the server's menu                                                          |
| `status=216/GROUP`                     | The unit wants the docker group and Docker is not installed. That is expected on a backups-only host, and its unit is installed without it |

## Online, but every deploy fails

**This is the classic one.** The agent calls home outbound over 443, and that is
what turns the card green. Deploying needs the control plane to dial **inbound**
on `9443`.

If 9443 is firewalled, the server looks perfectly healthy and nothing works.
**No installer opens a firewall.**

From the machine running the control plane:

```bash
nc -vz <server-ip> 9443
```

Open the port to the control plane's address and try again.

## warning, error, offline: what each means

| Value     | Means                                                                                                            | Where to look                           |
| --------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `warning` | The agent is up and trusted, Docker is not answering                                                             | `systemctl status docker` on the host   |
| `error`   | Something answered, but its agent is wrong: untrusted certificate, unsupported contract, or an application error | Re-run the install command to re-enroll |
| `offline` | Nothing answered, confirmed by a retry                                                                           | The machine, the network, or the port   |
| `Unknown` | The stored reading is stale                                                                                      | Click **Check status**                  |

**Health never gates a deploy.** A deploy takes a live handshake at that moment,
which is why a green card and a failing deploy are not a contradiction.

## Check readiness instead of guessing

The server's menu has **Check readiness**. It dials once and reports agent,
docker, routing (including a real bind test on 80 and 443), capacity, build
methods and Deplo configuration.

`fail` means a deploy to this server cannot succeed. `warn` means it succeeds
but the result is not fully usable. `skip` means it could not be evaluated,
which is deliberately not a pass.

## Metrics show dashes

The telemetry stream is not connected. Check the server's health first. History
lives in the control plane's memory, so it also starts empty after a restart of
the panel.

## The 32nd app fails to deploy

Docker's default address pools allow about 31 networks and Deplo uses one per
app. Both installers write a larger pool into `/etc/docker/daemon.json`, but
**if containers were running at install time the Docker restart was skipped**,
so the change never took effect.

Restart Docker in a maintenance window. The file is already correct.

## Deploys fail with `No chain DOCKER-FORWARD`

Docker's iptables chains were removed underneath it, usually by a firewall
starting after Docker. Restarting Docker recreates them.

## A container was removed but Deplo still shows it

Deplo keeps a teardown it could not confirm and retries it on a backoff ladder
from one minute to a day, eight times. Giving up writes an activity entry and
raises an alert, so an orphan is never silently left behind.

Removing the server drops its pending teardowns.

## Reinstalling an agent

Re-run the install command from the server's **Advanced** tab. The installer
**deletes the existing certificate files** so the host genuinely re-enrolls
against the new pin, rather than half-trusting the old one.

## The server is gone for good

Remove it in Deplo. That is trust revocation and does not need the machine to
answer. See
[Remove a server or uninstall](../operations/remove-a-server-or-uninstall.md).

## See also

- [Add a server](../guides/add-a-server.md)
- [Server settings](../guides/server-settings.md)
- [Servers and the agent](../concepts/servers-and-the-agent.md)
- [Ports, networks and files](../reference/ports-networks-and-files.md)
