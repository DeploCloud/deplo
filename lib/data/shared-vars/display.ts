import "server-only";

import { eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import {
  projects as projectsTable,
  environments as environmentsTable,
} from "../../db/schema/control-plane/projects";
import { teamAvatarUrl } from "../../avatar";
import { decryptSecret } from "../../crypto";
import type { SharedVar } from "../../types/env";

export const MASK = "••••••••••••";

export interface SharedVarTeamRef {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export function shownValue(v: {
  type: "plain" | "secret";
  valueEnc: string;
}): string {
  return v.type === "secret" ? MASK : decryptSecret(v.valueEnc);
}

export function authorIds(vars: SharedVar[]): (string | null)[] {
  return vars.flatMap((v) => [v.createdByUserId, v.updatedByUserId]);
}

export async function teamLookups(teamId: string): Promise<{
  environments: Map<string, { id: string; name: string; projectName: string }>;
  projects: Map<string, { id: string; name: string; slug: string }>;
  apps: Map<
    string,
    { id: string; name: string; slug: string; logo: string | null }
  >;
}> {
  const db = getDb();
  const [envRows, projRows, appRows] = await Promise.all([
    db
      .select({
        id: environmentsTable.id,
        name: environmentsTable.name,
        projectName: projectsTable.name,
      })
      .from(environmentsTable)
      .innerJoin(
        projectsTable,
        eq(environmentsTable.projectId, projectsTable.id),
      )
      .where(eq(projectsTable.teamId, teamId)),
    db
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        slug: projectsTable.slug,
      })
      .from(projectsTable)
      .where(eq(projectsTable.teamId, teamId)),
    db
      .select({
        id: appsTable.id,
        name: appsTable.name,
        slug: appsTable.slug,
        logo: appsTable.logo,
      })
      .from(appsTable)
      .where(eq(appsTable.teamId, teamId)),
  ]);
  return {
    environments: new Map(envRows.map((e) => [e.id, e] as const)),
    projects: new Map(projRows.map((p) => [p.id, p] as const)),
    apps: new Map(appRows.map((a) => [a.id, a] as const)),
  };
}

export async function teamNames(
  vars: SharedVar[],
): Promise<Map<string, SharedVarTeamRef>> {
  const ids = [
    ...new Set(vars.flatMap((v) => [...v.teamIds, v.teamId ?? ""])),
  ].filter(Boolean);
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      image: teamsTable.image,
    })
    .from(teamsTable)
    .where(inArray(teamsTable.id, ids));
  return new Map(
    rows.map(
      (t) =>
        [
          t.id,
          { id: t.id, name: t.name, avatarUrl: teamAvatarUrl(t.image) },
        ] as const,
    ),
  );
}
