import "server-only";

import { and, asc, eq, inArray, or } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  serverTeams as serverTeamsTable,
  servers as serversTable,
} from "../../db/schema/control-plane/servers";
import { assembleServer } from "../infra-rows";
import { appCapabilities } from "../node-access";
import {
  deploHostSelfAddresses,
  isBuildFallbackServer,
  isDeploHostServer,
  resolveServerIp,
} from "../../deploy/domains";
import { getCurrentUser } from "../../auth/current-user";
import {
  reachesWholeTeam,
  requireActiveTeamId,
  requireInstanceAdmin,
  requireTeamWide,
} from "../../membership";
import { narrowedScope } from "../../auth/request-context";
import type { Server } from "../../types/server";

export async function listAllServers(): Promise<Server[]> {
  const rows = await getDb()
    .select()
    .from(serversTable)
    .orderBy(asc(serversTable.createdAt));
  return rows.map(assembleServer);
}

export async function getServerById(id: string): Promise<Server | null> {
  const rows = await getDb()
    .select()
    .from(serversTable)
    .where(eq(serversTable.id, id))
    .limit(1);
  return rows[0] ? assembleServer(rows[0]) : null;
}

export async function listServers(): Promise<Server[]> {
  return listServersForCurrentTeam();
}

export async function getServer(id: string): Promise<Server | null> {
  if (narrowedScope()) return null;
  if (!(await reachesWholeTeam())) return null;
  const teamId = await requireActiveTeamId();
  const server = await getServerById(id);
  if (!server) return null;
  if (server.allTeams) return server;
  const granted = await getDb()
    .select({ teamId: serverTeamsTable.teamId })
    .from(serverTeamsTable)
    .where(
      and(
        eq(serverTeamsTable.serverId, id),
        eq(serverTeamsTable.teamId, teamId),
      ),
    )
    .limit(1);
  return granted.length > 0 ? server : null;
}

export async function getPrimaryServer(): Promise<Server | null> {
  const servers = await listServersForCurrentTeam();
  return servers.filter(canHostWorkloads)[0] ?? null;
}

export async function listServersForTeam(teamId: string): Promise<Server[]> {
  const db = getDb();
  const grantedToTeam = db
    .select({ id: serverTeamsTable.serverId })
    .from(serverTeamsTable)
    .where(eq(serverTeamsTable.teamId, teamId));
  const rows = await db
    .select()
    .from(serversTable)
    .where(
      or(
        eq(serversTable.allTeams, true),
        inArray(serversTable.id, grantedToTeam),
      ),
    )
    .orderBy(asc(serversTable.createdAt));
  return rows.map(assembleServer);
}

export async function listServersForCurrentTeam(): Promise<Server[]> {
  await requireTeamWide("servers");
  const teamId = await requireActiveTeamId();
  return listServersForTeam(teamId);
}

export async function listServerChoices(): Promise<
  { id: string; name: string; type: Server["type"]; isDeploHost: boolean }[]
> {
  const teamId = await requireActiveTeamId();
  const self = deploHostSelfAddresses();
  return (await listServersForTeam(teamId))
    .filter(canHostWorkloads)
    .map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      isDeploHost: isDeploHostServer(s, self),
    }));
}

export function canHostWorkloads(s: Server): boolean {
  return !s.storageOnly && !s.buildOnly && !s.importOnly;
}

export function assertNotMigrationSource(
  s: Pick<Server, "name" | "importOnly">,
): void {
  if (s.importOnly)
    throw new Error(
      `${s.name} is a migration source - Deplo only reads from it, it does not run it.`,
    );
}

export async function listBuildServerChoices(): Promise<
  {
    id: string;
    name: string;
    hostArch: string;
    buildOnly: boolean;
    buildFallback: boolean;
    isDeploHost: boolean;
  }[]
> {
  const teamId = await requireActiveTeamId();
  const self = deploHostSelfAddresses();
  return (await listServersForTeam(teamId))
    .filter((s) => !s.storageOnly && !s.importOnly)
    .map((s) => ({
      id: s.id,
      name: s.name,
      hostArch: s.hostArch,
      buildOnly: s.buildOnly,
      buildFallback: isBuildFallbackServer(s, self),
      isDeploHost: isDeploHostServer(s, self),
    }));
}

export async function serverIpForApp(appId: string): Promise<string> {
  const reach = await appCapabilities(appId);
  if (reach.length === 0) return resolveServerIp(undefined);
  const rows = await getDb()
    .select({ ip: serversTable.ip, host: serversTable.host })
    .from(appsTable)
    .innerJoin(serversTable, eq(serversTable.id, appsTable.serverId))
    .where(eq(appsTable.id, appId))
    .limit(1);
  return resolveServerIp({ ip: rows[0]?.ip ?? undefined });
}

export type ServerRole = "everything" | "build" | "storage" | "import";

export const SERVER_ROLES: readonly ServerRole[] = [
  "everything",
  "build",
  "storage",
  "import",
];

export function serverRole(
  s: Pick<Server, "storageOnly" | "buildOnly" | "importOnly">,
): ServerRole {
  if (s.importOnly) return "import";
  if (s.storageOnly) return "storage";
  if (s.buildOnly) return "build";
  return "everything";
}

export async function requireAdminServer(id: string): Promise<{
  teamId: string;
  user: { name: string };
  server: Server;
}> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");
  return { teamId, user, server };
}
