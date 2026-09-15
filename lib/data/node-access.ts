import "server-only";

import { cache } from "@/lib/request-cache";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  appGrants as appGrantsTable,
  environmentGrants as environmentGrantsTable,
  folderGrants as folderGrantsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  memberships as membershipsTable,
  projectGrants as projectGrantsTable,
} from "../db/schema/control-plane/access-control";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { users as usersTable } from "../db/schema/control-plane/identity";
import {
  environments as environmentsTable,
  folders as foldersTable,
  projects as projectsTable,
} from "../db/schema/control-plane/projects";
import { getCurrentUser } from "../auth/current-user";
import {
  clampCapabilitiesToToken,
  getActiveTeamId,
  isInstanceAdmin,
  membershipFor,
  requireMembership,
  type ActiveMembership,
} from "../membership";
import { inAppScope } from "../auth/request-context";
import {
  appInScope,
  environmentInScope,
  folderInScope,
  projectInScope,
  memberScopeFor,
  type NodeScope,
} from "./node-scope";
import { CAPABILITY_META } from "../membership-shared";
import { assertNotMigrating } from "./migration-guard";
import { ALL_CAPABILITIES, type Capability } from "../types/identity";

export type NodeRef =
  | { kind: "app"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "environment"; id: string }
  | { kind: "project"; id: string };

export interface AppPlacement {
  id: string;
  folderId: string | null;
  projectId: string | null;
  environmentId?: string | null;
}

interface GrantIndex {
  teamId: string;
  userId: string;
  base: Capability[];
  superUser: boolean;
  instanceAdmin: boolean;
  roleScope: NodeScope | null;
  folders: Map<
    string,
    {
      parentId: string | null;
      projectId: string | null;
      ownerUserId: string | null;
    }
  >;
  projectOwners: Map<string, string | null>;
  environmentProjects: Map<string, string>;
  folderGrants: Map<string, Capability[]>;
  environmentGrants: Map<string, Capability[]>;
  projectGrants: Map<string, Capability[]>;
  appGrants: Map<string, Capability[]>;
}

export function withView(caps: Capability[]): Capability[] {
  const set = new Set<Capability>(caps);
  set.add("view");
  return ALL_CAPABILITIES.filter((c) => set.has(c));
}

function groupCaps<T extends { key: string; capability: string }>(
  rows: T[],
): Map<string, Capability[]> {
  const out = new Map<string, Capability[]>();
  for (const r of rows) {
    const list = out.get(r.key) ?? [];
    list.push(r.capability as Capability);
    out.set(r.key, list);
  }
  return out;
}

