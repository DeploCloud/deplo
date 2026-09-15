import "server-only";

import type { EnvTarget, EnvVar } from "../../types/env";
import type {
  envVars,
  envVarTargets,
} from "../../db/schema/control-plane/env-vars";

export type EnvVarRow = typeof envVars.$inferSelect;
export type EnvVarTargetRow = typeof envVarTargets.$inferSelect;

type EnvVarInsert = typeof envVars.$inferInsert;
type EnvVarTargetInsert = typeof envVarTargets.$inferInsert;

export function assembleEnvVar(
  row: EnvVarRow,
  targets: EnvVarTargetRow[],
): EnvVar {
  return {
    id: row.id,
    appId: row.appId,
    key: row.key,
    valueEnc: row.valueEnc,
    targets: targets.map((t) => t.target as EnvTarget),
    type: row.type as EnvVar["type"],
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function envVarToRow(e: EnvVar): EnvVarInsert {
  return {
    id: e.id,
    appId: e.appId,
    key: e.key,
    valueEnc: e.valueEnc,
    type: e.type,
    createdByUserId: e.createdByUserId,
    updatedByUserId: e.updatedByUserId,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

export function envVarTargetsToRows(e: EnvVar): EnvVarTargetInsert[] {
  return e.targets.map((target) => ({ envVarId: e.id, target }));
}
