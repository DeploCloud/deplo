import "server-only";

import { cache } from "react";

import { assertUser, currentSessionId } from "../auth";
import { requireAuth } from "../auth/better-auth";
import { describeUserAgent, type DeviceKind } from "../user-agent";

/**
 * The devices signed in to the current account — Settings → Security.
 *
 * USER-scoped, not team-scoped: a session belongs to a person, not to a team, so
 * everything here gates on `assertUser()` and resolves rows through that user's
 * id. It is the one part of the data layer where `requireActiveTeamId` would be
 * the wrong boundary, and using it would be a real bug: a member locked out of
 * their team by its 2FA policy must still be able to see and kill their own
 * sessions.
 *
 * Everything goes through Better Auth's `internalAdapter` rather than raw SQL on
 * the `session` table. Direct deletes work today and would keep working right up
 * until someone enables `secondaryStorage` or `session.cookieCache`, at which
 * point a "revoked" session would quietly stay alive in Redis or in a signed
 * cookie until it expired — a security feature that silently stops working is
 * worse than one that was never built. The adapter owns those paths.
 *
 * The hard rule on top of that: **`session.token` never leaves this module.**
 * It is not a hash or an identifier, it is the credential itself — the value
 * inside the cookie. The DTO carries `id`, which is inert, and the token is
 * looked up server-side only when something is about to be deleted.
 */

export interface UserSessionDTO {
  id: string;
  /** True for the session making this request — it cannot revoke itself. */
  current: boolean;
  /** "Chrome on macOS", "curl", "Unknown device". */
  label: string;
  device: DeviceKind;
  ipAddress: string | null;
  /**
   * When Better Auth last refreshed this session, which is as close to "last
   * used" as the row gets. Accurate to `updateAge` (15 minutes, set in
   * lib/auth/better-auth.ts) — at the library default of a day it was off by up
   * to 24 hours, which made the column useless for the one question it answers:
   * is this session still in use, or is it stale enough to sign out?
   */
  lastSeenAt: string;
  createdAt: string;
  expiresAt: string;
}

/** Better Auth's storage layer, whichever backend it is configured with. */
async function adapter() {
  return (await requireAuth().$context).internalAdapter;
}

/** Sessions of `userId` that can still authenticate, newest activity first. */
async function liveSessions(userId: string) {
  const rows = await (await adapter()).listSessions(userId);
  const now = Date.now();
  return rows
    .filter((s) => new Date(s.expiresAt).getTime() > now)
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
}

/**
 * Every live session of the current user, most recently seen first.
 *
 * Expired rows are filtered out rather than shown greyed: Better Auth deletes
 * them lazily, so the table would otherwise fill with sessions that already
 * cannot sign anyone in, and offering a "revoke" button for those is theatre.
 */
export const listMySessions = cache(async (): Promise<UserSessionDTO[]> => {
  const user = await assertUser();
  const current = await currentSessionId();
  return (await liveSessions(user.id)).map((s) => {
    const { label, device } = describeUserAgent(s.userAgent);
    return {
      id: s.id,
      current: s.id === current,
      label,
      device,
      // Better Auth writes "" (not null) when it could not determine the address,
      // and an empty string would render as an empty cell rather than "Unknown".
      ipAddress: s.ipAddress || null,
      lastSeenAt: new Date(s.updatedAt).toISOString(),
      createdAt: new Date(s.createdAt).toISOString(),
      expiresAt: new Date(s.expiresAt).toISOString(),
    };
  });
});

/**
 * End one session by id.
 *
 * The id is resolved WITHIN the caller's own session list, so an id belonging to
 * somebody else is simply not found — the ownership check is structural rather
 * than a WHERE clause someone can forget. It reports the same "no longer signed
 * in" as an id that never existed, so the caller learns nothing either way.
 */
export async function revokeSession(id: string): Promise<void> {
  const user = await assertUser();
  const current = await currentSessionId();
  if (id === current)
    throw new Error(
      "That is the device you are using right now. Sign out to end this session.",
    );
  const target = (await liveSessions(user.id)).find((s) => s.id === id);
  if (!target) throw new Error("That device is no longer signed in.");
  await (await adapter()).deleteSession(target.token);
}

/**
 * End every session except the one making the request, and report how many live
 * ones went.
 *
 * The panic button: it is what someone reaches for after losing a laptop, so it
 * must not also sign THEM out and leave them unable to change their password.
 *
 * With no current session (a bearer-token caller, which has none) there is
 * nothing to keep and this revokes ALL of the user's sessions. That is the
 * honest reading of "all except the current one" from a context that has no
 * current one, and it keeps "sign out everywhere" reachable from the API.
 */
export async function revokeOtherSessions(): Promise<number> {
  const user = await assertUser();
  const current = await currentSessionId();
  const all = await (await adapter()).listSessions(user.id);
  const doomed = all.filter((s) => s.id !== current);
  if (doomed.length === 0) return 0;
  await (await adapter()).deleteSessions(doomed.map((s) => s.token));
  // Count only the ones that could still have signed someone in. Expired rows
  // are swept along for free, but reporting "signed out 7 devices" when 5 of
  // them were already dead would be a lie the user cannot check.
  const now = Date.now();
  return doomed.filter((s) => new Date(s.expiresAt).getTime() > now).length;
}
