import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { envVars as envVarsTable } from "../db/schema/control-plane/env-vars";
import { getCurrentUser } from "../auth/current-user";
import { tryDecryptSecret } from "../crypto";
import { databaseReach, reachable } from "../databases/link";
import { exactConnectionStrings, inSchemeOf } from "../deploy/database-compose";
import { recordActivity } from "./activity";
import type { DatabaseType } from "../types/database";

export interface AutoLink {
  key: string;
  database: string;
}

// Only a value that IS a database's string links (its scheme spelled any way the driver
// accepts): anything else would change what the app gets.
const notLinked = () =>
  and(
    isNull(envVarsTable.databaseId),
    eq(envVarsTable.databaseUnlinked, false),
  );

const candidates = () =>
  getDb()
    .select({
      id: envVarsTable.id,
      appId: envVarsTable.appId,
      key: envVarsTable.key,
      valueEnc: envVarsTable.valueEnc,
      teamId: appsTable.teamId,
      environmentId: appsTable.environmentId,
      serverId: appsTable.serverId,
    })
    .from(envVarsTable)
    .innerJoin(appsTable, eq(appsTable.id, envVarsTable.appId));

// Callers are writes that already passed the app's manage_env gate.
export async function autoLinkAppEnv(appId: string): Promise<AutoLink[]> {
  const rows = await candidates().where(
    and(eq(envVarsTable.appId, appId), notLinked()),
  );
  const user = await getCurrentUser();
  return linkExact(rows, user?.name ?? "Deplo");
}

// The maintenance sweep: picks up variables written before their database existed.
export async function autoLinkAllEnv(): Promise<void> {
  await linkExact(await candidates().where(notLinked()), "Deplo");
}

async function linkExact(
  rows: Awaited<ReturnType<typeof candidates>>,
  actor: string,
): Promise<AutoLink[]> {
  if (rows.length === 0) return [];
  const dbs = await getDb()
    .select()
    .from(databasesTable)
    .where(
      inArray(databasesTable.teamId, [...new Set(rows.map((r) => r.teamId))]),
    );
  const known = dbs.flatMap((d) => {
    const stored = tryDecryptSecret(d.connectionStringEnc);
    if (!stored.ok) return [];
    const db = { ...d, type: d.type as DatabaseType };
    return [{ db, exact: exactConnectionStrings(db, stored.value) }];
  });
  const linked: AutoLink[] = [];
  for (const row of rows) {
    const value = tryDecryptSecret(row.valueEnc);
    if (!value.ok) continue;
    const pasted = value.value.trim();
    const hit = known.find(
      (k) =>
        k.db.teamId === row.teamId &&
        k.exact.some((x) => inSchemeOf(pasted, x) === pasted) &&
        reachable(databaseReach(row, k.db)),
    );
    if (!hit) continue;
    const done = await getDb()
      .update(envVarsTable)
      .set({ databaseId: hit.db.id })
      .where(and(eq(envVarsTable.id, row.id), notLinked()))
      .returning({ id: envVarsTable.id });
    if (done.length === 0) continue;
    linked.push({ key: row.key, database: hit.db.name });
    await recordActivity(
      "env",
      `${row.key} now follows ${hit.db.name}`,
      actor,
      row.appId,
      row.teamId,
      null,
      hit.db.id,
    );
  }
  return linked;
}
