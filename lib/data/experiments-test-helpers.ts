import { instanceSettings } from "../db/schema/control-plane/instance";
import type { TestDb } from "../db/test-harness";
import type { ExperimentKey } from "../experiments";

const COLUMN = {
  crons: "experimentCrons",
  zeroDowntime: "experimentZeroDowntime",
  pullRequests: "experimentPullRequests",
  clusters: "experimentClusters",
  tunnels: "experimentTunnels",
} as const;

// Seeds come after any truncate of instance_settings, which TRUNCATE_IDENTITY includes.
export async function turnOnExperiments(
  db: TestDb,
  ...keys: ExperimentKey[]
): Promise<void> {
  const set = Object.fromEntries(keys.map((k) => [COLUMN[k], true]));
  await db
    .insert(instanceSettings)
    .values({ id: "default", updatedAt: "2026-01-01T00:00:00.000Z", ...set })
    .onConflictDoUpdate({ target: instanceSettings.id, set });
}
