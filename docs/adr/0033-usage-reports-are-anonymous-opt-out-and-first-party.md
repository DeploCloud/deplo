# ADR-0033: Usage reports are anonymous, opt-out, and land on a service of our own

- **Status**: Accepted - 2026-09-21.
- **Constrains**: `lib/usage-report/` (builder + sender, called only from the maintenance
  sweep in `lib/notify/maintenance.ts`), the `instance_settings`
  singleton, Settings → Deplo → General, the setup wizard's last step, the private
  `DeploCloud/telemetry` repository (ingest + dashboard), and the docs page that lists
  what a report contains.

## Context

Deplo tells its users the data stays on a machine they chose, and until now the only
things an instance dialled out for were the GitHub release check and the public template
catalog (ADR-0023). Nothing said how many instances exist, on which versions, on what
hosts, or which features anyone turns on - and every roadmap and rollout decision
(`docs/agents/fleet-rollout.md` included) was made blind. Any collection has to survive
the promise that made people install Deplo in the first place.

## Decision

1. **One anonymous Usage report a day, on by default, off in one click.** The
   maintenance sweep sends at most one report per 24 hours. The switch,
   **Anonymous usage statistics**, is gated on **instance admin** like every other card
   on Settings → Deplo, not on the owner: a privacy switch a company's admins cannot reach
   is the "ask whoever runs the box" failure. Off means nothing more is sent - no goodbye.
   Toggling is recorded in Activity.

2. **Anonymous is a property of the payload, not a promise in the copy.** The report is
   keyed by a random instance id minted on the first send and **re-minted every time the
   switch goes from off to on**, so turning it off severs the history; its mint time is
   what `daysSinceFirstReport` counts from, and goes with it. It carries versions,
   per-host versions and architecture, counts, and feature booleans; never a hostname, IP,
   domain, email, username, app name, repo URL, template slug, error or stack trace. The
   card's "See what would be sent" renders the report live, and the docs page lists the
   same fields, so what is shown, sent and documented is one thing.

3. **Disclosure precedes the first send.** The setup wizard's last step carries one
   sentence and no control ("Deplo sends anonymous usage statistics. Turn this off any time
   in Settings → Deplo."), and the sender refuses to run until an instance owner exists.
   A sentence, not a switch, because first run must not grow a knob.

4. **`DO_NOT_TRACK=1` is the install-time kill switch**, and the only one. The world
   already names this; a host that packages Deplo sets it once for every tool. The card
   then shows the switch disabled with "Turned off by the install".

5. **Reports land on a service of our own, in a private repository.** No third-party
   analytics SDK ever ships in the control plane, and the ingest is not a route on the
   template catalog: a catalog mirror must not silently become a collector, and a separate
   host (`usage.deplo.build`) is what lets a firewall block reports alone. The address is a
   constant, with no env override - an override would be a user-typed outbound URL.

6. **The ingest keeps no address and defends itself in memory.** The caller's IP is never
   written: the limiter (one accepted report per id per 24 h, at most 20 new ids per IP
   per day) lives in process memory, answers a plain 429 with no body, and a restart
   forgets it. The control plane treats any non-5xx answer as sent, so a limited instance
   goes quiet without being told. Raw reports live 90 days as `jsonb` beside typed
   columns for what the dashboard aggregates; daily roll-ups live forever. The dashboard
   (`usage-dashboard.deplo.build`) has no auth code of its own and sits behind Deplo's
   domain basic auth. It shows distributions and adoption, never one instance.

7. **A snapshot, not events.** Adding a field never bumps `schema`; a rename or removal
   does, and the ingest refuses an unknown major with a 400. Per-action events would turn a
   privacy switch into a stream and need a queue and a schema per event for questions
   nobody is asking yet.

## Considered options

- **Opt-in.** Honest, and useless: the numbers would describe the people who read
  settings pages. Opt-out with a real disclosure and a real switch is what every
  comparable developer tool converged on, and it is what §2-§4 make defensible.
- **A third-party analytics service.** Cheapest to build, and it puts a stranger's SDK
  and a stranger's retention policy between the promise and the user.
- **An ingest route on the template catalog.** One repo fewer, and a catalog mirror
  would then have to swallow reports too.
- **Agents sending for themselves.** A second outbound address across the fleet for
  numbers the control plane already holds in `servers`.

## Consequences

- The control plane change is a **minor** release (migration + a behaviour the user
  notices), and it ships **after** the service is live, or every instance logs a failed
  send. No release without the owner's explicit go (`docs/agents/releasing.md`).
- A managed-cloud tenant never sees the card: it is an instance setting, and there the
  operator is Deplo.
- Poisoned data (many ids from many addresses) is not prevented, only bounded; the
  dashboard grows an "ignore" tool if that ever matters.
