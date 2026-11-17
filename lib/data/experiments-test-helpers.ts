import { instanceSettings } from "../db/schema/control-plane/instance";
import type { TestDb } from "../db/test-harness";
import type { ExperimentKey } from "../experiments";
import { EXPERIMENT_COLUMN as COLUMN } from "./experiments";

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

export async function turnOffExperiments(
  db: TestDb,
  ...keys: ExperimentKey[]
): Promise<void> {
  await db
    .update(instanceSettings)
    .set(Object.fromEntries(keys.map((k) => [COLUMN[k], false])));
}
