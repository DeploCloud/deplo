import "server-only";

import { eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  environments as environmentsTable,
  folders as foldersTable,
  projects as projectsTable,
} from "../../db/schema/control-plane/projects";
import {
  requireActiveTeamId,
  requireTeamWide,
  teamsForUser,
} from "../../membership";
import { visibleFolderIds } from "../folder-access";
import { appCapabilitiesForTeam } from "../node-access";
import { assertUser } from "../../auth/current-user";

export interface ScopeTreeApp {
  id: string;
  name: string;
  slug: string;
  // The app's own logo, when it has one. Null falls back to a generic glyph.
  logo: string | null;
}
export interface ScopeTreeFolder {
  id: string;
  name: string;
  color: string | null;
  folders: ScopeTreeFolder[];
  apps: ScopeTreeApp[];
}
// ScopeTreeEnvironment - an environment of a project, where an app lives inside
// it (ADR-0009). A sibling of the project's folders, never a parent of them.
export interface ScopeTreeEnvironment {
  id: string;
  name: string;
  isDefault: boolean;
  apps: ScopeTreeApp[];
}

export interface ScopeTreeProject {
  id: string;
  name: string;
  color: string | null;
  environments: ScopeTreeEnvironment[];
  folders: ScopeTreeFolder[];
  apps: ScopeTreeApp[];
}
export interface ScopeTreeTeam {
  id: string;
  name: string;
  // The team's picture, so the tree names it the way the switcher does.
  avatarUrl: string | null;
  projects: ScopeTreeProject[];
  // Folders at the team top level, in no project.
  folders: ScopeTreeFolder[];
  // Apps of this team in no folder and no project.
  looseApps: ScopeTreeApp[];
}

// listScopeTree - every team the CURRENT USER belongs to, with its projects, its
// folders and their apps: the tree the scope picker draws.
export async function listScopeTree(): Promise<ScopeTreeTeam[]> {
  // Deliberately NOT gated on `manage_tokens`: a member without it still opens a
  // token page (read-only, like the roles page), and the tree holds nothing they
  // can't already see.
  const user = await assertUser();
  await requireTeamWide("the token scope picker");
  // Their memberships bound WHICH teams; per-node access bounds what shows up inside
  // one.
  return buildScopeTree(await teamsForUser(user.id), { asCaller: true });
}

// listTeamScopeTree - the same tree narrowed to the ACTIVE team, what a ROLE
// editor draws, since a role belongs to exactly one team.
export async function listTeamScopeTree(): Promise<ScopeTreeTeam[]> {
  const teamId = await requireActiveTeamId();
  return (await listScopeTree()).filter((t) => t.id === teamId);
}

