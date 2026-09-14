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

// beginMigration - open a run. Any run this team left `running` is closed as failed
// first: the only way one stays open is a tab that went away, and a history with two
// live runs in it cannot be read. That is also why there is no boot reconcile to add.
export async function beginMigration(input: {
  url: string;
  orgName?: string | null;
  kind?: MigrationPlatform;
  // More teams of this panel are still to come - see `migration_runs.keep_sources`.
  keepSources?: boolean;
  // The first run of this walk of the wizard. Absent means this IS the first.
  sessionId?: string | null;
}): Promise<string> {
  const { teamId } = await assertImportGate();
  const user = await getCurrentUser();
  const db = getDb();
  const now = nowIso();

  // A run that is STILL BEING DRIVEN is not debris to clear: two of them creating
  // the same projects at once produced the same app twice and a pile of orphans,
  // because the second one's "is this already here?" read ran before the first
  // had written. A double click on Start is exactly that.
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
        // A stored key is what says the RUNNER owns this one. A run without it
        // is a tab that went away, and clearing it is the whole point below.
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
  // A run nobody is running must not go on holding its services hostage: this is
  // the door an abandoned tab leaves by, and everything it created is handed back
  // the moment somebody starts the next migration.
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
    // The id as well as the display name: it is what says whose wizard opens on
    // this run again (`resumableMigration`), and the runner overwrites it
    // with the same value when it takes the plan.
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

// finishMigration - close a run. Counts come last, because the sweep writes report rows.
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
  // The services are the team's again before anything else happens: the sweep
  // below dials hosts and can take a minute, and none of that is a reason to
  // keep a finished migration's apps frozen.
  if (closed.length > 0) await releaseMigrating(runId);
  const [row] = await getDb()
    .select({ keepSources: runsTable.keepSources })
    .from(runsTable)
    .where(and(eq(runsTable.id, runId), eq(runsTable.teamId, teamId)))
    .limit(1);
  // Swept whether or not THIS call is what ended the run. A run that already
  // failed still owns the agents it put on those machines, and leaving them there
  // is what made the next attempt find a machine that was "already connected".
  // Unless another team of the same panel is next: it reads the same disks, and a
  // scheduled uninstall would race the install that follows it.
  if (!row?.keepSources) await removeMigrationSources(runId, teamId);
  await refreshCounts(runId, teamId);
}
