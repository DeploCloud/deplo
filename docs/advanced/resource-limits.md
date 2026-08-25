# Resource limits

## What it is

Caps on what one app or database may take from its server: memory, CPU,
processes, open files, disk. Without them, one runaway container can take a host
down and everything else with it.

**Settings -> Resources**, on an app or a database.

## How it works

Each field becomes a key in the rendered Compose file, applied by Docker when
the container starts. They are enforced by the kernel, not by Deplo, which is
why they take effect on the next deploy and not before.

Every dimension is independently optional. Setting a memory limit does not
oblige you to set anything else.

## The two that matter

| Field            | What it does                                                   |
| ---------------- | -------------------------------------------------------------- |
| **Memory limit** | The hard ceiling. The container is killed when it exceeds this |
| **CPU limit**    | The share of CPU it may use, as a fraction of one core         |

**Quick size** presets both together for the common cases, which is what most
people should use. **Clear all** removes every limit.

**A memory limit is a kill switch, not a throttle.** A process that goes past it
is terminated, not slowed down. Set it above the app's real peak, not at it, and
watch [Monitoring](../guides/monitoring.md) for a while before tightening.

## Advanced limits

| Field                  | What it does                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| **Memory reservation** | A soft floor. The scheduler tries to leave this much available                            |
| **Swap limit**         | Memory plus swap combined                                                                 |
| **CPU shares**         | Relative weight against other containers under contention                                 |
| **CPU pinning**        | Which cores it may run on                                                                 |
| **Process limit**      | Maximum processes and threads. The defence against a fork bomb                            |
| **Open files**         | The file descriptor ceiling                                                               |
| **User processes**     | The per-user process ceiling                                                              |
| **Shared memory**      | The size of `/dev/shm`. Postgres, Chrome and some test runners need more than the default |
| **Disk quota**         | A cap on the container's writable layer                                                   |
| **OOM priority**       | How likely this container is to be killed first when the **host** runs out of memory      |

## Limits and gotchas

- **Disk quota only works on some hosts.** It needs `overlay2` on XFS with
  project quotas, or devicemapper. Anywhere else, Compose rejects the key and
  the deploy fails. Leave it alone unless you know the storage driver.
- **MySQL and MariaDB will not start under about 512 MB.** The interface warns
  you about exactly this on a database.
- **Limits apply on the next deploy.** Save, then redeploy.
- **A container killed for memory looks like a crash.** The logs end mid-work
  with no error, and the app restarts. If a container dies at the same size
  every time, this is why.
- **CPU limit and CPU shares are different things.** A limit is a ceiling that
  applies always. Shares only matter when the machine is contended.

## If it does not work

- **The container is killed repeatedly** - the memory limit is under its real
  peak. Raise it, or fix the leak.
- **The deploy fails on the storage option** - the host does not support disk
  quotas. Clear that field.
- **The limits seem to do nothing** - they were saved but not deployed.

## See also

- [Monitoring](../guides/monitoring.md) - what the app actually uses
- [Server settings](../guides/server-settings.md) - deploy concurrency, the other resource control
- [Databases](../guides/databases.md)
