// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  memberships as membershipsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { rateLimit } from "../security";
import { dispatchToTeams } from "./dispatch";

/**
 * "Somebody is guessing a password." A second implementation would be a second
 * thing to get wrong.
 */

/** Failures inside the window before it is worth telling anyone. */
const BURST_LIMIT = 5;
const BURST_WINDOW_MS = 10 * 60_000;

/**
 * Count one failed sign-in and alert if it is now a burst.
 */
export async function noteFailedLogin(subject: string): Promise<void> {
  // `rateLimit` returns ok while under the limit; the first refusal IS the burst.
  const burst = await rateLimit(`failed-login:${subject}`, {
    limit: BURST_LIMIT,
    windowMs: BURST_WINDOW_MS,
  });
  if (burst.ok) return;

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
  const rows = await getDb()
    .select({ teamId: membershipsTable.teamId })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
    .where(eq(usersTable.email, subject.toLowerCase()));
  return [...new Set(rows.map((r) => r.teamId))];
}
