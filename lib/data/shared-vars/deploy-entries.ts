import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  sharedEnvVars as varsTable,
  sharedEnvVarTargets as targetsTable,
  sharedEnvVarApps as appJunction,
  sharedEnvVarTeams as teamJunction,
} from "../../db/schema/control-plane/env-vars";
import { ALL_ENV_TARGETS } from "../../types/env";
import type { EnvTarget } from "../../types/env";
import type { SharedVarEntry } from "../../deploy/env-resolve";
import { visibleTo } from "./visibility";

const DEPLOY_COLUMNS = {
  id: varsTable.id,
  key: varsTable.key,
  valueEnc: varsTable.valueEnc,
  // A loader that dropped this column answered "not a secret" for a team's whole shared set at fork preview.
  type: varsTable.type,
  createdAt: varsTable.createdAt,
} as const;

type DeployRow = {
  id: string;
  key: string;
  valueEnc: string;
  type: string;
  createdAt: string;
};

async function toEntries(rows: DeployRow[]): Promise<SharedVarEntry[]> {
  if (rows.length === 0) return [];
  const targetRows = await getDb()
    .select()
    .from(targetsTable)
    .where(
      inArray(
        targetsTable.varId,
        rows.map((r) => r.id),
      ),
    );
  const targetsBy = new Map<string, EnvTarget[]>();
  for (const t of targetRows) {
    const arr = targetsBy.get(t.varId) ?? [];
    arr.push(t.target as EnvTarget);
    targetsBy.set(t.varId, arr);
  }
  return rows
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((r) => {
      const targets = targetsBy.get(r.id);
      return {
        key: r.key,
        valueEnc: r.valueEnc,
        targets: targets && targets.length ? targets : ALL_ENV_TARGETS,
        type: r.type === "secret" ? ("secret" as const) : ("plain" as const),
      };
    });
}

async function teamOfApp(appId: string): Promise<string | null> {
  const app = (
    await getDb()
      .select({ teamId: appsTable.teamId })
      .from(appsTable)
      .where(eq(appsTable.id, appId))
      .limit(1)
  )[0];
  return app?.teamId ?? null;
}

// Only the vars this app is explicitly linked to inject; an availability scope never does (ADR-0012).
export async function loadSharedVarsForApp(
  appId: string,
): Promise<SharedVarEntry[]> {
  const teamId = await teamOfApp(appId);
  if (!teamId) return [];
  return toEntries(
    await getDb()
      .select(DEPLOY_COLUMNS)
      .from(varsTable)
      .innerJoin(appJunction, eq(appJunction.varId, varsTable.id))
      .where(and(visibleTo(teamId), eq(appJunction.appId, appId))),
  );
}

export async function loadAutoInjectedVarsForApp(
  appId: string,
): Promise<SharedVarEntry[]> {
  const teamId = await teamOfApp(appId);
  if (!teamId) return [];
  return toEntries(
    await getDb()
      .select(DEPLOY_COLUMNS)
      .from(varsTable)
      .innerJoin(teamJunction, eq(teamJunction.varId, varsTable.id))
      .where(
        and(eq(varsTable.autoInject, true), eq(teamJunction.teamId, teamId)),
      ),
  );
}
