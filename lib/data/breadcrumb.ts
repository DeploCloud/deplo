import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
} from "../db/schema/control-plane";
import {
  currentMemberScope,
  reachesWholeTeam,
  requireActiveTeamId,
} from "../membership";
import { listFolders } from "./folders";
import { appScopeWhere } from "./app-graph-load";
import { appInScope } from "./node-scope";
import { listProjects } from "./projects";
import type { BreadcrumbGraph } from "../breadcrumb-model";

/**
 * The lightweight team snapshot the topbar breadcrumb navigates over: every
 * VISIBLE folder (id/name/parentId), every team app reduced to its grouping links
 * (slug/name/folder/project/environment) plus the logo its menu entry wears, and
 */
export async function getBreadcrumbGraph(): Promise<BreadcrumbGraph> {
  const teamId = await requireActiveTeamId();
  // The apps here are queried directly rather than through `listApps`, so the role
  // scope has to be applied by hand - `appScopeWhere` answers for a token only.
  const roleScope = await currentMemberScope();
  // Storage is a TEAM-WIDE list (`requireTeamWide` in listDatabases), so a member
  // narrowed to part of the team sees none of it.
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
      .filter((s) =>
        appInScope(roleScope, {
          id: s.id,
          folderId: s.folderId ?? null,
          projectId: s.projectId ?? null,
          environmentId: s.environmentId ?? null,
        }),
      )
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
