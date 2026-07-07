/**
 * The port-target accessors (ADR-0001).
 *
 * A port is per-target: at most one per `production | development` runtime. The
 * map is realized as two scalars in two runtimes — `build.port` (production,
 * image-baked) and `dev.port` (development, defaults to `build.port`) — NOT a
 * `Record<PortTarget, number>` (ADR-0001 keeps the storage as two scalars). This
 * module is the single choke point that reads them, plus the one place that
 * folds in a per-domain override.
 *
 * Pure on purpose: no store, no docker, no `server-only`. It takes the data it
 * needs and returns a number, so its interface IS its test surface — every
 * caller (deploy engine and data layer alike) crosses the same seam.
 */

import type { PortTarget } from "../types";

/** Just the fields this module reads from a project — so callers in the data
 * layer can resolve a port without dragging in the full `Service` (and the
 * `server-only` graph behind it). A `Service` satisfies this structurally. */
export interface PortBearingService {
  build: { port: number };
  dev?: { port: number } | null;
}

/**
 * The container port for a project's `target` runtime (ADR-0001). `production`
 * and `preview` read the image-baked `build.port`; `development` reads
 * `dev.port`, falling back to `build.port` when dev mode never set one.
 */
export function portFor(project: PortBearingService, target: PortTarget): number {
  if (target === "development") {
    return project.dev?.port || project.build.port;
  }
  return project.build.port;
}

/**
 * The container port a specific routed hostname targets: its per-domain override
 * when set, else the project's port for `target`. A `null`/`undefined` override
 * means "use the target default" — the long-standing behaviour where every
 * domain hits the same service. Per-domain overrides apply to single-image /
 * built services only; the deploy engine never passes one for a compose stack.
 *
 * This is the one definition of "effective port", reachable from both the deploy
 * engine (Traefik routers) and the data layer (validation / display).
 */
export function effectivePortFor(
  project: PortBearingService,
  target: PortTarget,
  override: number | null | undefined,
): number {
  return override ?? portFor(project, target);
}
