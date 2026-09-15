import "server-only";

import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "../../db/client";
import { memberships as membershipsTable } from "../../db/schema/control-plane/access-control";
import {
  registrationLinks as registrationLinksTable,
  registrationLinkTeams as registrationLinkTeamsTable,
  registrationLinkTeamCapabilities as registrationLinkTeamCapabilitiesTable,
  teams as teamsTable,
} from "../../db/schema/control-plane/identity";
import { newId, nowIso } from "../../ids";
import {
  sha256Hex,
  randomToken,
  encryptSecret,
  decryptSecret,
} from "../../crypto";
import { getCurrentUser } from "../../auth/current-user";
import { requireInstanceAdmin } from "../../membership";
import { cleanCapabilities } from "../../membership-shared";
import { instancePublicBaseUrl } from "../instance-settings/settings-store";
import { actorName } from "./activity-actor";
import type { Capability, RegistrationLink, Role } from "../../types/identity";

const REGISTRATION_TTL_HOURS = 24;

export type RegistrationMode = "own_team" | "existing_teams";

export interface RegistrationTeamAssignment {
  teamId: string;
  role: Role;
  capabilities?: Capability[];
}

export interface RegistrationLinkDTO {
  id: string;
  status: RegistrationLink["status"];
  mode: RegistrationMode;
  teamNames: string[];
  createdBy: string;
  usedByUsername: string | null;
  expiresAt: string;
  createdAt: string;
  canReveal: boolean;
  linkMasked: string;
}

export interface MintRegistrationResult {
  link: string;
  id: string;
}

const MAX_REGISTRATION_TEAMS = 50;

export async function mintRegistrationLink(input: {
  mode: RegistrationMode;
  teamAssignments?: RegistrationTeamAssignment[];
}): Promise<MintRegistrationResult> {
  await requireInstanceAdmin();
  const createdBy = await actorName();
  const rawToken = randomToken(24);
  const now = nowIso();
  const linkId = newId("reg");
  const expiresAt = new Date(
    Date.now() + REGISTRATION_TTL_HOURS * 3_600_000,
  ).toISOString();
  const baseRow = {
    id: linkId,
    tokenHash: sha256Hex(rawToken),
    tokenEnc: encryptSecret(rawToken),
    status: "pending",
    createdBy,
    usedByUsername: null,
    expiresAt,
    createdAt: now,
    usedAt: null,
  } as const;

  if (input.mode === "existing_teams") {
    const byTeam = new Map<string, RegistrationTeamAssignment>();
    for (const a of input.teamAssignments ?? []) byTeam.set(a.teamId, a);
    const assignments = [...byTeam.values()];
    if (assignments.length === 0)
      throw new Error("Select at least one team for the new user");
    if (assignments.length > MAX_REGISTRATION_TEAMS)
      throw new Error("Too many teams selected");
    for (const a of assignments) {
      if (a.role !== "member" && a.role !== "viewer")
        throw new Error(
          "A new user can only join a team as a member or viewer",
        );
    }
    const me = await getCurrentUser();
    if (!me) throw new Error("Not authenticated");
    const myTeamRows = await getDb()
      .select({ teamId: membershipsTable.teamId })
      .from(membershipsTable)
      .where(eq(membershipsTable.userId, me.id));
    const myTeamIds = new Set(myTeamRows.map((r) => r.teamId));
    for (const a of assignments) {
      if (!myTeamIds.has(a.teamId))
        throw new Error("You can only add new users to teams you belong to");
    }
    const ids = assignments.map((a) => a.teamId);
    const found = await getDb()
      .select({ id: teamsTable.id })
      .from(teamsTable)
      .where(inArray(teamsTable.id, ids));
    const foundSet = new Set(found.map((r) => r.id));
    if (foundSet.size !== ids.length)
      throw new Error("One or more selected teams no longer exist");

    await getDb().transaction(async (tx) => {
      await tx
        .insert(registrationLinksTable)
        .values({ ...baseRow, mode: "existing_teams" });
      for (const a of assignments) {
        const linkTeamId = newId("rlt");
        await tx.insert(registrationLinkTeamsTable).values({
          id: linkTeamId,
          linkId,
          teamId: a.teamId,
          role: a.role,
        });
        const caps = cleanCapabilities(a.capabilities, a.role);
        await tx
          .insert(registrationLinkTeamCapabilitiesTable)
          .values(caps.map((c) => ({ linkTeamId, capability: c })));
      }
    });
  } else {
    await getDb()
      .insert(registrationLinksTable)
      .values({ ...baseRow, mode: "own_team" });
  }

  const base = await instancePublicBaseUrl();
  return { link: `${base}/register/${rawToken}`, id: linkId };
}

