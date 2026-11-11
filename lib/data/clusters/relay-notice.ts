import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { cache } from "react";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { relayNoticeText } from "../../databases/relay-notice";
import { requireActiveTeamId } from "../../membership";
import { listWorkloadPlacements } from "./placement";

/** The database page's sentence when Apps of its Environment run on another server of its cluster; null otherwise. */
export const databaseRelayNotice = cache(
  async (databaseId: string): Promise<string | null> => {
    const teamId = await requireActiveTeamId();
    const db = getDb();
    const row = (
      await db
        .select({
          clusterId: databasesTable.clusterId,
          environmentId: databasesTable.environmentId,
          serverId: databasesTable.serverId,
        })
        .from(databasesTable)
        .where(
          and(
            eq(databasesTable.id, databaseId),
            eq(databasesTable.teamId, teamId),
          ),
        )
        .limit(1)
    )[0];
    if (!row?.clusterId) return null;
    const neighbours = await db
      .select({
        id: appsTable.id,
        name: appsTable.name,
        serverId: appsTable.serverId,
      })
      .from(appsTable)
      .where(
        and(
          eq(appsTable.teamId, teamId),
          eq(appsTable.clusterId, row.clusterId),
          // The same network (ADR-0028): its Environment, or the team's when it has none.
          row.environmentId
            ? eq(appsTable.environmentId, row.environmentId)
            : isNull(appsTable.environmentId),
        ),
      );
    const [dbPlaced, appsPlaced] = await Promise.all([
      listWorkloadPlacements("database", [databaseId]),
      listWorkloadPlacements(
        "app",
        neighbours.map((a) => a.id),
      ),
    ]);
    const where = (
      placed: { serverId: string | null }[] | undefined,
      fallback: string | null,
    ): Set<string> => {
      const ids = (placed ?? [])
        .map((p) => p.serverId)
        .filter((s): s is string => Boolean(s));
      return new Set(ids.length > 0 ? ids : fallback ? [fallback] : []);
    };
    const dbMembers = where(dbPlaced.get(databaseId), row.serverId);
    if (dbMembers.size === 0) return null;
    const far = neighbours.filter((a) => {
      const members = where(appsPlaced.get(a.id), a.serverId);
      return members.size > 0 && [...members].some((m) => !dbMembers.has(m));
    });
    return relayNoticeText(far.map((a) => a.name));
  },
);
