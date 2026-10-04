import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { requireInstanceAdmin, teamsForUser } from "../../membership";

export type ServerRunningApp = {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  logoTone: "dark" | "light" | null;
  teamName: string;
  // Null when the viewer is not in the owning team, so there is no page to open.
  teamSlug: string | null;
};

// Every team's apps: a server is shared, and only an instance admin reads this.
export async function listRunningAppsOnServer(
  serverId: string,
): Promise<ServerRunningApp[]> {
  const { userId } = await requireInstanceAdmin();
  const [rows, mine] = await Promise.all([
    getDb()
      .select({
        id: appsTable.id,
        name: appsTable.name,
        slug: appsTable.slug,
        logo: appsTable.logo,
        logoTone: appsTable.logoTone,
        teamId: teamsTable.id,
        teamName: teamsTable.name,
        teamSlug: teamsTable.slug,
      })
      .from(appsTable)
      .innerJoin(teamsTable, eq(teamsTable.id, appsTable.teamId))
      .where(
        and(eq(appsTable.serverId, serverId), eq(appsTable.status, "active")),
      )
      .orderBy(asc(teamsTable.name), asc(appsTable.name)),
    teamsForUser(userId),
  ]);
  const member = new Set(mine.map((t) => t.id));
  return rows.map(({ teamId, teamSlug, logoTone, ...app }) => ({
    ...app,
    logoTone: logoTone === "dark" || logoTone === "light" ? logoTone : null,
    teamSlug: member.has(teamId) ? teamSlug : null,
  }));
}
