"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { run, type ActionResult } from "./result";
import { consumeRegistrationLinkInDraft } from "@/lib/data/members";
import { createAccountWithTeam, startSessionFor } from "@/lib/auth";
import { ensureStoreReady } from "@/lib/store";
import { normalizeUsername, validateUsername } from "@/lib/username";
import { rateLimit } from "@/lib/security";

/**
 * Register a brand-new account AND its own team through a single-use link
 * (`/register/<token>`). Token-gated + rate limited. On success the account +
 * team are created, the link is consumed, and the user is signed in.
 */
const registerSchema = z.object({
  token: z.string().min(8).max(200),
  username: z.string().min(3).max(32),
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  teamName: z.string().min(1).max(80),
});

export async function registerThroughLinkAction(
  input: z.input<typeof registerSchema>,
): Promise<ActionResult> {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };

  await ensureStoreReady();

  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "local";
  const limited =
    !rateLimit(`register:ip:${ip}`, { limit: 10, windowMs: 60_000 }).ok ||
    !rateLimit(`register:token:${parsed.data.token.slice(0, 12)}`, {
      limit: 8,
      windowMs: 60_000,
    }).ok;
  if (limited)
    return { ok: false, error: "Too many attempts. Try again shortly." };

  const username = normalizeUsername(parsed.data.username);
  const usernameError = validateUsername(username);
  if (usernameError) return { ok: false, error: usernameError };

  const res = await run(async () => {
    // The token is consumed INSIDE the same atomic mutate() that creates the
    // account+team (via the guard), so check-create-consume is one critical
    // section — a concurrent double-submit can't mint two accounts from one
    // single-use link. If the guard throws (already used/expired), nothing is
    // persisted.
    const { user, team } = createAccountWithTeam(
      {
        username,
        name: parsed.data.name,
        email: parsed.data.email,
        password: parsed.data.password,
        teamName: parsed.data.teamName,
      },
      {
        guard: (data) =>
          consumeRegistrationLinkInDraft(data, parsed.data.token, username),
      },
    );
    return { userId: user.id, teamId: team.id };
  });
  if (!res.ok) return res as ActionResult;
  await startSessionFor(res.data!.userId, res.data!.teamId);
  return { ok: true };
}