// buildScopeTree - the tree for an explicit set of teams.
export async function buildScopeTree(
  mine: { id: string; name: string; avatarUrl?: string | null }[],
  opts: { asCaller?: boolean } = {},
): Promise<ScopeTreeTeam[]> {
  if (mine.length === 0) return [];
  const teamIds = mine.map((t) => t.id);

  const db = getDb();
  const [projectRows, folderRows, appRows, envRows] = await Promise.all([
    db
      .select({
        id: projectsTable.id,
        teamId: projectsTable.teamId,
        name: projectsTable.name,
        color: projectsTable.color,
      })
      .from(projectsTable)
      .where(inArray(projectsTable.teamId, teamIds)),
    db
      .select({
        id: foldersTable.id,
        teamId: foldersTable.teamId,
        parentId: foldersTable.parentId,
        projectId: foldersTable.projectId,
        name: foldersTable.name,
        color: foldersTable.color,
      })
      .from(foldersTable)
      .where(inArray(foldersTable.teamId, teamIds)),
    db
      .select({
        id: appsTable.id,
        teamId: appsTable.teamId,
        projectId: appsTable.projectId,
        folderId: appsTable.folderId,
        environmentId: appsTable.environmentId,
        name: appsTable.name,
        slug: appsTable.slug,
        logo: appsTable.logo,
      })
      .from(appsTable)
      .where(inArray(appsTable.teamId, teamIds)),
    db
      .select({
        id: environmentsTable.id,
        projectId: environmentsTable.projectId,
        name: environmentsTable.name,
        isDefault: environmentsTable.isDefault,
        position: environmentsTable.position,
      })
      .from(environmentsTable)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, environmentsTable.projectId),
      )
      .where(inArray(projectsTable.teamId, teamIds)),
  ]);

  // Per-node visibility, when the tree is the CALLER's own picker: a folder they
  // can't see, and an app they hold nothing on, must not be listed - the same answer
  // `listFolders` and `listApps` give.
  const { folders: visibleFolders, apps: visibleApps } = opts.asCaller
    ? await visibleNodes(teamIds, folderRows, appRows)
    : { folders: null, apps: null };
  const folderVisible = (id: string) =>
    !visibleFolders || visibleFolders.has(id);
  const appVisible = (id: string) => !visibleApps || visibleApps.has(id);

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name);

  // Apps keyed by the ONE container they live in: a folder, else the ENVIRONMENT
  // of their project, else the project itself (legacy rows), else the team.
  const appsIn = new Map<string, ScopeTreeApp[]>();
  for (const a of appRows) {
    if (!appVisible(a.id)) continue;
    const key = a.folderId ?? a.environmentId ?? a.projectId ?? a.teamId;
    appsIn.set(key, [
      ...(appsIn.get(key) ?? []),
      { id: a.id, name: a.name, slug: a.slug, logo: a.logo ?? null },
    ]);
  }
  const subfoldersOf = new Map<string, typeof folderRows>();
  for (const f of folderRows)
    if (f.parentId && folderVisible(f.id))
      subfoldersOf.set(f.parentId, [
        ...(subfoldersOf.get(f.parentId) ?? []),
        f,
      ]);

  // Cycle-safe, like every other walk over this tree: a stale parent chain must
  // not hang the page.
  const build = (
    f: (typeof folderRows)[number],
    seen: Set<string>,
  ): ScopeTreeFolder => {
    seen.add(f.id);
    return {
      id: f.id,
      name: f.name,
      color: f.color ?? null,
      folders: (subfoldersOf.get(f.id) ?? [])
        .filter((c) => !seen.has(c.id))
        .sort(byName)
        .map((c) => build(c, seen)),
      apps: (appsIn.get(f.id) ?? []).sort(byName),
    };
  };
  const rootFolders = (
    predicate: (f: (typeof folderRows)[number]) => boolean,
  ) =>
    folderRows
      .filter((f) => !f.parentId && folderVisible(f.id) && predicate(f))
      .sort(byName)
      .map((f) => build(f, new Set()));

  return mine.map((t) => ({
    id: t.id,
    name: t.name,
    avatarUrl: t.avatarUrl ?? null,
    projects: projectRows
      .filter((p) => p.teamId === t.id)
      .sort(byName)
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color ?? null,
        // Environments first, in the order the project shows them: ADR-0009
        // makes the environment the primary axis of a project.
        environments: envRows
          .filter((e) => e.projectId === p.id)
          .sort((a, b) => a.position - b.position)
          .map((e) => ({
            id: e.id,
            name: e.name,
            isDefault: e.isDefault,
            apps: (appsIn.get(e.id) ?? []).sort(byName),
          })),
        folders: rootFolders((f) => f.projectId === p.id),
        // Legacy rows only: an app filed in a project before the environment
        // column existed. Everything newer sits under an environment above.
        apps: (appsIn.get(p.id) ?? []).sort(byName),
      })),
    folders: rootFolders((f) => f.teamId === t.id && !f.projectId),
    looseApps: (appsIn.get(t.id) ?? []).sort(byName),
  }));
}

// The folder and app ids the CURRENT caller may see, across several teams - the
// per-node half of the picker's bound.
async function visibleNodes(
  teamIds: string[],
  folderRows: { id: string; teamId: string }[],
  appRows: {
    id: string;
    teamId: string;
    projectId: string | null;
    folderId: string | null;
    // The environment is where an app inside a project actually lives, so a
    // placement without it is refused by an environment-shaped scope.
    environmentId?: string | null;
  }[],
): Promise<{ folders: Set<string>; apps: Set<string> }> {
  const folders = new Set<string>();
  const apps = new Set<string>();
  for (const teamId of teamIds) {
    try {
      const seen = await visibleFolderIds(teamId);
      for (const f of folderRows)
        if (f.teamId === teamId && (seen === "all" || seen.has(f.id)))
          folders.add(f.id);
      const reach = await appCapabilitiesForTeam(
        teamId,
        appRows
          .filter((a) => a.teamId === teamId)
          .map((a) => ({
            id: a.id,
            folderId: a.folderId ?? null,
            projectId: a.projectId ?? null,
            environmentId: a.environmentId ?? null,
          })),
      );
      for (const [id, caps] of reach) if (caps.length > 0) apps.add(id);
    } catch {
      // A team the caller can't currently resolve at all - an unmet two-factor
      // policy is the live example. It contributes nothing rather than taking
      // down the whole picker: they could not use that team's nodes anyway.
    }
  }
  return { folders, apps };
}
