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

// listAllServers returns every server by creation order (internal; NO auth gate).
export async function listAllServers(): Promise<Server[]> {
  const rows = await getDb()
    .select()
    .from(serversTable)
    .orderBy(asc(serversTable.createdAt));
  return rows.map(assembleServer);
}

// getServerById returns one server (internal; no auth gate). Null when unknown.
export async function getServerById(id: string): Promise<Server | null> {
  const rows = await getDb()
    .select()
    .from(serversTable)
    .where(eq(serversTable.id, id))
    .limit(1);
  return rows[0] ? assembleServer(rows[0]) : null;
}

// listServers is the public, TEAM-SCOPED read: every `all_teams` server plus the
// ones granted to the active team.
export async function listServers(): Promise<Server[]> {
  return listServersForCurrentTeam();
}

export async function getServer(id: string): Promise<Server | null> {
  // A point lookup answers NOT FOUND rather than "your token is limited", so a
  // narrowed scope can never become an oracle for which server ids exist.
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

// getPrimaryServer returns the default place to PUT something, or null when the
// operator has added no host yet - callers must tolerate null.
export async function getPrimaryServer(): Promise<Server | null> {
  // Team-scoped (the first server overall leaked an other-team-only one) and
  // filtered by role: a storage/build/import host would hand callers a target
  // that refuses the very thing they were about to do.
  const servers = await listServersForCurrentTeam();
  return servers.filter(canHostWorkloads)[0] ?? null;
}

// listServersForTeam returns the servers a team may target: every `all_teams`
// server plus the ones granted to it, in creation order.
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

// listServersForCurrentTeam is listServersForTeam for the caller's active team
// (asserts membership).
export async function listServersForCurrentTeam(): Promise<Server[]> {
  await requireTeamWide("servers");
  const teamId = await requireActiveTeamId();
  return listServersForTeam(teamId);
}

// listServerChoices is the server PICKER: id, name and type, and nothing else -
// a member who could create an app but never choose a host holds a dead capability.
export async function listServerChoices(): Promise<
  { id: string; name: string; type: Server["type"]; isDeploHost: boolean }[]
> {
  const teamId = await requireActiveTeamId();
  // Resolved once for the whole list: it walks the NICs.
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

// canHostWorkloads is the one predicate behind every deploy target picker and the
// server-side re-checks that back them up.
export function canHostWorkloads(s: Server): boolean {
  return !s.storageOnly && !s.buildOnly && !s.importOnly;
}

// assertNotMigrationSource refuses an action that treats a MIGRATION SOURCE as
// one of our servers.
export function assertNotMigrationSource(
  s: Pick<Server, "name" | "importOnly">,
): void {
  if (s.importOnly)
    throw new Error(
      `${s.name} is a migration source - Deplo only reads from it, it does not run it.`,
    );
}

// listBuildServerChoices is the BUILD SERVER picker: the hosts that can compile
// for another machine.
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

// serverIpForApp is the public address of the host ONE app runs on - the value a
// custom domain's A record has to point at.
export async function serverIpForApp(appId: string): Promise<string> {
  const reach = await appCapabilities(appId);
  if (reach.length === 0) return resolveServerIp(undefined);
  const rows = await getDb()
    .select({ ip: serversTable.ip, host: serversTable.host })
    .from(appsTable)
    .innerJoin(serversTable, eq(serversTable.id, appsTable.serverId))
    .where(eq(appsTable.id, appId))
    .limit(1);
  // `resolveServerIp` already has the fallback for a host with no address
  // recorded, so this returns the same shape the fleet read did.
  return resolveServerIp({ ip: rows[0]?.ip ?? undefined });
}

// ServerRole is what a server is FOR.
export type ServerRole = "everything" | "build" | "storage" | "import";

// SERVER_ROLES is every role the wire may name (the arg is a plain string).
export const SERVER_ROLES: readonly ServerRole[] = [
  "everything",
  "build",
  "storage",
  "import",
];

// serverRole reads the stored flags as one word.
export function serverRole(
  s: Pick<Server, "storageOnly" | "buildOnly" | "importOnly">,
): ServerRole {
  if (s.importOnly) return "import";
  if (s.storageOnly) return "storage";
  if (s.buildOnly) return "build";
  return "everything";
}

// requireAdminServer is the admin gate + actor + server read every server
// mutation opens with, in that order.
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
