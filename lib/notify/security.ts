import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  memberships as membershipsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { rateLimit } from "../security";
import { dispatchToTeams } from "./dispatch";
import { allTeamIds } from "./server-teams";

/**
 * "Somebody is guessing a password."
 *
 * Failed sign-ins were not recorded anywhere at all — not in the trail, not in
 * an alert — so a sustained attempt against a real account was invisible unless
 * the operator was reading the reverse-proxy log.
 *
 * The counter is `lib/security.ts`'s own `rateLimit`, which is already a fixed
 * window with exactly this shape. A second implementation would be a second
 * thing to get wrong.
 */

/** Failures inside the window before it is worth telling anyone. */
const BURST_LIMIT = 5;
const BURST_WINDOW_MS = 10 * 60_000;

/**
 * Count one failed sign-in and alert if it is now a burst.
 *
 * `subject` is the attempted address (or a client key when the second factor
 * failed and there is no address in scope). There is no session and no active
 * team at this point, so the teams are the ones the ACCOUNT belongs to — and an
 * address matching no account falls back to the first team, the same last resort
 * the activity log takes. The body never says whether the account exists.
 */
export function noteFailedLogin(subject: string): void {
  // `rateLimit` returns ok while under the limit; the first refusal IS the burst.
  if (rateLimit(`failed-login:${subject}`, {
    limit: BURST_LIMIT,
    windowMs: BURST_WINDOW_MS,
  }).ok)
    return;

  void (async () => {
    const teams = await teamsForSubject(subject);
    if (teams.length === 0) return;
    dispatchToTeams(teams, {
      key: "failed_logins",
      dedupe: { id: `login:${subject}`, state: "burst" },
      title: "Repeated failed sign-in attempts",
      body: `Several sign-ins for ${subject} were rejected in the last ten minutes.`,
      path: "/activity",
    });
  })().catch((e) => console.error("[deplo] failed-login alert failed:", e));
}

async function teamsForSubject(subject: string): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ teamId: membershipsTable.teamId })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
    .where(eq(usersTable.email, subject.toLowerCase()));
  if (rows.length > 0) return [...new Set(rows.map((r) => r.teamId))];
  const all = await allTeamIds();
  return all.slice(0, 1);
}
