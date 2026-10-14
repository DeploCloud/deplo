import "server-only";

import { cache } from "@/lib/request-cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { users as usersTable } from "../db/schema/control-plane/identity";
import { session as sessionTable } from "../db/schema/auth";
import { apiTokens } from "../db/schema/control-plane/api-tokens";
import { avatarUrlFor } from "../avatar";
import type { PublicUser } from "../types/identity";
import { currentIdentity } from "./request-context";
import { authHeaders } from "./session-cookies";
import { SESSION_MAX_AGE_MS } from "./session-constants";

const PUBLIC_USER_COLS = {
  id: usersTable.id,
  email: usersTable.email,
  username: usersTable.username,
  name: usersTable.name,
  role: usersTable.role,
  isInstanceAdmin: usersTable.isInstanceAdmin,
  avatarColor: usersTable.avatarColor,
  image: usersTable.image,
  twoFactorEnabled: usersTable.twoFactorEnabled,
  mustChangePassword: usersTable.mustChangePassword,
} as const;

async function toPublic(u: {
  id: string;
  email: string;
  username: string;
  name: string;
  role: string;
  isInstanceAdmin: boolean | null;
  avatarColor: string;
  image: string | null;
  twoFactorEnabled: boolean | null;
  mustChangePassword: boolean | null;
}): Promise<PublicUser> {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    name: u.name,
    role: u.role as PublicUser["role"],
    // A temporary password the host also knows must not reach instance-admin powers.
    isInstanceAdmin: (u.isInstanceAdmin ?? false) && !u.mustChangePassword,
    avatarColor: u.avatarColor,
    avatarUrl: await avatarUrlFor(u),
    twoFactorEnabled: u.twoFactorEnabled ?? false,
  };
}

const currentSession = cache(async () => {
  if (currentIdentity()) return null;
  // Lazy: a token, MCP or test identity never reads a cookie, so never pays for the auth library.
  const { getAuth } = await import("./better-auth");
  const auth = getAuth();
  if (!auth) return null;
  const s = await auth.api
    .getSession({ headers: await authHeaders() })
    .catch(() => null);
  if (
    s &&
    Date.now() - new Date(s.session.createdAt).getTime() > SESSION_MAX_AGE_MS
  )
    return null;
  return s;
});

export const getCurrentUser = cache(async (): Promise<PublicUser | null> => {
  const override = currentIdentity();
  let uid = override?.userId;
  if (!uid) uid = (await currentSession())?.user?.id;
  if (!uid) return null;
  const rows = await getDb()
    .select({ ...PUBLIC_USER_COLS, suspended: usersTable.suspended })
    .from(usersTable)
    .where(eq(usersTable.id, uid))
    .limit(1);
  const user = rows[0];
  if (!user || user.suspended) return null;
  return toPublic(user);
});

export const currentSessionId = cache(async (): Promise<string | null> => {
  return (
    currentIdentity()?.sessionId ??
    (await currentSession())?.session?.id ??
    null
  );
});

// Wraps a stream's access check with the sign-in it was opened under, re-read from the rows, never the cookie.
export async function whileSignedIn(
  userId: string,
  check: () => Promise<boolean>,
): Promise<() => Promise<boolean>> {
  const sessionId = await currentSessionId();
  const tokenId = currentIdentity()?.token?.id ?? null;
  return async () =>
    (await signInIsLive(userId, sessionId, tokenId)) && (await check());
}

async function signInIsLive(
  userId: string,
  sessionId: string | null,
  tokenId: string | null,
): Promise<boolean> {
  const db = getDb();
  const now = Date.now();
  const [user] = await db
    .select({ suspended: usersTable.suspended })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user || user.suspended) return false;
  if (sessionId) {
    const [s] = await db
      .select({
        userId: sessionTable.userId,
        expiresAt: sessionTable.expiresAt,
        createdAt: sessionTable.createdAt,
      })
      .from(sessionTable)
      .where(eq(sessionTable.id, sessionId))
      .limit(1);
    if (
      !s ||
      s.userId !== userId ||
      s.expiresAt.getTime() <= now ||
      now - s.createdAt.getTime() > SESSION_MAX_AGE_MS
    )
      return false;
  }
  if (tokenId) {
    const [t] = await db
      .select({ expiresAt: apiTokens.expiresAt })
      .from(apiTokens)
      .where(eq(apiTokens.id, tokenId))
      .limit(1);
    if (!t || (t.expiresAt && Date.parse(t.expiresAt) <= now)) return false;
  }
  return true;
}

export const currentSessionAuthMethod = cache(
  async (): Promise<string | null> => {
    const id = await currentSessionId();
    if (!id) return null;
    const rows = await getDb()
      .select({ method: sessionTable.authMethod })
      .from(sessionTable)
      .where(eq(sessionTable.id, id))
      .limit(1);
    return rows[0]?.method ?? null;
  },
);

export async function requireUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) {
    const { isSetupNeeded } = await import("./setup");
    redirect((await isSetupNeeded()) ? "/setup" : "/login");
  }
  return user;
}

export async function assertUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}
