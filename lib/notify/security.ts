import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { memberships as membershipsTable } from "../db/schema/control-plane/access-control";
import { users as usersTable } from "../db/schema/control-plane/identity";
import { rateLimit } from "../security";
import { dispatchToTeams } from "./dispatch";

const BURST_LIMIT = 5;
const BURST_WINDOW_MS = 10 * 60_000;

// noteFailedLogin counts one failed sign-in and alerts when it has become a burst.
export async function noteFailedLogin(subject: string): Promise<void> {
  // `rateLimit` returns ok while under the limit; the first refusal IS the burst.
  const burst = await rateLimit(`failed-login:${subject}`, {
    limit: BURST_LIMIT,
    windowMs: BURST_WINDOW_MS,
  });
  if (burst.ok) return;

  try {
    const teams = await teamsForSubject(subject);
    if (teams.length === 0) return;
    await dispatchToTeams(teams, {
      key: "failed_logins",
      dedupe: { id: `login:${subject}`, state: "burst" },
      title: "Repeated failed sign-in attempts",
      body: `Several sign-ins for ${subject} were rejected in the last ten minutes.`,
      path: "/activity",
    });
  } catch (e) {
    console.error("[deplo] failed-login alert failed:", e);
  }
}

async function teamsForSubject(subject: string): Promise<string[]> {
  const rows = await getDb()
    .select({ teamId: membershipsTable.teamId })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
    .where(eq(usersTable.email, subject.toLowerCase()));
  return [...new Set(rows.map((r) => r.teamId))];
}