const buildIndex = cache(async function buildIndex(
  userId: string,
  teamId: string,
  admin: boolean,
): Promise<GrantIndex | null> {
  // THE gate, first and always: membership existence carries the two-factor policy, and nothing below survives it.
  const membership = await membershipFor(userId, teamId);
  const base = membership?.capabilities ?? [];
  if (!admin && base.length === 0) return null;

  const db = getDb();
  const [
    folderRows,
    projectRows,
    fGrants,
    pGrants,
    aGrants,
    superUser,
    roleScope,
    envRows,
    eGrants,
  ] = await Promise.all([
    db
      .select({
        id: foldersTable.id,
        parentId: foldersTable.parentId,
        projectId: foldersTable.projectId,
        ownerUserId: foldersTable.ownerUserId,
      })
      .from(foldersTable)
      .where(eq(foldersTable.teamId, teamId)),
    db
      .select({ id: projectsTable.id, ownerUserId: projectsTable.ownerUserId })
      .from(projectsTable)
      .where(eq(projectsTable.teamId, teamId)),
    db
      .select({
        key: folderGrantsTable.folderId,
        capability: folderGrantsTable.capability,
      })
      .from(folderGrantsTable)
      .innerJoin(foldersTable, eq(foldersTable.id, folderGrantsTable.folderId))
      .where(
        and(
          eq(folderGrantsTable.userId, userId),
          eq(foldersTable.teamId, teamId),
        ),
      ),
    db
      .select({
        key: projectGrantsTable.projectId,
        capability: projectGrantsTable.capability,
      })
      .from(projectGrantsTable)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, projectGrantsTable.projectId),
      )
      .where(
        and(
          eq(projectGrantsTable.userId, userId),
          eq(projectsTable.teamId, teamId),
        ),
      ),
    db
      .select({
        key: appGrantsTable.appId,
        capability: appGrantsTable.capability,
      })
      .from(appGrantsTable)
      .innerJoin(appsTable, eq(appsTable.id, appGrantsTable.appId))
      .where(
        and(eq(appGrantsTable.userId, userId), eq(appsTable.teamId, teamId)),
      ),
    holdsManageTeam(userId, teamId),
    memberScopeFor(userId, teamId),
    db
      .select({
        id: environmentsTable.id,
        projectId: environmentsTable.projectId,
      })
      .from(environmentsTable)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, environmentsTable.projectId),
      )
      .where(eq(projectsTable.teamId, teamId)),
    db
      .select({
        key: environmentGrantsTable.environmentId,
        capability: environmentGrantsTable.capability,
      })
      .from(environmentGrantsTable)
      .innerJoin(
        environmentsTable,
        eq(environmentsTable.id, environmentGrantsTable.environmentId),
      )
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, environmentsTable.projectId),
      )
      .where(
        and(
          eq(environmentGrantsTable.userId, userId),
          eq(projectsTable.teamId, teamId),
        ),
      ),
  ]);

  return {
    teamId,
    userId,
    base,
    superUser: admin || superUser,
    instanceAdmin: admin,
    roleScope,
    folders: new Map(
      folderRows.map((f) => [
        f.id,
        {
          parentId: f.parentId ?? null,
          projectId: f.projectId ?? null,
          ownerUserId: f.ownerUserId ?? null,
        },
      ]),
    ),
    projectOwners: new Map(
      projectRows.map((p) => [p.id, p.ownerUserId ?? null]),
    ),
    environmentProjects: new Map(envRows.map((e) => [e.id, e.projectId])),
    folderGrants: groupCaps(fGrants),
    environmentGrants: groupCaps(eGrants),
    projectGrants: groupCaps(pGrants),
    appGrants: groupCaps(aGrants),
  };
});

export async function holdsManageTeam(
  userId: string,
  teamId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ capability: membershipCapabilitiesTable.capability })
    .from(membershipCapabilitiesTable)
    .innerJoin(
      membershipsTable,
      eq(membershipsTable.id, membershipCapabilitiesTable.membershipId),
    )
    .where(
      and(
        eq(membershipsTable.userId, userId),
        eq(membershipsTable.teamId, teamId),
        eq(membershipCapabilitiesTable.capability, "manage_team"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function teamOf(node: NodeRef): Promise<string | null> {
  const db = getDb();
  if (node.kind === "environment") {
    const rows = await db
      .select({ teamId: projectsTable.teamId })
      .from(environmentsTable)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, environmentsTable.projectId),
      )
      .where(eq(environmentsTable.id, node.id))
      .limit(1);
    return rows[0]?.teamId ?? null;
  }
  const table =
    node.kind === "app"
      ? appsTable
      : node.kind === "folder"
        ? foldersTable
        : projectsTable;
  const rows = await db
    .select({ teamId: table.teamId })
    .from(table)
    .where(eq(table.id, node.id))
    .limit(1);
  return rows[0]?.teamId ?? null;
}

function ladder(
  index: GrantIndex,
  node: {
    kind: NodeRef["kind"];
    id: string;
    folderId?: string | null;
    projectId?: string | null;
    environmentId?: string | null;
  },
): {
  kind: NodeRef["kind"];
  id: string;
  owner: boolean;
  grants: Capability[];
}[] {
  const rungs: {
    kind: NodeRef["kind"];
    id: string;
    owner: boolean;
    grants: Capability[];
  }[] = [];
  let projectId = node.projectId ?? null;

  if (node.kind === "app") {
    rungs.push({
      kind: "app",
      id: node.id,
      owner: false,
      grants: index.appGrants.get(node.id) ?? [],
    });
  }

  const environmentId =
    node.kind === "environment" ? node.id : (node.environmentId ?? null);
  if (environmentId && node.kind !== "folder") {
    rungs.push({
      kind: "environment",
      id: environmentId,
      owner: false,
      grants: index.environmentGrants.get(environmentId) ?? [],
    });
    projectId = index.environmentProjects.get(environmentId) ?? projectId;
  }

  const start = node.kind === "folder" ? node.id : (node.folderId ?? null);
  const seen = new Set<string>();
  let cursor: string | null = start;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const f = index.folders.get(cursor);
    if (!f) break;
    rungs.push({
      kind: "folder",
      id: cursor,
      owner: f.ownerUserId === index.userId,
      grants: index.folderGrants.get(cursor) ?? [],
    });
    if (!projectId && f.projectId) projectId = f.projectId;
    cursor = f.parentId;
  }

  if (node.kind === "project") projectId = node.id;
  if (projectId && index.projectOwners.has(projectId)) {
    rungs.push({
      kind: "project",
      id: projectId,
      owner: index.projectOwners.get(projectId) === index.userId,
      grants: index.projectGrants.get(projectId) ?? [],
    });
  }
  return rungs;
}

