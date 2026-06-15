"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { login, signup, logout } from "@/lib/auth";
import { rateLimit } from "@/lib/security";

/**
 * Best-effort client IP. NOTE: X-Forwarded-For is attacker-spoofable when the
 * upstream proxy doesn't strip it, so it is used only as a *secondary* limiter
 * dimension. The non-spoofable dimensions (target email + a global counter)
 * are what actually bound brute force — header rotation cannot reset those.
 */
async function clientKey(scope: string): Promise<string> {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "local";
  return `${scope}:${ip}`;
}

/** Throws-style helper: returns an error message when any limiter trips. */
function checkLimits(
  checks: { key: string; limit: number; windowMs: number }[]
): string | null {
  let worst = 0;
  for (const c of checks) {
    const r = rateLimit(c.key, { limit: c.limit, windowMs: c.windowMs });
    if (!r.ok) worst = Math.max(worst, r.retryAfterSec);
  }
  return worst > 0 ? `Too many attempts. Try again in ${worst}s.` : null;
}

export interface AuthState {
  error?: string;
}

const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

export async function loginAction(
  _prev: AuthState,
  formData: FormData
): Promise<AuthState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const email = parsed.data.email.toLowerCase().trim();
  const limited = checkLimits([
    // Non-spoofable: caps guesses against a single account...
    { key: `login:email:${email}`, limit: 8, windowMs: 60_000 },
    // ...and total login throughput regardless of header rotation.
    { key: "login:global", limit: 100, windowMs: 60_000 },
    // Best-effort per-IP (spoofable, so generous).
    { key: await clientKey("login"), limit: 30, windowMs: 60_000 },
  ]);
  if (limited) return { error: limited };

  const res = await login(email, parsed.data.password);
  if (!res.ok) return { error: res.error };
  redirect("/");
}

const signupSchema = z.object({
  name: z.string().min(1, "Name is required").max(80),
  email: z.string().email("Enter a valid email"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(200),
});

export async function signupAction(
  _prev: AuthState,
  formData: FormData
): Promise<AuthState> {
  const parsed = signupSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const email = parsed.data.email.toLowerCase().trim();
  const limited = checkLimits([
    { key: `signup:email:${email}`, limit: 3, windowMs: 60_000 },
    { key: "signup:global", limit: 20, windowMs: 60_000 },
    { key: await clientKey("signup"), limit: 10, windowMs: 60_000 },
  ]);
  if (limited) return { error: limited };

  const res = await signup(
    parsed.data.name,
    parsed.data.email,
    parsed.data.password
  );
  if (!res.ok) return { error: res.error };
  redirect("/");
}

export async function logoutAction() {
  await logout();
  redirect("/login");
}
