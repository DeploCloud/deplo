import "server-only";

import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { users as usersTable } from "../../db/schema/control-plane/identity";
import {
  migrationRunMembers as runMembersTable,
  migrationRuns as runsTable,
} from "../../db/schema/control-plane/migration";
import { newId, nowIso } from "../../ids";
import { avatarResolver } from "../../avatar";
import { requireInstanceAdmin } from "../../membership";
import { sourceClient } from "../../migration/source";
import type { SourceCredential } from "../../migration/source";
import { addExistingMember } from "../members/assignment";
import {
  addTeamToRegistrationLink,
  mintRegistrationLink,
  revealRegistrationLink,
} from "../members/registration-links";
import { assertImportGate, credentialFor, type ConnectInput } from "./gates";
import { Report, ownRun, refreshCounts } from "./run-report";
import { planMembers } from "./source-people";

export interface MigrationInvite {
  email: string;
  name: string;
  link: string | null;
  outcome: string;
  message: string | null;
  sourceRole?: string;
  hasAccount?: boolean;
  avatarUrl?: string | null;
}

export async function listMigrationRunMembers(
  runId: string,
): Promise<MigrationInvite[]> {
  const { teamId } = await assertImportGate();
  if (!(await ownRun(runId, teamId))) return [];
  return runMembersOf(runId);
}

export async function runMembersOf(runId: string): Promise<MigrationInvite[]> {
  const rows = await getDb()
    .select()
    .from(runMembersTable)
    .where(eq(runMembersTable.runId, runId))
    .orderBy(asc(runMembersTable.email));
  if (rows.length === 0) return [];

  const accounts = await getDb()
    .select({
      id: usersTable.id,
      email: usersTable.email,
      image: usersTable.image,
      avatarColor: usersTable.avatarColor,
    })
    .from(usersTable)
    .where(
      inArray(
        sql`lower(${usersTable.email})`,
        rows.map((r) => r.email),
      ),
    );
  const byEmail = new Map(accounts.map((a) => [a.email.toLowerCase(), a]));
  const url = await avatarResolver();

  const out: MigrationInvite[] = [];
  for (const r of rows) {
    const account = byEmail.get(r.email) ?? null;
    const link = r.linkId
      ? await revealRegistrationLink(r.linkId).catch(() => null)
      : null;
    out.push({
      email: r.email,
      name: r.name,
      sourceRole: r.sourceRole,
      link,
      outcome: r.outcome,
      message: r.message,
      hasAccount: account != null,
      avatarUrl: account ? url(account) : null,
    });
  }
  return out;
}

async function bringOverRunMembers(
  runId: string,
  c: SourceCredential,
): Promise<MigrationInvite[]> {
  const { teamId } = await assertImportGate();
  await requireInstanceAdmin();
  if (!(await ownRun(runId, teamId)))
    throw new Error("That import run does not belong to this team.");
  const already = await runMembersOf(runId);
  if (already.length > 0) return already;

  const panel = sourceClient(c).displayName;
  const report = new Report(runId, panel).at("Members");
  const people = await planMembers(c, teamId);
  const out: MigrationInvite[] = [];

  const accounts = new Map<string, string>();
  if (people.length > 0)
    for (const a of await getDb()
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(
        inArray(
          sql`lower(${usersTable.email})`,
          people.map((p) => p.email),
        ),
      ))
      accounts.set(a.email.toLowerCase(), a.id);

  const sessionLinks = await linksMintedInSession(runId);

  for (const p of people) {
    const roleNote =
      p.sourceRole && p.sourceRole !== "member"
        ? ` Was ${p.sourceRole} on ${panel} - promote them in Members if that should carry over.`
        : "";
    const record = async (
      outcome: string,
      message: string,
      linkId: string | null,
      link: string | null,
    ) => {
      out.push({ ...p, link, outcome, message });
      await getDb()
        .insert(runMembersTable)
        .values({
          id: newId("mmem"),
          runId,
          email: p.email,
          name: p.name,
          sourceRole: p.sourceRole,
          outcome,
          message,
          linkId,
          createdAt: nowIso(),
        })
        .onConflictDoNothing();
    };

    if (p.inTeam) {
      const message = "Already a member of this team.";
      await record("skipped", message, null, null);
      await report.add({
        sourceKind: "member",
        sourceName: p.email,
        outcome: "skipped",
        message,
      });
      continue;
    }

    const userId = accounts.get(p.email);
    try {
      if (userId) {
        await addExistingMember({ userId, role: "member" });
        const message = `Added to the team as a member.${roleNote}`;
        await record("created", message, null, null);
        await report.add({
          sourceKind: "member",
          sourceName: p.email,
          outcome: "created",
          targetKind: "member",
          targetId: userId,
          message,
        });
      } else {
        const mine = sessionLinks.get(p.email);
        const reused =
          mine != null &&
          (await addTeamToRegistrationLink(mine, teamId, "member"));
        const linkId = reused
          ? mine!
          : (
              await mintRegistrationLink({
                mode: "existing_teams",
                teamAssignments: [{ teamId, role: "member" }],
              })
            ).id;
        sessionLinks.set(p.email, linkId);
        const link = await revealRegistrationLink(linkId).catch(() => null);
        const message = reused
          ? `They were on more than one team here, so this is the same link - it joins them to all of them.${roleNote}`
          : `Send them this link to create their account.${roleNote}`;
        await record("manual", message, linkId, link);
        await report.add({
          sourceKind: "member",
          sourceName: p.email,
          outcome: "manual",
          targetKind: "registration-link",
          message: `A registration link was created for ${p.email}.${roleNote}`,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not be invited.";
      await record("failed", message, null, null);
      await report.add({
        sourceKind: "member",
        sourceName: p.email,
        outcome: "failed",
        message,
      });
    }
  }

  await refreshCounts(runId, teamId);
  return out.length > 0 ? runMembersOf(runId) : out;
}

async function linksMintedInSession(
  runId: string,
): Promise<Map<string, string>> {
  const rows = await getDb()
    .select({ email: runMembersTable.email, linkId: runMembersTable.linkId })
    .from(runMembersTable)
    .innerJoin(runsTable, eq(runsTable.id, runMembersTable.runId))
    .where(
      and(
        isNotNull(runMembersTable.linkId),
        inArray(
          runsTable.sessionId,
          getDb()
            .select({ id: runsTable.sessionId })
            .from(runsTable)
            .where(eq(runsTable.id, runId)),
        ),
      ),
    );
  return new Map(rows.filter((r) => r.linkId).map((r) => [r.email, r.linkId!]));
}

export async function importMigrationMembers(
  input: ConnectInput & { runId: string },
): Promise<MigrationInvite[]> {
  const { teamId } = await assertImportGate();
  await requireInstanceAdmin();
  if (!(await ownRun(input.runId, teamId)))
    throw new Error("That import run does not belong to this team.");
  const already = await runMembersOf(input.runId);
  if (already.length > 0) return already;
  return bringOverRunMembers(input.runId, await credentialFor(input));
}

export async function importRunMembers(
  runId: string,
  c: SourceCredential,
): Promise<void> {
  await bringOverRunMembers(runId, c);
}
