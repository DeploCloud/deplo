import "server-only";

import { cache } from "@/lib/request-cache";

import { assertUser, currentSessionId } from "../auth/current-user";
import { requireAuth } from "../auth/better-auth";
import { requirePersonalSession } from "../auth/request-context";
import { describeUserAgent, type DeviceKind } from "../user-agent";

// Security: `session.token` never leaves this module.

export interface UserSessionDTO {
  id: string;
  current: boolean;
  label: string;
  device: DeviceKind;
  browser: string | null;
  os: string | null;
  ipAddress: string | null;
  lastSeenAt: string;
  createdAt: string;
  expiresAt: string;
}

async function adapter() {
  return (await requireAuth().$context).internalAdapter;
}

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

// listMySessions returns every live session of the current user, most recently seen first.
export const listMySessions = cache(async (): Promise<UserSessionDTO[]> => {
  requirePersonalSession("your signed-in devices");
  const user = await assertUser();
  const current = await currentSessionId();
  return (await liveSessions(user.id)).map((s) => {
    const { label, device, browser, os } = describeUserAgent(s.userAgent);
    return {
      id: s.id,
      current: s.id === current,
      label,
      device,
      browser,
      os,
      // Better Auth writes "" (not null) when it could not determine the address.
      ipAddress: s.ipAddress || null,
      lastSeenAt: new Date(s.updatedAt).toISOString(),
      createdAt: new Date(s.createdAt).toISOString(),
      expiresAt: new Date(s.expiresAt).toISOString(),
    };
  });
});

// revokeSession ends one session by id, answering the same "no longer signed in" for an id that never existed.
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

// revokeOtherSessions ends every session except the one making the request, and reports how many live ones went.
export async function revokeOtherSessions(): Promise<number> {
  requirePersonalSession("your signed-in devices");
  const user = await assertUser();
  const current = await currentSessionId();
  const all = await (await adapter()).listSessions(user.id);
  const doomed = all.filter((s) => s.id !== current);
  if (doomed.length === 0) return 0;
  await (await adapter()).deleteSessions(doomed.map((s) => s.token));
  const now = Date.now();
  return doomed.filter((s) => new Date(s.expiresAt).getTime() > now).length;
}
