export interface PortBearingApp {
  build: { port: number };
}

export function portFor(project: PortBearingApp): number {
  return project.build.port;
}

export function effectivePortFor(
  project: PortBearingApp,
  override: number | null | undefined,
): number {
  return override ?? portFor(project);
}
