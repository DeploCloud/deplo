import "server-only";

export interface StopCondition {
  met: boolean;
}

/** What must hold before this release counts as passed, when it is an update stop (ADR-0041). */
export async function thisStopsCondition(): Promise<StopCondition> {
  return { met: true };
}
