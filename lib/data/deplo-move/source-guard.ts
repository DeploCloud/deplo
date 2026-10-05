import "server-only";

import { and, eq, gt } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { deploMovePauses } from "../../db/schema/control-plane/deplo-move";
import type { WorkloadKind } from "../../deplo-move/protocol";
import { nowIso } from "../../ids";

async function nameOf(kind: WorkloadKind, id: string): Promise<string> {
  const table = kind === "app" ? appsTable : databasesTable;
  const [row] = await getDb()
    .select({ name: table.name })
    .from(table)
    .where(eq(table.id, id))
    .limit(1);
  return row?.name ?? (kind === "app" ? "This app" : "This database");
}

// A workload lent to a copy of this Deplo (ADR-0035) stays stopped until the copy gives it back or the lease lapses.
export async function isPausedForMove(
  kind: WorkloadKind,
  id: string,
): Promise<boolean> {
  const [held] = await getDb()
    .select({ moveId: deploMovePauses.moveId })
    .from(deploMovePauses)
    .where(
      and(
        eq(deploMovePauses.kind, kind),
        eq(deploMovePauses.workloadId, id),
        gt(deploMovePauses.leaseUntil, nowIso()),
      ),
    )
    .limit(1);
  return Boolean(held);
}

export async function assertNotPausedForMove(
  kind: WorkloadKind,
  id: string,
): Promise<void> {
  if (!(await isPausedForMove(kind, id))) return;
  throw new Error(
    `${await nameOf(kind, id)} is paused while a copy of this Deplo reads its data. Try again in a few minutes.`,
  );
}
