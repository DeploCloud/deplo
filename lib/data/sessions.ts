import "server-only";

import { cache } from "react";

import { assertUser, currentSessionId } from "../auth";
import { requireAuth } from "../auth/better-auth";
import { requirePersonalSession } from "../auth/request-context";
import { describeUserAgent, type DeviceKind } from "../user-agent";

/**
 * The devices signed in to the current account — Settings → Security. The hard
 * rule on top of that: **`session.token` never leaves this module.
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
   * When Better Auth last refreshed this session, which is as close to "last used"
   * as the row gets.
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
 */
export const listMySessions = cache(async (): Promise<UserSessionDTO[]> => {
  requirePersonalSession("your signed-in devices");
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
 * End one session by id. It reports the same "no longer signed in" as an id that
 * never existed, so the caller learns nothing either way.
 */
export async function revokeSession(id: string): Promise<void> {
  requirePersonalSession("your signed-in devices");
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
 */
export async function revokeOtherSessions(): Promise<number> {
  requirePersonalSession("your signed-in devices");
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
