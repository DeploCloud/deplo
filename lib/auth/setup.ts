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

export async function isSetupNeeded(): Promise<boolean> {
  const n = (await getDb().select({ n: count() }).from(usersTable))[0]!.n;
  return n === 0;
}

export type SetupKeyState = "ok" | "missing" | "wrong";

export function checkSetupKey(
  presented: string | null | undefined,
): SetupKeyState {
  const expected = process.env.DEPLO_SETUP_KEY?.trim();
  // No key configured leaves setup as it was: the first account goes to whoever reaches the panel first.
  if (!expected) return "ok";
  if (!presented) return "missing";
  return constantTimeEquals(presented, expected) ? "ok" : "wrong";
}

export async function completeSetup(input: {
  username?: string | null;
  teamName: string;
  name: string;
  email: string;
  password: string;
  image?: string | null;
  teamImage?: string | null;
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
      ...(e instanceof PasswordError ? { field: "password" as const } : {}),
    };
  }

  await startSessionFor(user.email, input.password, team.id);
  return { ok: true };
}
