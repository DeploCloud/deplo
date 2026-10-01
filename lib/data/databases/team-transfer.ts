import "server-only";

import { cache } from "@/lib/request-cache";
import { and, count, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { teamAvatarUrl } from "../../avatar";
import { activities as activitiesTable } from "../../db/schema/control-plane/activity";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
} from "../../db/schema/control-plane/backups";
import { cronJobs as cronJobsTable } from "../../db/schema/control-plane/crons";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { teamDatabaseOrder } from "../../db/schema/control-plane/display-order";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { environments as environmentsTable } from "../../db/schema/control-plane/projects";
import { getCurrentUser } from "../../auth/current-user";
import { publishDatabaseChanged } from "../../graphql/pubsub";
import { requireCapability } from "../../membership";
import { recordActivity } from "../activity";
import { databaseUsesInTeam } from "../database-usage";
import { withKeyedLock } from "../keyed-mutex";
import { assertNoNameClash, withNetworkLock } from "../name-clash";
import { assertServerAccessibleTx } from "../servers/team-access";
import {
  requireTransferDestination,
  serverAccess,
  transferCandidates,
} from "../team-transfer-targets";
import { reapplyDatabaseNetwork } from "./environment-move";
import { requireDatabase } from "./rows";

export interface DatabaseTransferTarget {
  id: string;
  name: string;
  avatarUrl: string | null;
  serverAvailable: boolean;
  nameTaken: boolean;
}

export interface DatabaseTransferInfo {
  databaseName: string;
  serverName: string;
  environmentName: string | null;
  backupCount: number;
  cronCount: number;
  usedBy: string[];
  running: boolean;
  targets: DatabaseTransferTarget[];
}

export const databaseTransferInfo = cache(
  async (id: string): Promise<DatabaseTransferInfo> => {
    const { userId, teamId } = await requireCapability("move_databases");
    const cur = await requireDatabase(id, teamId);
    const db = getDb();

    const candidates = await transferCandidates(
      userId,
      teamId,
      "move_databases",
    );
    const server = await serverAccess(cur.serverId);
    const sameName = new Set(
      (
        await db
          .select({ teamId: databasesTable.teamId })
          .from(databasesTable)
          .where(eq(databasesTable.name, cur.name))
      ).map((r) => r.teamId),
    );
    const environmentName = cur.environmentId
      ? ((
          await db
            .select({ name: environmentsTable.name })
            .from(environmentsTable)
            .where(eq(environmentsTable.id, cur.environmentId))
            .limit(1)
        )[0]?.name ?? null)
      : null;
    const [backups, crons, uses] = await Promise.all([
      db
        .select({ n: count() })
        .from(backupsTable)
        .where(
          and(eq(backupsTable.databaseId, id), eq(backupsTable.teamId, teamId)),
        ),
      db
        .select({ n: count() })
        .from(cronJobsTable)
        .where(
          and(
            eq(cronJobsTable.databaseId, id),
            eq(cronJobsTable.teamId, teamId),
          ),
        ),
      databaseUsesInTeam(teamId, { databaseIds: [id] }),
    ]);

    return {
      databaseName: cur.name,
      serverName: server.name,
      environmentName,
      backupCount: Number(backups[0]?.n ?? 0),
      cronCount: Number(crons[0]?.n ?? 0),
      usedBy: uses.map((u) => u.appName),
      running: cur.status === "running",
      targets: candidates.map((c) => ({
        id: c.id,
        name: c.name,
        avatarUrl: teamAvatarUrl(c.image),
        serverAvailable: server.teamIds ? server.teamIds.has(c.id) : true,
        nameTaken: sameName.has(c.id),
      })),
    };
  },
);

export async function transferDatabaseToTeam(
  id: string,
  destTeamId: string,
): Promise<void> {
  const { userId, teamId } = await requireCapability("move_databases");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const cur = await requireDatabase(id, teamId);
  if (cur.status === "provisioning")
    throw new Error(`${cur.name} is still being created - try again shortly.`);
  const destTeam = await requireTransferDestination({
    userId,
    fromTeamId: teamId,
    destTeamId,
    cap: "move_databases",
    noun: "database",
    serverId: cur.serverId,
  });
  const db = getDb();
  const assertNameFree = async () => {
    const taken = await db
      .select({ id: databasesTable.id })
      .from(databasesTable)
      .where(
        and(
          eq(databasesTable.teamId, destTeamId),
          eq(databasesTable.name, cur.name),
        ),
      )
      .limit(1);
    if (taken.length > 0)
      throw new Error(
        `${destTeam.name} already has a database named "${cur.name}". Rename one of them first.`,
      );
  };
  await assertNameFree();
  const sourceTeam = (
    await db
      .select({ name: teamsTable.name })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1)
  )[0];

  await withNetworkLock({ teamId: destTeamId, environmentId: null }, () =>
    withKeyedLock(id, async () => {
      await assertNoNameClash({
        to: { teamId: destTeamId, environmentId: null, serverId: cur.serverId },
        claims: [cur.host],
        exceptId: id,
        subject: "the database",
      });
      await assertNameFree();
      await db.transaction(async (tx) => {
        await assertServerAccessibleTx(tx, cur.serverId, destTeamId);
        const moved = await tx
          .update(databasesTable)
          .set({ teamId: destTeamId, environmentId: null })
          .where(
            and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)),
          )
          .returning({ id: databasesTable.id });
        if (moved.length === 0) throw new Error("Not found");
        await tx
          .delete(teamDatabaseOrder)
          .where(eq(teamDatabaseOrder.databaseId, id));
        await tx
          .delete(backupsTable)
          .where(
            and(
              eq(backupsTable.databaseId, id),
              eq(backupsTable.teamId, teamId),
            ),
          );
        await tx
          .delete(cronJobsTable)
          .where(
            and(
              eq(cronJobsTable.databaseId, id),
              eq(cronJobsTable.teamId, teamId),
            ),
          );
        await tx
          .update(backupRunsTable)
          .set({ databaseId: null })
          .where(
            and(
              eq(backupRunsTable.databaseId, id),
              eq(backupRunsTable.teamId, teamId),
            ),
          );
        await tx
          .update(activitiesTable)
          .set({ databaseId: null })
          .where(eq(activitiesTable.databaseId, id));
      });
    }),
  );

  await reapplyDatabaseNetwork([id]);
  publishDatabaseChanged(id);

  await recordActivity(
    "database",
    `Transferred database ${cur.name} to ${destTeam.name}`,
    userName,
    null,
    teamId,
  );
  await recordActivity(
    "database",
    `Received database ${cur.name} from ${sourceTeam?.name ?? "another team"}`,
    userName,
    null,
    destTeamId,
    null,
    id,
  );
}
