import { randomBytes } from "node:crypto";
import type {
  DeploData,
  Membership,
  NotificationSettings,
  User,
} from "./types";
import { capabilitiesForRole } from "./membership-shared";
import { uniqueUsername } from "./username";

/**
 * Forward-migrate a persisted document to the multi-team model. Runs on every
 * hydrate (after `normalize` backfills missing collections), is idempotent, and
 * mutates + returns the same object. Concerns:
 *
 *  1. Memberships: documents written before per-team memberships have users +
 *     teams but no `memberships` rows. Backfill one membership per user against
 *     the first team, capabilities seeded from the user's legacy role.
 *  2. teamId stamping: per-team collections gained a `teamId`. Legacy rows are
 *     stamped with the first team's id (the only team that existed).
 *  3. notificationSettings: was a single object; is now keyed by team id. A
 *     legacy object is moved under the first team's id.
 *  4. Drop the removed "hobby" plan: any team still on it becomes "pro".
 *  5. Usernames: users created before the `username` field get a unique handle
 *     backfilled from their name (then email local-part), deduped instance-wide.
 *  6. Instance admin: documents written before the global-admin flag get it
 *     backfilled onto the first team's owner(s) — the de-facto admins until now.
 *     `suspended` defaults to false for everyone.
 */
export function migrate(data: DeploData): DeploData {
  const firstTeamId = data.teams[0]?.id ?? null;

  // 5. Backfill usernames for users missing one (done first so later steps and
  //    any DTO reads see a populated handle). Unique across the instance.
  const taken = new Set(
    data.users.map((u) => (u as User).username).filter(Boolean) as string[],
  );
  for (const u of data.users) {
    if (!(u as User).username) {
      const seed = u.name || u.email?.split("@")[0] || "user";
      const handle = uniqueUsername(seed, taken);
      (u as User).username = handle;
      taken.add(handle);
    }
  }

  // 1. Backfill memberships for users that have none.
  if (firstTeamId && data.users.length > 0) {
    const haveMembership = new Set(data.memberships.map((m) => m.userId));
    for (const u of data.users) {
      if (!haveMembership.has(u.id)) {
        const role = u.role ?? "member";
        const membership: Membership = {
          id: `mbr_${randomBytes(8).toString("hex")}`,
          userId: u.id,
          teamId: firstTeamId,
          role,
          capabilities: capabilitiesForRole(role),
          createdAt: u.createdAt ?? new Date(0).toISOString(),
        };
        data.memberships.push(membership);
      }
    }
  }

  // 6. Backfill the global instance-admin flag. Only when the field never
  //    existed on ANY user (a pre-feature document) — so we never re-grant it
  //    after an admin has deliberately set the flags. The first team's owner(s)
  //    were the de-facto global admins, so they inherit it. `suspended`
  //    defaults to false for everyone.
  const adminFieldExists = data.users.some(
    (u) => (u as User).isInstanceAdmin !== undefined,
  );
  if (!adminFieldExists && firstTeamId) {
    const firstTeamOwnerIds = new Set(
      data.memberships
        .filter((m) => m.teamId === firstTeamId && m.role === "owner")
        .map((m) => m.userId),
    );
    // If the first team somehow has no owner, fall back to the earliest user.
    if (firstTeamOwnerIds.size === 0 && data.users[0]) {
      firstTeamOwnerIds.add(data.users[0].id);
    }
    for (const u of data.users) {
      (u as User).isInstanceAdmin = firstTeamOwnerIds.has(u.id);
    }
  }
  for (const u of data.users) {
    if ((u as User).suspended === undefined) (u as User).suspended = false;
  }

  // 2. Stamp teamId on legacy per-team rows.
  if (firstTeamId) {
    stamp(data.databases, firstTeamId);
    stamp(data.s3Destinations, firstTeamId);
    stamp(data.backups, firstTeamId);
    stamp(data.apiTokens, firstTeamId);
    stamp(data.activities, firstTeamId);
    stamp(data.sharedEnvGroups, firstTeamId);
    stamp(data.registries, firstTeamId);
    stamp(data.githubApps, firstTeamId);
  }

  // 3. Migrate a legacy singleton notificationSettings object into the map.
  const ns = data.notificationSettings as
    | NotificationSettings
    | Record<string, NotificationSettings>;
  if (ns && typeof ns === "object" && "channels" in ns) {
    const legacy = ns as NotificationSettings;
    const map: Record<string, NotificationSettings> = {};
    if (firstTeamId) map[firstTeamId] = legacy;
    data.notificationSettings = map;
  }

  // 4. Drop the removed "hobby" plan.
  for (const t of data.teams) {
    if ((t.plan as string) === "hobby") t.plan = "pro";
  }

  return data;
}

function stamp<T extends { teamId?: string }>(rows: T[], teamId: string): void {
  for (const r of rows) {
    if (!r.teamId) r.teamId = teamId;
  }
}