function hasOwnGrant(
  index: GrantIndex,
  node: {
    kind: NodeRef["kind"];
    id: string;
    folderId?: string | null;
    projectId?: string | null;
    environmentId?: string | null;
  },
): boolean {
  return ladder(index, node).some((r) => r.owner || r.grants.length > 0);
}

function reachesNode(
  index: GrantIndex,
  node: {
    kind: NodeRef["kind"];
    id: string;
    folderId?: string | null;
    projectId?: string | null;
    environmentId?: string | null;
  },
): boolean {
  if (index.instanceAdmin || !index.roleScope) return true;
  if (node.kind === "app")
    return appInScope(index.roleScope, {
      id: node.id,
      folderId: node.folderId ?? null,
      projectId: node.projectId ?? null,
      environmentId: node.environmentId ?? null,
    });
  if (node.kind === "folder") return folderInScope(index.roleScope, node.id);
  if (node.kind === "environment")
    return (
      environmentInScope(index.roleScope, node.id) ||
      projectInScope(
        index.roleScope,
        index.environmentProjects.get(node.id) ?? null,
      )
    );
  return projectInScope(index.roleScope, node.id);
}

function resolveFrom(
  index: GrantIndex,
  node: {
    kind: NodeRef["kind"];
    id: string;
    folderId?: string | null;
    projectId?: string | null;
    environmentId?: string | null;
  },
): Capability[] {
  const clamp = (caps: Capability[]) =>
    withView(clampCapabilitiesToToken(caps, index.userId, index.teamId));

  if (!reachesNode(index, node) && !hasOwnGrant(index, node)) return [];

  if (index.superUser) {
    return clamp(index.base.length === 0 ? [...ALL_CAPABILITIES] : index.base);
  }

  const rungs = ladder(index, node);

  const folders = rungs.filter((r) => r.kind === "folder");
  if (
    folders.length > 0 &&
    !folders.some(
      (r) =>
        r.owner ||
        r.grants.length > 0 ||
        // Not folderInScope: a null scope means unrestricted, which must not dissolve folder privacy.
        Boolean(index.roleScope?.folderIds.includes(r.id)),
    )
  ) {
    return [];
  }

  // Most specific wins, and a node's grants REPLACE the team role's set inside it rather than adding to it (ADR-0016).
  for (const rung of rungs) {
    if (rung.owner) return clamp(index.base);
    if (rung.grants.length > 0) return clamp(rung.grants);
  }
  return clamp(index.base);
}

async function storedInstanceAdmin(userId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ isInstanceAdmin: usersTable.isInstanceAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return Boolean(rows[0]?.isInstanceAdmin);
}

async function resolveOne(
  userId: string,
  node: NodeRef,
  admin: boolean,
  activeTeamId: string,
): Promise<Capability[]> {
  const teamId = await teamOf(node);
  if (!teamId || teamId !== activeTeamId) return [];
  const index = await buildIndex(userId, teamId, admin);
  if (!index) return [];

  if (node.kind !== "app") return resolveFrom(index, node);
  const rows = await getDb()
    .select({
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
    })
    .from(appsTable)
    .where(eq(appsTable.id, node.id))
    .limit(1);
  return resolveFrom(index, {
    kind: "app",
    id: node.id,
    folderId: rows[0]?.folderId ?? null,
    projectId: rows[0]?.projectId ?? null,
    environmentId: rows[0]?.environmentId ?? null,
  });
}

