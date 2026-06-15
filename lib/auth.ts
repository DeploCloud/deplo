import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { read, mutate, ensureStoreReady } from "./store";
import {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
} from "./crypto";
import type { PublicUser, User } from "./types";
import { randomBytes } from "node:crypto";

const SESSION_COOKIE = "deplo_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function toPublic(u: User): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    avatarColor: u.avatarColor,
  };
}

/**
 * Resolve the current user from the signed session cookie.
 * Cached per-request so it can be called from many places cheaply.
 * Returns null when unauthenticated. Never throws.
 */
export const getCurrentUser = cache(async (): Promise<PublicUser | null> => {
  await ensureStoreReady();
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const payload = verifySession(token);
  if (!payload) return null;
  const user = read().users.find((u) => u.id === payload.uid);
  return user ? toPublic(user) : null;
});

/** Require an authenticated user or redirect to /login. */
export async function requireUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Throwing variant for server actions / route handlers. */
export async function assertUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}

async function setSessionCookie(userId: string) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = signSession({ uid: userId, exp });
  const store = await cookies();
  // Secure must track the *actual* scheme, not NODE_ENV: a production instance
  // served over http://<ip> (no domain/TLS yet) would otherwise drop the cookie.
  const secure = (process.env.DEPLO_PUBLIC_URL ?? "").startsWith("https://");
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function login(
  email: string,
  password: string
): Promise<{ ok: boolean; error?: string }> {
  await ensureStoreReady();
  const user = read().users.find(
    (u) => u.email.toLowerCase() === email.toLowerCase().trim()
  );
  // Always run a hash comparison to reduce user-enumeration timing signal.
  const stored =
    user?.passwordHash ??
    "scrypt$00000000000000000000000000000000$00000000000000000000000000000000";
  const valid = verifyPassword(password, stored);
  if (!user || !valid) return { ok: false, error: "Invalid email or password" };
  await setSessionCookie(user.id);
  return { ok: true };
}

export async function signup(
  name: string,
  email: string,
  password: string
): Promise<{ ok: boolean; error?: string }> {
  await ensureStoreReady();
  const normalized = email.toLowerCase().trim();
  const exists = read().users.some((u) => u.email.toLowerCase() === normalized);
  if (exists) return { ok: false, error: "An account with this email exists" };
  const colors = ["#50e3c2", "#f5a623", "#7928ca", "#ff0080", "#0070f3"];
  const user: User = {
    id: `usr_${randomBytes(8).toString("hex")}`,
    email: normalized,
    name: name.trim() || normalized.split("@")[0],
    passwordHash: hashPassword(password),
    role: read().users.length === 0 ? "owner" : "member",
    avatarColor: colors[read().users.length % colors.length],
    createdAt: new Date().toISOString(),
  };
  mutate((d) => d.users.push(user));
  await setSessionCookie(user.id);
  return { ok: true };
}

export async function logout() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export { SESSION_COOKIE };
