import "server-only";

import { inArray, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { users as usersTable } from "../../db/schema/control-plane/identity";
import { avatarResolver } from "../../avatar";
import { listMembers } from "../../migration/dokploy/client";
import { sourceClient } from "../../migration/source";
import type { SourceCredential } from "../../migration/source";

export interface PlanMember {
  email: string;
  name: string;
  sourceRole: string;
  hasAccount: boolean;
  avatarUrl: string | null;
  avatarColor: string | null;
  inTeam: boolean;
}

function personName(m: {
  user?: {
    name?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  } | null;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): string {
  const first = (m.user?.firstName ?? m.firstName ?? "").trim();
  const last = (m.user?.lastName ?? m.lastName ?? "").trim();
  const full = [first, last].filter(Boolean).join(" ");
  if (full) return full;
  const named = (m.user?.name ?? m.name ?? "").trim();
  return named.includes("@") ? named.split("@")[0] : named;
}

export async function planMembers(
  c: SourceCredential,
  teamId: string,
): Promise<PlanMember[]> {
  let rows: Awaited<ReturnType<typeof listMembers>>;
  try {
    rows = await sourceClient(c).listMembers();
  } catch {
    return [];
  }

  const people = rows
    .map((m) => ({
      email: (m.user?.email ?? m.email ?? "").trim().toLowerCase(),
      name: personName(m),
      sourceRole: (m.role ?? "").trim(),
    }))
    .filter((p) => p.email.includes("@"));
  if (people.length === 0) return [];

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
        people.map((p) => p.email),
      ),
    );
  const byEmail = new Map(accounts.map((a) => [a.email.toLowerCase(), a]));
  const memberIds = new Set(await teamMemberIds(teamId));
  const url = await avatarResolver();

  return people.map((p) => {
    const account = byEmail.get(p.email) ?? null;
    return {
      ...p,
      name: p.name || p.email,
      hasAccount: account != null,
      avatarUrl: account ? url(account) : null,
      avatarColor: account?.avatarColor ?? null,
      inTeam: account != null && memberIds.has(account.id),
    };
  });
}

async function teamMemberIds(teamId: string): Promise<string[]> {
  const rows = await getDb().execute<{ user_id: string }>(
    sql`select user_id from memberships where team_id = ${teamId}`,
  );
  const list = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: unknown[] }).rows ?? []);
  return (list as { user_id: string }[]).map((r) => r.user_id);
}
