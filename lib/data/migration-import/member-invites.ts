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
  // The single-use registration link, or null when they were added directly.
  link: string | null;
  outcome: string;
  message: string | null;
  // What they were on the panel, for the note that says to grant it here.
  sourceRole?: string;
  // Whether that address already has an account here.
  hasAccount?: boolean;
  avatarUrl?: string | null;
}

// listMigrationRunMembers - read from the RUN, never from the panel: the token is
// wiped when a run ends, and the People step is often opened long after.
export async function listMigrationRunMembers(
  runId: string,
): Promise<MigrationInvite[]> {
  const { teamId } = await assertImportGate();
  if (!(await ownRun(runId, teamId))) return [];
  return runMembersOf(runId);
}

// The same list, with no gate - for a caller that has already checked.
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
    // The token itself lives encrypted on the link row; this is the one reader.
    // A link that has been used, revoked or has expired answers nothing, and the
    // card then says what became of them instead.
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

// Bring the source team's people over, once: everyone else gets ONE single-use link
// per address for the whole migration, because a person on two teams of the panel is
// one person and a second link is a second account the unique email would refuse.
async function bringOverRunMembers(
  runId: string,
  c: SourceCredential,
): Promise<MigrationInvite[]> {
  const { teamId } = await assertImportGate();
  await requireInstanceAdmin();
  if (!(await ownRun(runId, teamId)))
    throw new Error("That import run does not belong to this team.");
  // Written down means done: the run brings its people over as it finishes, and
  // a wizard asking again must not mint everybody a second link.
  const already = await runMembersOf(runId);
  if (already.length > 0) return already;

  // The name, not the placeholder: these lines are handed back to the wizard as
  // well as written to the report, and only the report resolves a `{panel}`.
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
        // Their link from an earlier team of this same panel, with this team
        // added to it. Gone or spent, and they get a fresh one.
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
  // Read back rather than returned: one shape and one order for both doors into
  // this - the run's own last act, and a client asking again afterwards.
  return out.length > 0 ? runMembersOf(runId) : out;
}

// Every address this migration has already minted a link for, and which link.
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

// importMigrationMembers - the door for a client asking again after the run brought
// its people over: it answers with what the run recorded rather than minting a second
// set of links.
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

// importRunMembers - the run's own last act: its people, under the actor's identity.
export async function importRunMembers(
  runId: string,
  c: SourceCredential,
): Promise<void> {
  await bringOverRunMembers(runId, c);
}
