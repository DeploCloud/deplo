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

const currentSession = cache(async () => {
  if (currentIdentity()) return null;
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
  if (!user) redirect((await isSetupNeeded()) ? "/setup" : "/login");
  return user;
}

export async function assertUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}
