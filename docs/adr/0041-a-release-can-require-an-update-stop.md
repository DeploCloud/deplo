# ADR-0041: A release can require an update stop

**Status**: accepted. **Amends [ADR-0040](0040-a-server-agent-links-to-its-control-plane.md)**: it replaces the trigger for deleting direct dialing.

ADR-0040 deleted direct dialing "when `agentMin` passes the first release that links". That ties a fact about each instance to a fact about a release. Deplo is self-hosted. Every instance updates when its admin clicks Update or runs `deplo update`, and both jump straight to the newest release. In late October 2026, the 41 instances reporting usage ran stable panels 0.3.0 and 0.4.0 and a few 0.5.0 canaries. Every server agent they reported was a **pre-link agent** (`CONTEXT.md`), some as old as 0.1.0. A release without direct dialing would reach none of those servers. A pre-link agent can only be updated, or handed the panel's address, over a dial, and [ADR-0037](0037-a-panel-pins-its-agent.md) promises that the way out of an unusable server is never blocked.

**A release can name an update stop.** An **update stop** (`CONTEXT.md`) is an earlier release that an instance must have installed, and whose conditions it must meet, before it updates past it. A stop is enforced twice:

- **By the install script.** Every update runs the newest copy of `install.sh`: the target tag's for the Update button, `main`'s for `deplo update`. An instance below a stop is routed to the stop instead of the newer release, even if its own code has never heard of stops.
- **By the requiring release.** It refuses to start, before running any migration, on an instance that has not passed the stop. The installer then rolls back to the previous image with the database untouched. This catches `deplo update --version` and a hand-run image pull.

A fresh install has passed every stop. A stop is a stable release before any stable release requires it.

**Direct dialing stays, but only to bring a server onto its link.** The control plane records each server's first link and never dials a recorded server again. Until then, it dials only to bring the server over: Hello, updating its server agent, renewing its certificate, handing it the panel's address and telling it to stop listening. Every other call needs the link. A server that answers its dial but never links shows **warning**, and its message says it can't reach Deplo. ADR-0040 already leaves unsupported a panel that its servers cannot reach.

**The first stop is the release that moves `agentMin` to the first linking agent.** Its condition is that every enrolled server has linked once, or that an instance admin has left it behind by name. Before leaving one behind, the admin is told the server will need its server agent reinstalled. The Updates tab shows the next stop, the servers it waits on, and why a refused update rolled back. The release after it requires that stop, and deletes direct dialing on both sides.

## Considered options

- **Delete direct dialing once `agentMin` passes the first linking release** (ADR-0040): rejected. `agentMin` describes a release, and an instance can jump past it carrying pre-link agents.
- **Keep direct dialing for good**: rejected. It keeps two transports, and no compatibility path could ever be retired.
- **Release notes only ("update to X first")**: rejected. An admin who misses the note loses every server.
- **Only removing a dead server clears the stop**: rejected. Removing it and adding it again is a shell step too, and it loses the server's history.

## Consequences

Every later compatibility path retires the same way: first a stop that moves every instance past it, then the release that drops it.
