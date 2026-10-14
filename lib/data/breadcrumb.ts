import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { reachesWholeTeam, requireActiveTeamId } from "../membership";
import { listFolders } from "./folders";
import { appScopeWhere } from "./app-graph-load";
import { appCapabilitiesForTeam } from "./node-access";
import { listProjects } from "./projects/read";
import type { BreadcrumbGraph } from "../breadcrumb-model";

export async function getBreadcrumbGraph(): Promise<BreadcrumbGraph> {
  const teamId = await requireActiveTeamId();
  const [folders, projects, appRows, teamWide] = await Promise.all([
    listFolders(),
    listProjects(),
    getDb()
      .select({
        id: appsTable.id,
        slug: appsTable.slug,
        name: appsTable.name,
        folderId: appsTable.folderId,
        projectId: appsTable.projectId,
        environmentId: appsTable.environmentId,
        logo: appsTable.logo,
        source: appsTable.source,
        previewEnabled: appsTable.previewEnabled,
        cronEnabled: appsTable.cronEnabled,
        consoleEnabled: appsTable.consoleEnabled,
      })
      .from(appsTable)
      .where(and(eq(appsTable.teamId, teamId), appScopeWhere())),
    reachesWholeTeam(),
  ]);

  // The same reach listApps applies: role scope AND folder privacy.
  const reach = await appCapabilitiesForTeam(
    teamId,
    appRows.map((s) => ({
      id: s.id,
      folderId: s.folderId ?? null,
      projectId: s.projectId ?? null,
      environmentId: s.environmentId ?? null,
    })),
  );
  const databaseRows = teamWide
    ? await getDb()
        .select({
          id: databasesTable.id,
          name: databasesTable.name,
          type: databasesTable.type,
          logo: databasesTable.logo,
        })
        .from(databasesTable)
        .where(eq(databasesTable.teamId, teamId))
    : [];
  return {
    folders: folders.map((f) => ({
      id: f.id,
      name: f.name,
      parentId: f.parentId ?? null,
    })),
    apps: appRows
      .filter((s) => (reach.get(s.id)?.length ?? 0) > 0)
      .map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        folderId: s.folderId ?? null,
        projectId: s.projectId ?? null,
        environmentId: s.environmentId ?? null,
        logo: s.logo ?? null,
        features: {
          pullRequests: s.source === "github" && s.previewEnabled,
          cronJobs: s.cronEnabled,
          console: s.consoleEnabled,
        },
      })),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    databases: databaseRows.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      logo: d.logo ?? null,
    })),
  };
}
