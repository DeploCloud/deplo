/**
 * The port accessors (ADR-0001, amended).
 *
 * An app has ONE container port — the image-baked `build.port` — read through
 * this module, plus the one place that folds in a per-domain override. (ADR-0001
 * originally modelled a per-target `production | development` pair; the
 * `development` target died with dev mode, collapsing the axis to the single
 * production scalar. The choke point survives the collapse: every caller still
 * crosses this seam, so a future second runtime slots back in here.)
 *
 * Pure on purpose: no store, no docker, no `server-only`. It takes the data it
 * needs and returns a number, so its interface IS its test surface — every
 * caller (deploy engine and data layer alike) crosses the same seam.
 */

/** Just the fields this module reads from a project — so callers in the data
 * layer can resolve a port without dragging in the full `App` (and the
 * `server-only` graph behind it). A `App` satisfies this structurally. */
export interface PortBearingApp {
  build: { port: number };
}

/** The container port of a project's runtime (ADR-0001): the image-baked
 * `build.port` (`preview` reuses the production port). */
export function portFor(project: PortBearingApp): number {
  return project.build.port;
}

/**
 * The container port a specific routed hostname targets: its per-domain override
 * when set, else the project's port. A `null`/`undefined` override
 * means "use the default" — the long-standing behaviour where every
 * domain hits the same app. Per-domain overrides apply to single-image /
 * built apps only; the deploy engine never passes one for a compose stack.
 *
 * This is the one definition of "effective port", reachable from both the deploy
 * engine (Traefik routers) and the data layer (validation / display).
 */
export function effectivePortFor(
  project: PortBearingApp,
  override: number | null | undefined,
): number {
  return override ?? portFor(project);
}
