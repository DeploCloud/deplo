import "server-only";

import { getDb } from "../../db/client";
import { passedUpdateStops } from "../../db/schema/control-plane/instance";
import { nowIso } from "../../ids";

export { stopPassed } from "../../db/update-stops";

export async function passedStops(): Promise<string[]> {
  const rows = await getDb()
    .select({ version: passedUpdateStops.version })
    .from(passedUpdateStops);
  return rows.map((r) => r.version);
}

export async function recordPassedStop(version: string): Promise<void> {
  await getDb()
    .insert(passedUpdateStops)
    .values({ version, passedAt: nowIso() })
    .onConflictDoNothing();
}
