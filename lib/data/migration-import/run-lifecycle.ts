import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import { migrationRuns as runsTable } from "../../db/schema/control-plane/migration";
import { newId, nowIso } from "../../ids";
import { getCurrentUser } from "../../auth/current-user";
import { MIGRATION_HEARTBEAT_STALE_MS } from "../../types/migration";
import { normalizeSourceBaseUrl } from "../../migration/transport";
import type { MigrationPlatform } from "../../migration/source";
import { publishMigrationChanged } from "../../graphql/pubsub";
import { assertImportGate } from "./gates";
import { refreshCounts, releaseMigrating } from "./run-report";
import { removeMigrationSources } from "./source-agents";

export async function beginMigration(input: {
  url: string;
  orgName?: string | null;
  kind?: MigrationPlatform;
  keepSources?: boolean;
  sessionId?: string | null;
}): Promise<string> {
  const { teamId } = await assertImportGate();
  const user = await getCurrentUser();
  const db = getDb();
  const now = nowIso();

  const live = await db
    .select({
      id: runsTable.id,
      actor: runsTable.actor,
      startedAt: runsTable.startedAt,
      heartbeatAt: runsTable.heartbeatAt,
    })
    .from(runsTable)
    .where(
      and(
        eq(runsTable.teamId, teamId),
        eq(runsTable.status, "running"),
        isNotNull(runsTable.apiKeyEnc),
      ),
    );
  const alive = live.find(
    (r) =>
      Date.now() - Date.parse(r.heartbeatAt ?? r.startedAt) <
      MIGRATION_HEARTBEAT_STALE_MS,
  );
  if (alive)
    throw new Error(
      `${alive.actor} already has a migration running in this team. Wait for it to finish, or stop it from Settings → System → Migrations.`,
    );

  const interrupted = await db
    .update(runsTable)
    .set({
      status: "failed",
      error:
        "Stopped answering, so it was marked failed when the next migration started. Whatever it created is still here - the log says what.",
      finishedAt: now,
    })
    .where(and(eq(runsTable.teamId, teamId), eq(runsTable.status, "running")))
    .returning({ id: runsTable.id });
  for (const r of interrupted) await releaseMigrating(r.id);

  const id = newId("dimp");
  await db.insert(runsTable).values({
    id,
    teamId,
    sourceUrl: normalizeSourceBaseUrl(input.url),
    platform: input.kind ?? "dokploy",
    orgName: input.orgName?.trim() || null,
    keepSources: input.keepSources ?? false,
    actor: user?.name ?? "someone",
    actorUserId: user?.id ?? null,
    status: "running",
    created: 0,
    skipped: 0,
    failed: 0,
    manual: 0,
    error: null,
    startedAt: now,
    finishedAt: null,
    sessionId: input.sessionId ?? id,
  });
  publishMigrationChanged();
  return id;
}

export async function finishMigration(runId: string): Promise<void> {
  const { teamId } = await assertImportGate();
  const closed = await getDb()
    .update(runsTable)
    .set({ status: "done", finishedAt: nowIso() })
    .where(
      and(
        eq(runsTable.id, runId),
        eq(runsTable.teamId, teamId),
        eq(runsTable.status, "running"),
      ),
    )
    .returning({ id: runsTable.id });
  if (closed.length > 0) await releaseMigrating(runId);
  const [row] = await getDb()
    .select({ keepSources: runsTable.keepSources })
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)))
    .limit(1);
  if (!row?.keepSources) await removeMigrationSources(runId, teamId);
  await refreshCounts(runId, teamId);
}
