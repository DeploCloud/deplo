import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { assembleDatabase } from "../backup-rows";
import { getCurrentUser } from "../../auth/current-user";
import { requireCapability } from "../../membership";
import { recordActivity } from "../activity";
import { assertNoNameClash, withNetworkLock } from "../name-clash";
import { environmentInTeam } from "../environments";
import { mountsFor, requireDatabase } from "./rows";
import { rerouteDatabase } from "./stack";

// moveDatabaseToEnvironment - the twin of `moveAppToEnvironment`: the placement
// IS the network, so the container is brought up again on it before this returns.
export async function moveDatabaseToEnvironment(
  id: string,
  environmentId: string | null,
): Promise<void> {
  const { teamId } = await requireCapability("configure_databases");
  const user = (await getCurrentUser())!;
  const cur = await requireDatabase(id, teamId);
  const env = environmentId
    ? await environmentInTeam(environmentId, teamId)
    : null;
  if (environmentId && !env) throw new Error("Environment not found");
  if ((cur.environmentId ?? null) === (env?.id ?? null)) return;

  await withNetworkLock(
    { teamId, environmentId: env?.id ?? null },
    async () => {
      await assertNoNameClash({
        to: { teamId, environmentId: env?.id ?? null, serverId: cur.serverId },
        claims: [cur.host],
        exceptId: id,
        subject: "the database",
      });
      await getDb()
        .update(databasesTable)
        .set({ environmentId: env?.id ?? null })
        .where(
          and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)),
        );
    },
  );
  await reapplyDatabaseNetwork([id]);
  await recordActivity(
    "database",
    env
      ? `Moved ${cur.name} to another environment`
      : `Moved ${cur.name} out of its environment`,
    user.name,
    null,
    teamId,
  );
}

// reapplyDatabaseNetwork - put moved databases onto the network their new
// placement owns. The CALLER has gated the move. Best-effort.
export async function reapplyDatabaseNetwork(ids: string[]): Promise<number> {
  let failed = 0;
  for (const id of ids) {
    try {
      const rows = await getDb()
        .select()
        .from(databasesTable)
        .where(eq(databasesTable.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) continue;
      const cur = assembleDatabase(row, await mountsFor(row.id));
      // A stopped or still-provisioning database follows the move when it next
      // starts, and COUNTS as not moved: the sweep's banner reads this number,
      // and a silent skip is what let it claim a success it had not got.
      if (!cur) continue;
      if (cur.status !== "running") {
        failed++;
        continue;
      }
      await rerouteDatabase(id);
    } catch (e) {
      failed++;
      console.warn(
        `[deplo] ${id} was moved but could not be put on its new network: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  return failed;
}
