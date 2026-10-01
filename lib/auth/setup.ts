import "server-only";

import { and, asc, count, eq, ne } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane/identity";
import { constantTimeEquals, deriveKey } from "../crypto";
import { assertPasswordPolicy, PasswordError } from "../password-policy";
import { assertPasswordNotPwned } from "../pwned-password";
import { monogramColor } from "../avatar-colors";
import { publicBaseUrl, PUBLIC_URL_PLACEHOLDER } from "../public-url";
import type { User } from "../types/identity";
import type { Team } from "../types/team";
import {
  claimTeamName,
  cleanOwnerFields,
  createAccountWithTeam,
} from "./create-account";
import { assertUser } from "./current-user";
import { setUserPassword } from "./password-credential";
import { revokeAllSessions } from "./session-records";
import { startSessionFor } from "./sign-in";

export async function isSetupNeeded(): Promise<boolean> {
  const n = (await getDb().select({ n: count() }).from(usersTable))[0]!.n;
  return n === 0;
}

export type SetupKeyState = "ok" | "missing" | "wrong";

// Never empty: without DEPLO_SETUP_KEY the key derives from DEPLO_SECRET and the boot log prints the link.
export function setupKey(): string {
  return (
    process.env.DEPLO_SETUP_KEY?.trim() ||
    deriveKey("setup").toString("hex").slice(0, 32)
  );
}

export function checkSetupKey(
  presented: string | null | undefined,
): SetupKeyState {
  if (!presented) return "missing";
  return constantTimeEquals(presented, setupKey()) ? "ok" : "wrong";
}

export async function logSetupLink(): Promise<void> {
  if (process.env.DEPLO_SETUP_KEY?.trim() || !(await isSetupNeeded())) return;
  const base = publicBaseUrl() ?? PUBLIC_URL_PLACEHOLDER;
  console.log(
    `[deplo] No account yet. Create it at ${base}/setup?key=${setupKey()}`,
  );
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

// The installer created this account with the host's temporary password; the owner makes it theirs.
export async function finishSetup(input: {
  username?: string | null;
  name: string;
  password: string;
  image?: string | null;
  teamName: string;
  teamImage?: string | null;
}): Promise<{ ok: boolean; error?: string; field?: "password" }> {
  const user = await assertUser();
  let teamId: string;
  try {
    const fields = cleanOwnerFields(input);
    assertPasswordPolicy(input.password);
    await assertPasswordNotPwned(input.password);
    teamId = await getDb().transaction(async (tx) => {
      const taken = await tx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(
          and(
            eq(usersTable.username, fields.username),
            ne(usersTable.id, user.id),
          ),
        )
        .limit(1);
      if (taken[0]) throw new Error("That username is taken");
      const claimed = await tx
        .update(usersTable)
        .set({
          name: fields.name,
          username: fields.username,
          avatarColor: monogramColor(fields.name),
          ...(fields.image ? { image: fields.image } : {}),
          mustChangePassword: false,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(usersTable.id, user.id),
            eq(usersTable.mustChangePassword, true),
          ),
        )
        .returning({ id: usersTable.id });
      if (claimed.length === 0)
        throw new Error("This account is already set up");

      const team = (
        await tx
          .select({ id: teamsTable.id })
          .from(teamsTable)
          .where(eq(teamsTable.founderUserId, user.id))
          .orderBy(asc(teamsTable.createdAt))
          .limit(1)
      )[0];
      if (!team) throw new Error("This account has no team to set up");
      // Re-slugging is safe here: the gate kept every caller out of this team until now.
      const slug = await claimTeamName(tx, fields.teamName, team.id);
      await tx
        .update(teamsTable)
        .set({
          name: fields.teamName,
          slug,
          ...(fields.teamImage ? { image: fields.teamImage } : {}),
        })
        .where(eq(teamsTable.id, team.id));
      await setUserPassword(user.id, input.password, tx);
      return team.id;
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Setup failed",
      ...(e instanceof PasswordError ? { field: "password" as const } : {}),
    };
  }

  await revokeAllSessions(user.id);
  await startSessionFor(user.email, input.password, teamId);
  return { ok: true };
}
