import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { backupDestination as destTable } from "../../db/schema/control-plane/backups";
import { assembleDestination } from "../backup-rows";
import { requireActiveTeamId, requireTeamWide } from "../../membership";
import {
  storedPerDestination,
  toDestinationOption,
  withServerNames,
  type DestinationDTO,
  type DestinationOption,
} from "./dto";
import type { BackupDestination } from "../../types/backup";

export async function loadDestination(
  id: string,
  teamId: string,
): Promise<BackupDestination | null> {
  const rows = await getDb()
    .select()
    .from(destTable)
    .where(and(eq(destTable.id, id), eq(destTable.teamId, teamId)))
    .limit(1);
  return rows[0] ? assembleDestination(rows[0]) : null;
}

export async function listDestinationOptions(): Promise<DestinationOption[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(destTable)
    .where(eq(destTable.teamId, teamId))
    .orderBy(desc(destTable.createdAt));
  return (await withServerNames(rows.map(assembleDestination))).map(
    toDestinationOption,
  );
}

export async function listDestinations(): Promise<DestinationDTO[]> {
  await requireTeamWide("backup destinations");
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(destTable)
    .where(eq(destTable.teamId, teamId))
    .orderBy(desc(destTable.createdAt));
  const destinations = rows.map(assembleDestination);
  return withServerNames(
    destinations,
    await storedPerDestination(
      teamId,
      destinations.map((d) => d.id),
    ),
  );
}
