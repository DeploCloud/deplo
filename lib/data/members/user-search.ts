import "server-only";

import { desc, eq, inArray, notInArray } from "drizzle-orm";
import { getDb } from "../../db/client";
import { memberships as membershipsTable } from "../../db/schema/control-plane/access-control";
import {
  teams as teamsTable,
  users as usersTable,
} from "../../db/schema/control-plane/identity";
import { assertUser } from "../../auth/current-user";
import { avatarResolver, teamAvatarUrl } from "../../avatar";
import {
  isInstanceAdmin,
  requireActiveTeamId,
  requireCapability,
} from "../../membership";

/** A registered user as shown in the add-member search (username only). */
export interface UserSearchResult {
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  /** Resolved picture: uploaded image, else Gravatar, else null for the monogram. */
  avatarUrl: string | null;
  /** Their home team's name, to disambiguate identical display names. */
  teamName: string | null;
  teamAvatarUrl: string | null;
}

/** Users addable to the active team, matched on USERNAME (and display name) only - never on email. */
export async function searchUsers(query: string): Promise<UserSearchResult[]> {
  const teamId = await requireActiveTeamId();
  await requireCapability("manage_members");
  const q = query.trim().toLowerCase();
  const db = getDb();
  const admin = await isInstanceAdmin();

  // Users NOT already in the team.
  const inTeam = db
    .select({ userId: membershipsTable.userId })
    .from(membershipsTable)
    .where(eq(membershipsTable.teamId, teamId));
  const candidates = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
      // Consumed by `avatarUrl` below and dropped - this DTO carries no email.
      image: usersTable.image,
      email: usersTable.email,
    })
    .from(usersTable)
    .where(notInArray(usersTable.id, inTeam))
    // Most recently created first, so the picker opens on the newest users.
    .orderBy(desc(usersTable.createdAt));

  // The actor's own reach: everyone sharing a team with them. Skipped entirely
  // for an admin, who is offered the whole roster.
  let known: Set<string> | null = null;
  if (!admin) {
    const me = await assertUser();
    const myTeams = db
      .select({ teamId: membershipsTable.teamId })
      .from(membershipsTable)
      .where(eq(membershipsTable.userId, me.id));
    known = new Set(
      (
        await db
          .selectDistinct({ userId: membershipsTable.userId })
          .from(membershipsTable)
          .where(inArray(membershipsTable.teamId, myTeams))
      ).map((r) => r.userId),
    );
  }

  const filtered = candidates.filter(
    (u) =>
      // Reachable at all: a colleague, or named exactly. A substring match on a
      // stranger is what turns this into a directory.
      (known === null ||
        known.has(u.id) ||
        (q !== "" && u.username.toLowerCase() === q)) &&
      (!q ||
        u.username.toLowerCase().includes(q) ||
        u.name.toLowerCase().includes(q)),
  );
  if (filtered.length === 0) return [];

  // Home team per candidate = the team they own, else any team they're in.
  const candidateIds = filtered.map((u) => u.id);
  const mine = await db
    .select({
      userId: membershipsTable.userId,
      role: membershipsTable.role,
      teamName: teamsTable.name,
      teamImage: teamsTable.image,
    })
    .from(membershipsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, membershipsTable.teamId))
    .where(inArray(membershipsTable.userId, candidateIds));
  const homeByUser = new Map<string, { name: string; image: string | null }>();
  const ownedSet = new Set<string>();
  for (const m of mine) {
    const home = { name: m.teamName, image: m.teamImage };
    if (m.role === "owner" && !ownedSet.has(m.userId)) {
      homeByUser.set(m.userId, home);
      ownedSet.add(m.userId);
    } else if (!homeByUser.has(m.userId)) {
      homeByUser.set(m.userId, home);
    }
  }

  const avatarUrl = await avatarResolver();
  return filtered.map((u) => ({
    userId: u.id,
    username: u.username,
    name: u.name,
    avatarColor: u.avatarColor,
    avatarUrl: avatarUrl(u),
    teamName: homeByUser.get(u.id)?.name ?? null,
    teamAvatarUrl: teamAvatarUrl(homeByUser.get(u.id)?.image),
  }));
}