export async function nodeCapabilities(node: NodeRef): Promise<Capability[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  const activeTeamId = await getActiveTeamId();
  if (!activeTeamId) return [];
  return resolveOne(user.id, node, await isInstanceAdmin(), activeTeamId);
}

// Kept apart from nodeCapabilities on purpose: a nullable userId meaning skip-the-check is how the hole comes back.
export async function nodeCapabilitiesFor(
  userId: string,
  teamId: string,
  node: NodeRef,
): Promise<Capability[]> {
  return resolveOne(userId, node, await storedInstanceAdmin(userId), teamId);
}

export async function appCapabilitiesForTeam(
  teamId: string,
  apps: AppPlacement[],
): Promise<Map<string, Capability[]>> {
  const out = new Map<string, Capability[]>();
  const user = await getCurrentUser();
  if (!user || apps.length === 0) return out;
  const index = await buildIndex(user.id, teamId, await isInstanceAdmin());
  if (!index) return out;
  for (const app of apps) {
    out.set(app.id, resolveFrom(index, { kind: "app", ...app }));
  }
  return out;
}

export async function requireNodeCapability(
  node: NodeRef,
  cap: Capability,
): Promise<void> {
  const caps = await nodeCapabilities(node);
  const label =
    node.kind === "app" ? "App" : node.kind === "folder" ? "Folder" : "Project";
  if (caps.length === 0) throw new Error(`${label} not found`);
  if (!caps.includes(cap)) {
    throw new Error(
      `You don't have permission to ${CAPABILITY_META[cap].label.toLowerCase()} here`,
    );
  }
}

export async function requireAppCapability(
  appId: string,
  cap: Capability,
): Promise<ActiveMembership> {
  const gate = await appGate(appId);
  if (!gate || gate.caps.length === 0) throw new Error("App not found");
  if (gate.deleting) throw new Error("This app is being deleted");
  assertNotMigrating("app", gate.name, gate.migrationRunId);
  if (!gate.caps.includes(cap)) {
    throw new Error(
      gate.folderId
        ? `You don't have permission to ${CAPABILITY_META[cap].label.toLowerCase()} in this folder`
        : `You don't have permission to ${CAPABILITY_META[cap].label.toLowerCase()}`,
    );
  }
  return gate.ctx;
}

export const appCapabilities = cache(async function appCapabilities(
  appId: string,
): Promise<Capability[]> {
  try {
    return (await appGate(appId))?.caps ?? [];
  } catch {
    return [];
  }
});

export async function hasAppCapability(
  appId: string,
  cap: Capability,
): Promise<boolean> {
  return (await appCapabilities(appId)).includes(cap);
}

async function appGate(appId: string): Promise<{
  ctx: ActiveMembership;
  folderId: string | null;
  caps: Capability[];
  deleting: boolean;
  name: string;
  migrationRunId: string | null;
} | null> {
  const ctx = await requireMembership();
  const rows = await getDb()
    .select({
      teamId: appsTable.teamId,
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      deletingAt: appsTable.deletingAt,
      name: appsTable.name,
      migrationRunId: appsTable.migrationRunId,
      environmentId: appsTable.environmentId,
    })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  const app = rows[0];
  if (
    !app ||
    app.teamId !== ctx.teamId ||
    !inAppScope({ id: appId, folderId: app.folderId, projectId: app.projectId })
  ) {
    return null;
  }
  const caps = await appCapabilitiesForTeam(ctx.teamId, [
    {
      id: appId,
      folderId: app.folderId ?? null,
      projectId: app.projectId ?? null,
      environmentId: app.environmentId ?? null,
    },
  ]);
  return {
    ctx,
    folderId: app.folderId ?? null,
    caps: caps.get(appId) ?? [],
    deleting: app.deletingAt != null,
    name: app.name,
    migrationRunId: app.migrationRunId ?? null,
  };
}
