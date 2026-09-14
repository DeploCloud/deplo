// PortBearingApp is just the fields this module reads; an `App` satisfies it structurally.
export interface PortBearingApp {
  build: { port: number };
}

// portFor is the container port of a project's runtime (ADR-0001).
// `preview` reuses the production port.
export function portFor(project: PortBearingApp): number {
  return project.build.port;
}

// effectivePortFor is a routed hostname's per-domain override, else the project's port.
// Per-domain overrides are single-image / built apps only; the engine never passes one for a compose stack.
export function effectivePortFor(
  project: PortBearingApp,
  override: number | null | undefined,
): number {
  return override ?? portFor(project);
}
