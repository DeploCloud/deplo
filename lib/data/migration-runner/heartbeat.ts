import "server-only";

import { eq } from "drizzle-orm";

import { acquireLease } from "../../backups/lease";
import { getDb } from "../../db/client";
import { migrationRuns as runsTable } from "../../db/schema/control-plane/migration";
import { publishMigrationChanged } from "../../graphql/pubsub";
import { nowIso } from "../../ids";
import { abortRunCopy } from "../migration-data/move";
import { STALE_MS, leaseFor, lostLeases, owner } from "./runner-state";

export async function beat(runId: string): Promise<void> {
  if (!(await acquireLease(leaseFor(runId), owner, new Date(), STALE_MS))) {
    lostLeases.add(runId);
    abortRunCopy(runId);
    throw new Error("lease lost");
  }
  await getDb()
    .update(runsTable)
    .set({ runnerOwner: owner, heartbeatAt: nowIso() })
    .where(eq(runsTable.id, runId));
  publishMigrationChanged();
}

export async function setProgress(
  runId: string,
  patch: { doneSteps?: number; stepLabel?: string | null; phase?: string },
): Promise<void> {
  await getDb().update(runsTable).set(patch).where(eq(runsTable.id, runId));
  publishMigrationChanged();
}
