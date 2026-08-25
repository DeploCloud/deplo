# Servers and the agent

## What it is

A **server** is a machine you own that Deplo can deploy to. It becomes one by
running a small Go program, the **server agent**, which is the only thing in the
entire system that runs Docker.

Servers are instance-wide, not team-owned. One server can serve several teams,
and one team can spread across several servers.

## How a server joins

The control plane never connects to your machine. Your machine connects to it.

1. In **Settings -> Servers** you click **Add server** and Deplo prints an
   install command containing a **one-time bootstrap token**.
2. You paste that command on the server. It downloads the agent binary,
   verifies its SHA-256 (a mismatch is a hard refusal, not a warning), installs
   it as a systemd unit and starts it.
3. The agent generates its own private key, sends a certificate signing request
   and calls home with the token.
4. The control plane is a private certificate authority, derived from
   `DEPLO_SECRET`. It signs the certificate and **pins the fingerprint**.
5. The server flips to online.

The token is single-use, stored only as a hash, and expires in about an hour.
Over HTTPS the agent also pins the control plane by certificate fingerprint;
over a bare-IP install with no TLS, the token authenticates the response
instead.

From then on the two talk over gRPC with mutual TLS on port **9443**.

## What a server can be for

The role is chosen when you install it, and it changes what gets set up.

| Role                 | Gets Docker        | Gets Traefik | Can run apps | Notes                                                                             |
| -------------------- | ------------------ | ------------ | ------------ | --------------------------------------------------------------------------------- |
| **Everything**       | yes                | yes          | yes          | The default                                                                       |
| **Build server**     | yes                | no           | no           | Compiles for other hosts. Never a deploy target. Beta                             |
| **Storage only**     | no                 | no           | no           | Holds backups and nothing else. Beta                                              |
| **Migration source** | must already exist | no           | no           | Created only by the migration wizard. The one server Deplo uninstalls itself from |

See [Server roles](../advanced/server-roles.md).

## Health is not readiness

Two different questions, two different answers, and it is worth keeping them
apart because the interface does.

**Health** answers "can we reach and trust this agent right now?". It is an
observation from the last handshake, stamped with when it was taken. Five
values:

| Value          | Means                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `provisioning` | No agent has called home yet. Never dialled, never demoted                                                       |
| `online`       | The handshake answered and Docker is reachable                                                                   |
| `warning`      | The agent is up and trusted, but Docker is not answering, so nothing can deploy there                            |
| `error`        | Something answered, but its agent is wrong: untrusted certificate, unsupported contract, or an application error |
| `offline`      | Nothing answered, confirmed by a retry                                                                           |

**The stored value is a cache, not a gate.** Past a staleness window the Servers
page shows **Unknown** rather than a confident stale green, and nothing in the
deploy path consults it. A deploy gates on a live handshake taken at that
moment.

**Readiness** answers a different question: "is this host's installation
complete enough to deploy apps to?". It is a live report, run from the server's
menu, never stored, and nothing gates on it either. Rows are grouped as agent,
docker, routing, capacity, build methods and Deplo configuration, and each row
is `pass`, `info`, `warn`, `fail` or `skip`. **`skip` means it could not be
evaluated**, which is deliberately different from a pass.

## The Deplo host is a server too

The machine running the control plane enrolls itself during installation and
appears in the list like any other. Deploying to it uses the same network path,
the same certificates and the same code as deploying to a machine on another
continent. There is no local shortcut, which is why the everyday path is also
the well-tested one.

The one thing it cannot do is remove itself from the fleet.

## Removing a server is trust revocation

Removing a server **clears the pinned certificate** so Deplo will never talk to
it again. It does not reach into the host and uninstall anything, because by
that point it may not be able to.

Deplo prints a one-line uninstall command for you to run on the machine if you
want the agent, its Traefik and its state directory gone. The only exception is
a migration source, which Deplo does uninstall itself from once you are done
with it.

## Two behaviours worth knowing

**Deploy concurrency.** Each server has a slot count, default `1`, so deploys to
one machine serialize. Other servers keep working in parallel, and two deploys
of the same app never overlap regardless.

**Pending teardowns.** If Deplo tells a host to destroy a stack and the host
does not confirm, the instruction is kept and retried on a backoff ladder from
one minute up to a day, eight times. Giving up writes an activity entry and
raises an alert, so an orphaned container is never silently left behind.

## See also

- [Add a server](../guides/add-a-server.md) - the procedure
- [Server settings](../guides/server-settings.md) - access, cleanup, maintenance
- [Server roles](../advanced/server-roles.md)
- [Servers and agents troubleshooting](../troubleshooting/servers-and-agents.md)
