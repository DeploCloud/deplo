import "server-only";

import { cache } from "@/lib/request-cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { users as usersTable } from "../db/schema/control-plane/identity";
import { session as sessionTable } from "../db/schema/auth";
import { avatarUrlFor } from "../avatar";
import type { PublicUser } from "../types/identity";
import { currentIdentity } from "./request-context";
import { authHeaders } from "./session-cookies";
import { getAuth, SESSION_MAX_AGE_MS } from "./better-auth";
import { isSetupNeeded } from "./setup";

// Columns projected for a PublicUser, never a credential.
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
} as const;

// Async only because of `avatarUrl`: resolving it reads the instance's Gravatar flag.
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
}): Promise<PublicUser> {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    name: u.name,
    role: u.role as PublicUser["role"],
    isInstanceAdmin: u.isInstanceAdmin ?? false,
    avatarColor: u.avatarColor,
    avatarUrl: await avatarUrlFor(u),
    twoFactorEnabled: u.twoFactorEnabled ?? false,
  };
}

// This request's Better Auth session, resolved AT MOST ONCE.
const currentSession = cache(async () => {
  if (currentIdentity()) return null;
  const auth = getAuth();
  if (!auth) return null;
  const s = await auth.api
    .getSession({ headers: await authHeaders() })
    .catch(() => null);
  // The absolute lifetime, on top of Better Auth's rolling one.
  if (
    s &&
    Date.now() - new Date(s.session.createdAt).getTime() > SESSION_MAX_AGE_MS
  )
    return null;
  return s;
});

// getCurrentUser resolves the current user from the Better Auth session (ADR-0014).
export const getCurrentUser = cache(async (): Promise<PublicUser | null> => {
  // A bearer-token request (the public GraphQL API) supplies its principal via
  // the request-context override and carries no session cookie.
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
  // A suspended account loses access immediately, even with a live session.
  if (!user || user.suspended) return null;
  return toPublic(user);
});

// currentSessionId is the id of the session row this request is authenticated by, or null.
export const currentSessionId = cache(async (): Promise<string | null> => {
  // An identity that names its session wins: see `RequestIdentity.sessionId`.
  // A bearer token never names one, so it still falls through to null.
  return (
    currentIdentity()?.sessionId ??
    (await currentSession())?.session?.id ??
    null
  );
});

// currentSessionAuthMethod is how the CURRENT request's session proved itself, or null.
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

// requireUser redirects to the setup wizard on a fresh install, otherwise to /login.
export async function requireUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) redirect((await isSetupNeeded()) ? "/setup" : "/login");
  return user;
}

// assertUser is the throwing variant for server actions / route handlers.
export async function assertUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}
