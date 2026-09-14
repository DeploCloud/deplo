import "server-only";

import { count } from "drizzle-orm";
import { getDb } from "../db/client";
import { users as usersTable } from "../db/schema/control-plane/identity";
import { constantTimeEquals } from "../crypto";
import { PasswordError } from "../password-policy";
import type { User } from "../types/identity";
import type { Team } from "../types/team";
import { createAccountWithTeam } from "./create-account";
import { startSessionFor } from "./sign-in";

// isSetupNeeded is true on a fresh install with no account yet.
export async function isSetupNeeded(): Promise<boolean> {
  const n = (await getDb().select({ n: count() }).from(usersTable))[0]!.n;
  return n === 0;
}

export type SetupKeyState = "ok" | "missing" | "wrong";

// checkSetupKey validates the installer's `DEPLO_SETUP_KEY`, so the first account is
// claimed by whoever ran the install rather than by whoever reaches the panel first.
// No key configured leaves setup exactly as it was.
export function checkSetupKey(
  presented: string | null | undefined,
): SetupKeyState {
  const expected = process.env.DEPLO_SETUP_KEY?.trim();
  if (!expected) return "ok";
  if (!presented) return "missing";
  return constantTimeEquals(presented, expected) ? "ok" : "wrong";
}

// completeSetup creates the first workspace + owner account, then signs the owner in.
export async function completeSetup(input: {
  username?: string | null;
  teamName: string;
  name: string;
  email: string;
  password: string;
  image?: string | null;
  teamImage?: string | null;
  /** From the installer's setup link. Checked before anything touches the db. */
  key?: string | null;
}): Promise<{ ok: boolean; error?: string; field?: "password" }> {
  if (checkSetupKey(input.key) !== "ok")
    return { ok: false, error: "That setup link is not valid." };

  const existing = (await getDb().select({ n: count() }).from(usersTable))[0]!
    .n;
  if (existing > 0)
    return { ok: false, error: "Setup has already been completed" };

  let user: User;
  let team: Team;
  try {
    ({ user, team } = await createAccountWithTeam(
      {
        username: input.username,
        name: input.name,
        email: input.email,
        password: input.password,
        teamName: input.teamName.trim() || "Workspace",
        image: input.image,
        teamImage: input.teamImage,
      },
      { isInstanceAdmin: true, isInstanceOwner: true },
    ));
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Setup failed",
      // Which FIELD was refused, so a two-step form can send the reader back to
      // it: the password is checked here, one step after it was typed.
      ...(e instanceof PasswordError ? { field: "password" as const } : {}),
    };
  }

  await startSessionFor(user.email, input.password, team.id);
  return { ok: true };
}
