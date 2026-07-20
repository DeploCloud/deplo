# Ports are modeled per-target, not as a single scalar

- **Status**: Amended — 2026-07-19. Dev mode was removed from the product, taking the
  `development` target (and `dev.port`) with it: the axis collapsed to the single
  image-baked `build.port`. What survives is the load-bearing half of this decision —
  `portFor` / `effectivePortFor` in `lib/deploy/ports.ts` stay the ONLY port readers,
  so a future second runtime slots back into the same choke point.

## Context

A project's container port (`build.port`) was a single scalar: the value baked into
the production image (`EXPOSE`, `PORT=` build-arg) and used as Traefik's
`loadbalancer.server.port`. Dev mode introduces a second, independently-routed runtime
(the dev container) whose dev server may listen on a different port than the production
`start` command.

## Decision

A port is **per-target**: at most one port per `production | development` runtime — a
map keyed by target, not a list (which would admit two ports claiming the same target).
`preview` is image-based and reuses the **production** port, so the port axis is the
two-valued `PortTarget`, deliberately *narrower* than the three-valued env `EnvTarget`.

We realize the map as the existing `build.port` (production, image-baked — untouched)
plus `dev.port` (development, defaults to `build.port`), read through one accessor
`portFor(project, target)`. We do **not** physically migrate `build.port` into a
`Record<PortTarget, number>`: with only two keys living in two different runtimes, the
~12 image-baking/routing read sites of `build.port` gain nothing from the migration.

## Consequences

- The production pipeline is completely untouched — no risk to image baking or routing.
- "B-map" is the contract (one port per target, invalid states unrepresentable) and the
  accessor is the choke point; the storage is two scalars in two runtimes.
- Adding a third port-target later (or giving `preview` its own port) means revisiting
  this — at which point the real `Record<PortTarget, number>` may finally earn its cost.
- The accessor lives in its own pure module `lib/deploy/ports.ts` (not in
  `deploy/dev.ts`), reachable from both the deploy engine and the data layer. The
  per-domain override (single-image projects only) is folded onto the target default by
  a sibling `effectivePortFor(project, target, override)` — one definition of "effective
  port", so the override stops being re-derived inline in the routing path. The
  two-scalar storage decision above is unchanged; only the accessor's home and the
  override fold-in were made explicit.
