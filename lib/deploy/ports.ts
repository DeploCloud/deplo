/**
 * The port accessors (ADR-0001, amended).
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
 * when set, else the project's port. Per-domain overrides apply to single-image /
 * built apps only; the deploy engine never passes one for a compose stack.
 */
export function effectivePortFor(
  project: PortBearingApp,
  override: number | null | undefined,
): number {
  return override ?? portFor(project);
}
