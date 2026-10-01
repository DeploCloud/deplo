import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
} from "../../db/schema/control-plane/access-control";
import { backupDestination as destTable } from "../../db/schema/control-plane/backups";
import {
  teams as teamsTable,
  users as usersTable,
} from "../../db/schema/control-plane/identity";
import {
  environments as environmentsTable,
  folders as foldersTable,
  projects as projectsTable,
} from "../../db/schema/control-plane/projects";
import { getCurrentUser } from "../../auth/current-user";
import { tryDecryptSecret } from "../../crypto";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "../../deploy/domains";
import {
  hasCapability,
  requireCapability,
  requireTeamWide,
  teamsForUser,
} from "../../membership";
import {
  DEPLO_EXPORT_VERSION,
  type DeploExport,
  type DeploExportDestination,
  type DeploExportSharedVar,
} from "../../migration/deplo/export-shape";
import { instanceFingerprint } from "../../migration/deplo/instance";
import { sweepStale } from "../../stale-sweep";
import { recordActivity } from "../activity";
import { assembleDestination } from "../backup-rows";
import { visibleFolderIds } from "../folder-access";
import { listServersForTeam } from "../servers/roster";
import { loadVisibleToTeam } from "../shared-vars/visibility";
import { exportApps, exportDatabases } from "./workloads";

export async function assertExportGate(): Promise<{
  teamId: string;
  userId: string;
}> {
  await requireTeamWide("a team export");
  return requireCapability("reveal_secrets");
}

// A migration reads the export several times; one Activity line per sitting is the useful record.
const TRAIL_EVERY_MS = 10 * 60_000;
const trailedAt = new Map<string, number>();

async function trailExport(teamId: string, userId: string): Promise<void> {
  const now = Date.now();
  const key = `${teamId}:${userId}`;
  if ((trailedAt.get(key) ?? 0) > now - TRAIL_EVERY_MS) return;
  trailedAt.set(key, now);
  sweepStale(trailedAt, (t) => t, TRAIL_EVERY_MS, now);
  await recordActivity(
    "security",
    "Read this team, secrets included, to move it to another Deplo",
    (await getCurrentUser())?.name ?? "someone",
    null,
    teamId,
  );
}

export function __resetExportTrailForTest(): void {
  trailedAt.clear();
}

function opened(enc: string | null): string {
  if (!enc) return "";
  const res = tryDecryptSecret(enc);
  return res.ok ? res.value : "";
}

async function sharedVars(teamId: string): Promise<DeploExportSharedVar[]> {
  return (await loadVisibleToTeam(teamId)).flatMap((v) => {
    const value = tryDecryptSecret(v.valueEnc);
    if (!value.ok) return [];
    const own = v.teamId === teamId;
    return [
      {
        key: v.key,
        value: value.value,
        secret: v.type === "secret",
        targets: v.targets,
        teamWide: v.teamIds.includes(teamId),
        autoInject: v.autoInject && v.teamIds.includes(teamId),
        projectIds: own ? v.projectIds : [],
        environmentIds: own ? v.environmentIds : [],
        appIds: own ? v.appIds : [],
      },
    ];
  });
}

async function members(teamId: string): Promise<DeploExport["members"]> {
  const rows = await getDb()
    .select({
      email: usersTable.email,
      name: usersTable.name,
      rank: membershipsTable.role,
      roleName: teamRolesTable.name,
    })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
    .leftJoin(teamRolesTable, eq(teamRolesTable.id, membershipsTable.roleId))
    .where(eq(membershipsTable.teamId, teamId));
  return rows.map((r) => ({
    email: r.email,
    name: r.name || null,
    role: r.roleName ?? r.rank,
  }));
}

async function destinations(teamId: string): Promise<DeploExportDestination[]> {
  const rows = await getDb()
    .select()
    .from(destTable)
    .where(and(eq(destTable.teamId, teamId), eq(destTable.kind, "s3")));
  return rows.map(assembleDestination).flatMap((d) => {
    const accessKeyId = opened(d.accessKeyEnc);
    const secretAccessKey = opened(d.secretKeyEnc);
    if (!d.endpoint || !d.bucket || !accessKeyId || !secretAccessKey) return [];
    return [
      {
        name: d.name,
        endpoint: d.endpoint,
        bucket: d.bucket,
        region: d.region || "us-east-1",
        accessKeyId,
        secretAccessKey,
      },
    ];
  });
}

export async function exportTeamForMigration(): Promise<DeploExport> {
  const { teamId, userId } = await assertExportGate();
  const db = getDb();

  const [team] = await db
    .select({ id: teamsTable.id, name: teamsTable.name, slug: teamsTable.slug })
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  if (!team) throw new Error("Not found");

  const projects = await db
    .select({ id: projectsTable.id, name: projectsTable.name })
    .from(projectsTable)
    .where(eq(projectsTable.teamId, teamId));
  const environments = projects.length
    ? await db
        .select({
          id: environmentsTable.id,
          projectId: environmentsTable.projectId,
          name: environmentsTable.name,
          isDefault: environmentsTable.isDefault,
          position: environmentsTable.position,
        })
        .from(environmentsTable)
        .where(
          inArray(
            environmentsTable.projectId,
            projects.map((p) => p.id),
          ),
        )
    : [];

  const [
    folders,
    { apps, withheld },
    databases,
    shared,
    servers,
    people,
    stores,
    teams,
    controlApps,
    controlDatabases,
    visibleFolders,
  ] = await Promise.all([
    db
      .select({
        id: foldersTable.id,
        name: foldersTable.name,
        parentId: foldersTable.parentId,
      })
      .from(foldersTable)
      .where(eq(foldersTable.teamId, teamId)),
    exportApps(teamId),
    exportDatabases(teamId),
    sharedVars(teamId),
    listServersForTeam(teamId),
    members(teamId),
    destinations(teamId),
    teamsForUser(userId),
    hasCapability("control_apps"),
    hasCapability("control_databases"),
    visibleFolderIds(teamId),
  ]);

  await trailExport(teamId, userId);
  const self = deploHostSelfAddresses();

  return {
    version: DEPLO_EXPORT_VERSION,
    instance: instanceFingerprint(),
    team,
    otherTeams: teams.filter((t) => t.id !== teamId).map((t) => t.name),
    canControl: { apps: controlApps, databases: controlDatabases },
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      environments: environments
        .filter((e) => e.projectId === p.id)
        .sort((a, b) => a.position - b.position)
        .map((e) => ({ id: e.id, name: e.name, isDefault: e.isDefault })),
    })),
    folders: folders.filter(
      (f) => visibleFolders === "all" || visibleFolders.has(f.id),
    ),
    apps,
    withheld,
    databases,
    sharedVars: shared,
    servers: servers
      .filter((s) => !s.storageOnly && !s.importOnly)
      .map((s) => ({
        id: s.id,
        name: s.name,
        address: s.ip?.trim() || s.host?.trim() || null,
        isDeploHost: isDeploHostServer(s, self),
      })),
    members: people,
    destinations: stores,
  };
}
