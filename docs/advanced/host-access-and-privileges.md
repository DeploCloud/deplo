# Host access and privileges

## What it is

Everything that lets a container reach outside its own sandbox and touch the
server: bind mounts, kernel capabilities, devices, host namespaces, foreign
networks and foreign volumes.

All of it sits behind one grant, spelled **"Bind server folders"** in the
permission picker and `canMountHostVolumes` in the API.

## Why one grant covers all of it

A Compose file is user-written YAML that reaches the agent almost verbatim.
Gating only the obvious bind mount would leave a plain member one key away from
root on the machine, because these are all the same capability wearing different
clothes:

- `privileged: true` alone is enough to mount the host's disk and chroot into it.
- `pid: host` puts `nsenter -t 1` one command away.
- `devices:` hands over a raw disk.
- `cap_add`, `security_opt` and `userns_mode` remove the boundary a step at a
  time.
- A top-level `volumes:` entry with `external: true` attaches an **existing**
  volume by its host name. Deplo's volume names are deterministic, so this
  reached other teams' data and the control plane's own database.
- `driver_opts: {type: none, device: /, o: bind}` is a bind mount of the host,
  declared one level up from where a service-level check would look.

## What is gated

**Service keys**

`privileged`, `cap_add`, `devices`, `device_cgroup_rules`, `security_opt`,
`cgroup_parent`, `cgroup`, `pid`, `ipc`, `uts`, `network_mode`, `volumes_from`,
`env_file`, `oom_kill_disable`, `oom_score_adj`, `group_add`, `logging`,
`userns_mode`.

**Mounts**

A service mount whose source starts with `/` or climbs with `..`.

**Top-level blocks**

A `volumes:` entry that is `external: true`, pins a `name:`, or uses
`driver_opts` to bind a path. A `networks:` entry that joins a network belonging
to something else.

**Builds**

A `build:` whose context or Dockerfile is an absolute or `..` path, that loads
host SSH keys or agents, or that runs privileged.

**Merges**

`extends:` and `label_file:`, because they pull in keys from a file you did not
show, and those keys can be any of the above.

## What is never gated

**Hardening is free.** `no-new-privileges`, `cap_drop` and `read_only` are not
on any list and never ask for a permission.

That is deliberate: a permission prompt in front of the _safer_ choice is one
people learn to route around, and then they route around the one that mattered.

## Publishing a port is a separate grant

`canExposePorts` covers publishing a container port on the host, which is what a
`ports:` entry does and what a database's **Host port** does.

It is separate because it is a different risk: a published port is reachable
from the network, but it does not give the container the machine.

## How to grant it

Both grants are on the member, alongside their role: **Settings -> Members ->
the member -> Permissions**.

Grant them to somebody who administers the servers. Not to everybody who deploys
apps, and never as a shortcut to make one Compose file save.

## What to do when you hit the wall

Nine times out of ten there is a supported answer that does not need the grant:

| You wanted                                   | Do this instead                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| A bind mount for uploads                     | A **Volume**. Deplo creates and keeps it                                   |
| A bind mount for a config file               | A **File**, edited in the browser                                          |
| `network_mode: host` for performance         | A domain through Traefik                                                   |
| A published port so another app can reach it | Nothing. Apps on one server reach each other by name on the shared network |
| `privileged` because the README said so      | Check whether it is needed. Many images copy it from an older example      |

## Limits and gotchas

- **A key that is present but empty declares nothing.** `cap_add: []` and
  `privileged: false` do not trip the gate.
- **Deplo's own render-time entries never trip it.** The check reads what you
  authored, not the finished file.
- **An import can hit this too.** Items needing a grant you do not hold land in
  the migration report rather than being created.
- **This is a real trust boundary, not a formality.** Somebody with this grant
  can read every other team's data on that machine.

## See also

- [Compose apps](compose-apps.md)
- [Persistent storage](../guides/persistent-storage.md)
- [Roles and permissions](../guides/roles-and-permissions.md)
- [Capabilities](../reference/capabilities.md)
