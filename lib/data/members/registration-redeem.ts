import "server-only";

import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb, type DbTx } from "../../db/client";
import {
  registrationLinks as registrationLinksTable,
  registrationLinkTeams as registrationLinkTeamsTable,
  registrationLinkTeamCapabilities as registrationLinkTeamCapabilitiesTable,
  teams as teamsTable,
} from "../../db/schema/control-plane/identity";
import { nowIso } from "../../ids";
import { sha256Hex } from "../../crypto";
import { teamAvatarUrl } from "../../avatar";
import type { RegistrationMode } from "./registration-links";
import type { Capability, Role } from "../../types/identity";

export interface RegistrationLinkInfo {
  valid: boolean;
  mode: RegistrationMode;
  teams: { name: string; avatarUrl: string | null }[];
}

export async function getRegistrationLinkInfo(
  rawToken: string,
): Promise<RegistrationLinkInfo> {
  const hash = sha256Hex(rawToken);
  const rows = await getDb()
    .select({
      id: registrationLinksTable.id,
      mode: registrationLinksTable.mode,
    })
    .from(registrationLinksTable)
    .where(
      and(
        eq(registrationLinksTable.tokenHash, hash),
        eq(registrationLinksTable.status, "pending"),
        gte(registrationLinksTable.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  const link = rows[0];
  if (!link) return { valid: false, mode: "own_team", teams: [] };
  const mode = link.mode as RegistrationMode;
  if (mode !== "existing_teams") return { valid: true, mode, teams: [] };

  const teamRows = await getDb()
    .select({ name: teamsTable.name, image: teamsTable.image })
    .from(registrationLinkTeamsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, registrationLinkTeamsTable.teamId))
    .where(eq(registrationLinkTeamsTable.linkId, link.id))
    .orderBy(asc(teamsTable.name));
  const teams = teamRows.map((r) => ({
    name: r.name,
    avatarUrl: teamAvatarUrl(r.image),
  }));
  if (teams.length === 0)
    return { valid: false, mode: "existing_teams", teams: [] };
  return { valid: true, mode: "existing_teams", teams };
}

export async function getRegistrationLinkAssignments(
  rawToken: string,
): Promise<{ teamId: string; role: Role; capabilities: Capability[] }[]> {
  const hash = sha256Hex(rawToken);
  const linkRows = await getDb()
    .select({ id: registrationLinksTable.id })
    .from(registrationLinksTable)
    .where(
      and(
        eq(registrationLinksTable.tokenHash, hash),
        eq(registrationLinksTable.status, "pending"),
        gte(registrationLinksTable.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  const link = linkRows[0];
  if (!link) return [];

  const teamRows = await getDb()
    .select({
      linkTeamId: registrationLinkTeamsTable.id,
      teamId: registrationLinkTeamsTable.teamId,
      role: registrationLinkTeamsTable.role,
    })
    .from(registrationLinkTeamsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, registrationLinkTeamsTable.teamId))
    .where(eq(registrationLinkTeamsTable.linkId, link.id));
  if (teamRows.length === 0) return [];

  const capsByLinkTeam = new Map<string, Capability[]>();
  const capRows = await getDb()
    .select({
      linkTeamId: registrationLinkTeamCapabilitiesTable.linkTeamId,
      capability: registrationLinkTeamCapabilitiesTable.capability,
    })
    .from(registrationLinkTeamCapabilitiesTable)
    .where(
      inArray(
        registrationLinkTeamCapabilitiesTable.linkTeamId,
        teamRows.map((r) => r.linkTeamId),
      ),
    );
  for (const r of capRows) {
    const list = capsByLinkTeam.get(r.linkTeamId) ?? [];
    list.push(r.capability as Capability);
    capsByLinkTeam.set(r.linkTeamId, list);
  }

  return teamRows.map((r) => ({
    teamId: r.teamId,
    role: r.role as Role,
    capabilities: capsByLinkTeam.get(r.linkTeamId) ?? [],
  }));
}

export async function consumeRegistrationLink(
  tx: DbTx,
  rawToken: string,
  usedByUsername: string,
): Promise<void> {
  const hash = sha256Hex(rawToken);
  const updated = await tx
    .update(registrationLinksTable)
    .set({ status: "used", usedByUsername, usedAt: nowIso() })
    .where(
      and(
        eq(registrationLinksTable.tokenHash, hash),
        eq(registrationLinksTable.status, "pending"),
        gte(registrationLinksTable.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: registrationLinksTable.id });
  if (updated.length === 0)
    throw new Error("This registration link is no longer valid");
}
