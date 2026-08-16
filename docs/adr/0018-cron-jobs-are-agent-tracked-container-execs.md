# ADR-0018 - Cron jobs are agent-tracked container execs, polled by the control plane

**Status:** Accepted (2026-08-07). §8 and §9 added 2026-08-16, after the first
operator report: everything below was true and the feature still read as broken, because
one poll a minute is not the same thing as an outcome.

Extends the agent contract of [ADR-0006](./0006-server-agent-is-a-per-host-go-binary.md) with
three additive RPCs. Reuses the capability model of
[ADR-0016](./0016-a-node-capability-set-overrides-the-team-role-inside-that-node.md) and the
"a token's capabilities were chosen one by one" rule of
[ADR-0015](./0015-an-api-token-is-a-principal-with-its-own-capabilities.md).

## Context

deplo could not run anything on a recurring basis. The two ways a user had were to open the
Console and type the command by hand, or to bake a crontab into the image - that is, exactly
the "drop to a shell" the core mission exists to remove. Every platform deplo measures itself
against ships a cron manager in the dashboard, and so does every open-source competitor.

The obvious implementation was already in the tree and is wrong. `Exec` (the console's RPC)
runs `docker exec` synchronously with a **hard 30-second ceiling**
(`internal/server/exec.go`, the `30*time.Second` passed to `dockercli.Run`). That ceiling is correct
for what it serves - a REPL where a human typed a command and is waiting - and useless for a
cron job, where a Laravel `schedule:run`, a database cleanup or a sitemap rebuild routinely
runs for minutes. Raising it would give the console an unbounded deadline, which is the exact
thing the ceiling is there to prevent.

Three shapes were considered for the replacement.

## Decisions

### 1. A cron job is a new agent RPC triple, not a longer `Exec`

`StartJob` / `PollJob` / `KillJob`, behind the `cron` Hello capability. The agent spawns the
`docker exec` on a **job-scoped context** - never the RPC's - keeps it in an in-process map
next to `deploys`, and answers questions about it later. The control plane holds **no
connection** between the start and the terminal poll.

Rejected: a **long-deadline unary `RunJob`** (one changed line in Go, but it holds a gRPC
connection open for the job's entire duration and loses the result outright if the control
plane restarts mid-job), and a **server-streaming `RunJob`** modelled on `Backup` (nice for
live output, but the most fragile option for long jobs - a broken stream loses the exit code,
and it would need the reconnection machinery that today exists only for the metrics stream).

The consequence that sold it: **restarting Deplo does not kill a running cron job.** The
process lives in the agent, so the control plane comes back a minute later, polls, and
harvests the real exit code. That is not a nice-to-have on a self-hosted platform where the
operator restarts the panel to apply an update.

### 2. `lost` is a status, and it is not `failed`

The `job_id` lives as long as the **agent process**. It survives a control-plane restart and
does not survive an agent restart, and `PollJob` says which by answering `found: false`.

A run in that state is recorded `lost`, meaning "Deplo could not find out how this ended". It
is not `failed`, because the command most likely completed - the agent restarting under it
says nothing about the command. Calling it `failed` would fire a failure alert for a
successful nightly job every time the fleet is updated. It still notifies (under
`cron_job_failed`), because a run that never resolves and tells nobody is the failure a cron
manager exists to prevent.

Same reasoning gives `timedout` its own status rather than a boolean: it points the reader at
a **setting** (the job's timeout) instead of at their command.

### 3. The double-fire guard is a unique index, not an in-RAM map

`UNIQUE(cron_runs.job_id, dedupe_key)`, with the insert's `ON CONFLICT DO NOTHING` as the
serialization point. The backup scheduler keeps a `lastFired` map in process memory; this one
does not, and the index is strictly less code that also survives a control-plane restart, two
instances racing for the lease, and a backwards clock step.

It also fixes an ordering problem for free. Overlap ("is a previous run still going?") is
decided **after** the insert, so two control-plane instances can never both conclude that
nothing else is running.

### 4. The dedupe key branches on whether the schedule pins an hour

A per-job timezone means DST, and DST breaks the two kinds of schedule in **opposite**
directions:

- Fall back repeats a wall-clock hour. `0 3 * * *` must fire **once**, so its key must be the
  wall clock.
- The same repeat means 25 real hours elapse. `*/5 * * * *` must fire **24 times** in that
  hour, so its key must be the instant.

One key for both is wrong for one of them. `pinsHour(expr)` picks: a named hour keys on the
wall clock, everything else keys on the instant.

Spring forward is left alone: a wall-clock minute that does not exist never matches, so a job
pinned inside the skipped hour does not run that day. Vixie cron fires it right after the
jump; we do not, and the schedule picker warns instead. That is one day a year for jobs
pinned to a one-hour window, and catching up costs a "was this minute skipped?" probe plus a
synthetic fire - recorded as an upgrade path in `lib/crons/cron-tz.ts`, not built.

### 5. `manage_crons` is seeded from console access, not from deploy access

Migration 0077 seeded `manage_previews` from `deploy_apps`. This one deliberately does not
follow it: it seeds `manage_crons` from `open_app_console` **or** `open_database_console`.

A cron job is an arbitrary command inside a container as the container's user with no
sandbox. The capability that already means exactly that is the console one; `deploy_apps` is
a strictly larger set of people, and widening it would be an escalation nobody asked for. The
capability is marked `sensitive`, and because one `manage_crons` governs both target kinds,
database jobs carry a **second** gate (`open_database_console`) in the data layer - otherwise
app-console access alone would reach inside every database.

As in 0077, `api_token_capabilities` is untouched. Silently widening an already-issued secret
to "can run any command on your servers, on a timer" is not a backfill.

### 6. Retries live in the same run row

`attempt` on `cron_runs`, and a retry never writes a terminal status - it leaves the row
`running` with `agent_job_id` NULL and `next_attempt_at` set. One scheduled fire is therefore
always one row in the history, and the alert fires only when the last attempt fails, which is
structural rather than a flag: `settle()` is the only place that dispatches.

The cost is stated rather than hidden: the stored output is the **last** attempt's, and
earlier attempts' output is discarded. Per-attempt output needs a child table; the run detail
says "last of N attempts" instead.

### 7. Deleting a job deletes its history

`cron_runs.job_id` CASCADEs, unlike `backup_runs.backup_id`, which is `SET NULL`. The
difference is not an inconsistency: a backup run points at an **artifact in S3** that outlives
its schedule and is the thing you restore from, while a cron run describes only itself. When
the job is gone there is nothing left for its history to be about.

### 8. Reaping runs at 5s, firing at 60s - they are not the same clock

The scheduler is one loop, and it used to do both phases once a minute. Firing has to be
minute-grained (a cron expression has no finer resolution); reaping does not, and tying it to
the same tick meant a command that ended in 200ms stayed `running` in the store for up to 59
more seconds. Everything downstream reads that row, so the delay was not cosmetic: the page
showed "Running" for a minute, a hand-started run looked queued behind the last one, and each
extra `running` row was another fire skipped under overlap=skip.

The tick is therefore 5 seconds and only the FIRE phase is gated to one per wall-clock minute
(`shouldFire`). The cost is one agent connection per server per tick while something is in
flight - and none at all when nothing is, which is the normal state.

Rejected: polling ONCE right after a start (fixes the button press, leaves every scheduled run
on the old clock), and pushing the result from the agent (a new streaming RPC and its
reconnection machinery, for a poll that costs a millisecond).

### 9. `Run now` honours `overlap`, and says so as a `skipped` run

The manual path used to ignore it, on the reasoning that somebody had just pressed a button.
That reads the setting as being about the SCHEDULER. It is not: "skip this run if it is still
running" is a statement about the command - that two copies of it must not run at once - and
the button is the one caller that would have been allowed to break it, on the job whose author
had already said not to.

It is recorded as a `skipped` run rather than refused, so the reason lands where every other
outcome does: in the history, on the row, in the toast. Stopping the run in flight, or
choosing "Run it anyway", is what makes it start.

## Consequences

- The agent gains three RPCs and one capability string; the contract stays `V1` (additive).
  An older agent answers UNIMPLEMENTED and the control plane says "update this server's
  agent" - there is no fallback path, on purpose: a background-and-poll emulation over `Exec`
  would need a shell, a writable `/tmp` and PID bookkeeping inside every user's container.
- A killed job's in-container process may outlive the exec client (docker has no "kill the
  exec'd process" API). Recorded as a ceiling in `internal/server/job.go`.
- Output is capped at 16 KiB per stream, **tail** not head, trimmed on both sides of the wire.
  A job's value is its ending; its head is startup boilerplate.
- `PollJob` returns output only on the terminal poll. Streaming it every minute for every
  in-flight job is megabytes of wire for data nobody stores, and the container's own logs are
  already there.
