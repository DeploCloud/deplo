import "server-only";

import { and, asc, eq, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
} from "../db/schema/control-plane/access-control";
import { teams as teamsTable } from "../db/schema/control-plane/identity";
import {
  servers as serversTable,
  serverTeams as serverTeamsTable,
} from "../db/schema/control-plane/servers";
import { currentIdentity } from "../auth/request-context";
import { holdsTeamWideCapability, membershipFor } from "../membership";
import type { Capability } from "../types/identity";

// The other teams this user could hand a resource to: member there with `cap`.
export async function transferCandidates(
  userId: string,
  fromTeamId: string,
  cap: Capability,
): Promise<{ id: string; name: string; image: string | null }[]> {
  return getDb()
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      image: teamsTable.image,
    })
    .from(membershipsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, membershipsTable.teamId))
    .innerJoin(
      membershipCapabilitiesTable,
      and(
        eq(membershipCapabilitiesTable.membershipId, membershipsTable.id),
        eq(membershipCapabilitiesTable.capability, cap),
      ),
    )
    .where(
      and(
        eq(membershipsTable.userId, userId),
        ne(membershipsTable.teamId, fromTeamId),
      ),
    )
    .orderBy(asc(teamsTable.name));
}

// null = the server is shared with every team.
export async function serverAccess(serverId: string): Promise<{
  name: string;
  teamIds: Set<string> | null;
}> {
  const db = getDb();
  const server = (
    await db
      .select({ name: serversTable.name, allTeams: serversTable.allTeams })
      .from(serversTable)
      .where(eq(serversTable.id, serverId))
      .limit(1)
  )[0];
  if (!server || server.allTeams)
    return { name: server?.name ?? "its server", teamIds: null };
  const rows = await db
    .select({ teamId: serverTeamsTable.teamId })
    .from(serverTeamsTable)
    .where(eq(serverTeamsTable.serverId, serverId));
  return { name: server.name, teamIds: new Set(rows.map((r) => r.teamId)) };
}

export async function requireTransferDestination(opts: {
  userId: string;
  fromTeamId: string;
  destTeamId: string;
  cap: Capability;
  noun: "app" | "database";
  serverId: string;
}): Promise<{ name: string }> {
  const { userId, fromTeamId, destTeamId, cap, noun, serverId } = opts;
  if (destTeamId === fromTeamId)
    throw new Error(`That ${noun} is already in this team`);
  const tokenScope = currentIdentity()?.token?.scope;
  if (tokenScope && !tokenScope.wholeTeamIds.includes(destTeamId))
    throw new Error(`This API token can't move ${noun}s into that team.`);
  if (!(await membershipFor(userId, destTeamId)))
    throw new Error("You're not a member of that team");
  if (!(await holdsTeamWideCapability(destTeamId, cap)))
    throw new Error(
      `You don't have permission to manage ${noun}s in that team`,
    );
  const destTeam = (
    await getDb()
      .select({ name: teamsTable.name })
      .from(teamsTable)
      .where(eq(teamsTable.id, destTeamId))
      .limit(1)
  )[0];
  if (!destTeam) throw new Error("Team not found");
  const server = await serverAccess(serverId);
  if (server.teamIds && !server.teamIds.has(destTeamId))
    throw new Error(
      `${destTeam.name} can't use the server this ${noun} runs on (${server.name}). ` +
        `An instance admin can give that team access in Settings → Servers.`,
    );
  return destTeam;
}
