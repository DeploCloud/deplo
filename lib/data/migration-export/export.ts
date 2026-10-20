import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
} from "../../db/schema/control-plane/access-control";
import { backupDestination as destTable } from "../../db/schema/control-plane/backups";
import {
  gitConnections as gitTable,
  registries as registriesTable,
} from "../../db/schema/control-plane/integrations";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import {
  teams as teamsTable,
  users as usersTable,
} from "../../db/schema/control-plane/identity";
import {
  environments as environmentsTable,
  folders as foldersTable,
  projects as projectsTable,
} from "../../db/schema/control-plane/projects";
import { teamProjectOrder } from "../../db/schema/control-plane/display-order";
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
  type DeploExportGitConnection,
  type DeploExportRegistry,
  type DeploExportServerDestination,
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

async function destinations(
  teamId: string,
  withKeys: boolean,
): Promise<{
  buckets: DeploExportDestination[];
  disks: DeploExportServerDestination[];
}> {
  const rows = await getDb()
    .select({ d: destTable, serverName: serversTable.name })
    .from(destTable)
    .leftJoin(serversTable, eq(serversTable.id, destTable.serverId))
    .where(eq(destTable.teamId, teamId));
  const buckets: DeploExportDestination[] = [];
  const disks: DeploExportServerDestination[] = [];
  for (const row of rows) {
    const d = assembleDestination(row.d);
    // Left out when it will not open or the reader may not see it: the target knows it was not told.
    const ageIdentity = !withKeys
      ? undefined
      : d.ageIdentityEnc
        ? opened(d.ageIdentityEnc) || undefined
        : null;
    if (d.kind === "server") {
      if (d.serverId)
        disks.push({
          name: d.name,
          serverId: d.serverId,
          serverName: row.serverName ?? null,
          path: d.path,
          ...(ageIdentity ? { ageIdentity } : {}),
        });
      continue;
    }
    const accessKeyId = opened(d.accessKeyEnc);
    const secretAccessKey = opened(d.secretKeyEnc);
    if (!d.endpoint || !d.bucket || !accessKeyId || !secretAccessKey) continue;
    buckets.push({
      name: d.name,
      endpoint: d.endpoint,
      bucket: d.bucket,
      region: d.region || "us-east-1",
      accessKeyId,
      secretAccessKey,
      ...(d.provider ? { provider: d.provider } : {}),
      ...(ageIdentity !== undefined ? { ageIdentity } : {}),
    });
  }
  return { buckets, disks };
}

// A token is revealed on the same terms as editing the connection that holds it.
async function gitConnections(
  teamId: string,
  withTokens: boolean,
): Promise<DeploExportGitConnection[]> {
  const rows = await getDb()
    .select()
    .from(gitTable)
    .where(eq(gitTable.teamId, teamId));
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    label: r.label,
    baseUrl: r.baseUrl,
    allowPrivateEndpoint: r.allowPrivateEndpoint,
    username: r.username,
    token: withTokens ? opened(r.tokenEnc) || null : null,
  }));
}

async function registries(
  teamId: string,
  withPasswords: boolean,
): Promise<DeploExportRegistry[]> {
  const rows = await getDb()
    .select()
    .from(registriesTable)
    .where(eq(registriesTable.teamId, teamId));
  return rows.map((r) => ({
    name: r.name,
    type: r.type,
    registryUrl: r.registryUrl,
    username: r.username,
    password: withPasswords ? opened(r.passwordEnc) || null : null,
  }));
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
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      color: projectsTable.color,
      position: teamProjectOrder.position,
    })
    .from(projectsTable)
    .leftJoin(
      teamProjectOrder,
      and(
        eq(teamProjectOrder.projectId, projectsTable.id),
        eq(teamProjectOrder.teamId, teamId),
      ),
    )
    .where(eq(projectsTable.teamId, teamId))
    .orderBy(
      sql`${teamProjectOrder.position} asc nulls last`,
      asc(projectsTable.name),
    );
  const environments = projects.length
    ? await db
        .select({
          id: environmentsTable.id,
          projectId: environmentsTable.projectId,
          name: environmentsTable.name,
          isDefault: environmentsTable.isDefault,
          kind: environmentsTable.kind,
          gitBranch: environmentsTable.gitBranch,
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
    git,
    pulls,
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
    // The recovery key is revealed on the same terms as revealRecoveryKey.
    hasCapability("manage_backup_destinations").then((may) =>
      destinations(teamId, may),
    ),
    teamsForUser(userId),
    hasCapability("control_apps"),
    hasCapability("control_databases"),
    visibleFolderIds(teamId),
    hasCapability("manage_git").then((may) => gitConnections(teamId, may)),
    hasCapability("manage_registries").then((may) => registries(teamId, may)),
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
      color: p.color,
      environments: environments
        .filter((e) => e.projectId === p.id)
        .sort((a, b) => a.position - b.position)
        .map((e) => ({
          id: e.id,
          name: e.name,
          isDefault: e.isDefault,
          kind: e.kind,
          gitBranch: e.gitBranch,
        })),
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
    destinations: stores.buckets,
    serverDestinations: stores.disks,
    gitConnections: git,
    registries: pulls,
  };
}