export async function addTeamToRegistrationLink(
  linkId: string,
  teamId: string,
  role: Role,
): Promise<boolean> {
  await requireInstanceAdmin();
  if (role !== "member" && role !== "viewer")
    throw new Error("A new user can only join a team as a member or viewer");
  const me = await getCurrentUser();
  if (!me) throw new Error("Not authenticated");
  const mine = await getDb()
    .select({ teamId: membershipsTable.teamId })
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.userId, me.id),
        eq(membershipsTable.teamId, teamId),
      ),
    );
  if (mine.length === 0)
    throw new Error("You can only add new users to teams you belong to");
  const [link] = await getDb()
    .select({ id: registrationLinksTable.id })
    .from(registrationLinksTable)
    .where(
      and(
        eq(registrationLinksTable.id, linkId),
        eq(registrationLinksTable.status, "pending"),
        eq(registrationLinksTable.mode, "existing_teams"),
        gte(registrationLinksTable.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  if (!link) return false;
  const linkTeamId = newId("rlt");
  const added = await getDb()
    .insert(registrationLinkTeamsTable)
    .values({ id: linkTeamId, linkId, teamId, role })
    .onConflictDoNothing()
    .returning({ id: registrationLinkTeamsTable.id });
  if (added.length === 0) return true;
  const caps = cleanCapabilities(undefined, role);
  if (caps.length > 0)
    await getDb()
      .insert(registrationLinkTeamCapabilitiesTable)
      .values(caps.map((c) => ({ linkTeamId, capability: c })));
  return true;
}

export async function listRegistrationLinks(): Promise<RegistrationLinkDTO[]> {
  await requireInstanceAdmin();
  const rows = await getDb()
    .select({
      id: registrationLinksTable.id,
      status: registrationLinksTable.status,
      mode: registrationLinksTable.mode,
      createdBy: registrationLinksTable.createdBy,
      usedByUsername: registrationLinksTable.usedByUsername,
      expiresAt: registrationLinksTable.expiresAt,
      createdAt: registrationLinksTable.createdAt,
      tokenEnc: registrationLinksTable.tokenEnc,
    })
    .from(registrationLinksTable)
    .orderBy(desc(registrationLinksTable.createdAt));

  const linkIds = rows.map((l) => l.id);
  const namesByLink = new Map<string, string[]>();
  if (linkIds.length > 0) {
    const teamRows = await getDb()
      .select({
        linkId: registrationLinkTeamsTable.linkId,
        name: teamsTable.name,
      })
      .from(registrationLinkTeamsTable)
      .innerJoin(
        teamsTable,
        eq(teamsTable.id, registrationLinkTeamsTable.teamId),
      )
      .where(inArray(registrationLinkTeamsTable.linkId, linkIds))
      .orderBy(asc(teamsTable.name));
    for (const r of teamRows) {
      const list = namesByLink.get(r.linkId) ?? [];
      list.push(r.name);
      namesByLink.set(r.linkId, list);
    }
  }

  const maskedBase = `${await publicBaseUrl()}/register/`;
  const now = Date.now();
  return rows.map((l) => ({
    id: l.id,
    status: l.status as RegistrationLink["status"],
    mode: l.mode as RegistrationMode,
    teamNames: namesByLink.get(l.id) ?? [],
    createdBy: l.createdBy,
    usedByUsername: l.usedByUsername,
    expiresAt: l.expiresAt,
    createdAt: l.createdAt,
    canReveal:
      !!l.tokenEnc && l.status === "pending" && Date.parse(l.expiresAt) > now,
    linkMasked: `${maskedBase}${"•".repeat(12)}`,
  }));
}

async function publicBaseUrl(): Promise<string> {
  try {
    return await instancePublicBaseUrl();
  } catch {
    return "";
  }
}

export async function revealRegistrationLink(id: string): Promise<string> {
  await requireInstanceAdmin();
  const [row] = await getDb()
    .select()
    .from(registrationLinksTable)
    .where(eq(registrationLinksTable.id, id))
    .limit(1);
  if (!row) throw new Error("Link not found");
  if (row.status === "used")
    throw new Error(
      `This link was already used${row.usedByUsername ? ` by @${row.usedByUsername}` : ""} - registration links work once. Mint a new one.`,
    );
  if (row.status !== "pending")
    throw new Error("This link was revoked. Mint a new one.");
  if (Date.parse(row.expiresAt) <= Date.now())
    throw new Error("This link has expired. Mint a new one.");
  if (!row.tokenEnc)
    throw new Error(
      "This link was created before links could be shown again. Revoke it and mint a new one.",
    );
  const rawToken = decryptSecret(row.tokenEnc);
  if (rawToken === "")
    throw new Error(
      "This link could not be decrypted. Revoke it and mint a new one.",
    );
  return `${await instancePublicBaseUrl()}/register/${rawToken}`;
}

export async function revokeRegistrationLink(id: string): Promise<void> {
  await requireInstanceAdmin();
  const updated = await getDb()
    .update(registrationLinksTable)
    .set({ status: "revoked" })
    .where(
      and(
        eq(registrationLinksTable.id, id),
        eq(registrationLinksTable.status, "pending"),
      ),
    )
    .returning({ id: registrationLinksTable.id });
  if (updated.length === 0) {
    const exists = await getDb()
      .select({ id: registrationLinksTable.id })
      .from(registrationLinksTable)
      .where(eq(registrationLinksTable.id, id))
      .limit(1);
    if (exists.length === 0) throw new Error("Link not found");
  }
}

export async function revokeAllRegistrationLinks(): Promise<number> {
  await requireInstanceAdmin();
  const revoked = await getDb()
    .update(registrationLinksTable)
    .set({ status: "revoked" })
    .where(eq(registrationLinksTable.status, "pending"))
    .returning({ id: registrationLinksTable.id });
  return revoked.length;
}
