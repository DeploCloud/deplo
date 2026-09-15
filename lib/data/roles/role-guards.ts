import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb, type DbTx } from "../../db/client";
import {
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
} from "../../db/schema/control-plane/access-control";
import { users as usersTable } from "../../db/schema/control-plane/identity";
import { getCurrentUser } from "../../auth/current-user";

export type Db = ReturnType<typeof getDb> | DbTx;

const MAX_NAME = 40;
const MAX_DESCRIPTION = 160;

export function cleanRoleName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Give the role a name");
  if (name.length > MAX_NAME)
    throw new Error(`Keep the role name under ${MAX_NAME} characters`);
  return name;
}

export function cleanDescription(
  raw: string | undefined | null,
): string | null {
  const text = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (text.length > MAX_DESCRIPTION)
    throw new Error(`Keep the description under ${MAX_DESCRIPTION} characters`);
  return text;
}

export async function roleInTeam(
  db: Db,
  teamId: string,
  roleId: string,
): Promise<{
  id: string;
  builtinKey: string | null;
  name: string;
  description: string | null;
  scoped: boolean;
  requireTwoFactor: boolean;
}> {
  const rows = await db
    .select({
      id: teamRolesTable.id,
      builtinKey: teamRolesTable.builtinKey,
      name: teamRolesTable.name,
      description: teamRolesTable.description,
      scoped: teamRolesTable.scoped,
      requireTwoFactor: teamRolesTable.requireTwoFactor,
    })
    .from(teamRolesTable)
    .where(
      and(eq(teamRolesTable.id, roleId), eq(teamRolesTable.teamId, teamId)),
    )
    .limit(1);
  const role = rows[0];
  if (!role) throw new Error("Role not found");
  return role;
}

export async function assertNameFree(
  tx: DbTx,
  teamId: string,
  name: string,
  exceptRoleId: string | null,
): Promise<void> {
  const rows = await tx
    .select({ id: teamRolesTable.id, name: teamRolesTable.name })
    .from(teamRolesTable)
    .where(eq(teamRolesTable.teamId, teamId));
  const clash = rows.find(
    (r) => r.id !== exceptRoleId && r.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw new Error(`This team already has a role called “${name}”`);
}

export async function actorName(): Promise<string> {
  return (await getCurrentUser())?.name ?? "an admin";
}

export async function assertActorCanMandateTwoFactor(
  userId: string,
  roleId: string,
): Promise<void> {
  const db = getDb();
  const me = (
    await db
      .select({ enabled: usersTable.twoFactorEnabled })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1)
  )[0];
  if (me?.enabled) return;
  const holds = await db
    .select({ id: membershipsTable.id })
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.userId, userId),
        eq(membershipsTable.roleId, roleId),
      ),
    )
    .limit(1);
  if (holds.length > 0)
    throw new Error(
      "You hold this role, so turn on two-factor authentication for your own account first.",
    );
}
