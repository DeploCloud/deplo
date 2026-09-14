import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { appBasicAuthUsers as basicAuthTable } from "../db/schema/control-plane/domains";
import { getCurrentUser } from "../auth/current-user";
import { newId, nowIso } from "../ids";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret, htpasswdLine } from "../crypto";
import { assertPasswordNotPwned } from "../pwned-password";
import { assertPasswordPolicy } from "../password-policy";
import { appInTeam } from "./app-graph-load";
import { hasAppCapability, requireAppCapability } from "./node-access";
import { authorOf, loadUserIdentities } from "./user-identity";
import type { BasicAuthUser } from "../types/domain";
import type { VarAuthor } from "../types/identity";

// A password is NEVER part of a DTO: the only way back to plaintext is revealBasicAuthPassword.

// BasicAuthUserDTO - a masked DTO for the UI; the password is never sent to the client.
export interface BasicAuthUserDTO {
  id: string;
  // Not exposed over GraphQL; it is here so the mutation edge can re-apply that app's routing without a second lookup.
  appId: string;
  username: string;
  createdBy: VarAuthor | null;
  updatedBy: VarAuthor | null;
  imported: boolean;
  createdAt: string;
  updatedAt: string;
}

// No `:` (htpasswd separator), `,` (Traefik `users=` list), whitespace or quotes (the YAML label).
const USERNAME_RE = /^[^\s:,"`]+$/;

function toDTO(
  u: BasicAuthUser,
  authors: Map<string, VarAuthor> = new Map(),
): BasicAuthUserDTO {
  return {
    id: u.id,
    appId: u.appId,
    username: u.username,
    createdBy: authorOf(u.createdByUserId, authors),
    updatedBy: authorOf(u.updatedByUserId, authors),
    imported: u.imported === true,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

function assemble(row: typeof basicAuthTable.$inferSelect): BasicAuthUser {
  return {
    id: row.id,
    appId: row.appId,
    username: row.username,
    passwordEnc: row.passwordEnc,
    imported: row.imported,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function withAuthors(u: BasicAuthUser): Promise<BasicAuthUserDTO> {
  const authors = await loadUserIdentities([
    u.createdByUserId,
    u.updatedByUserId,
  ]);
  return toDTO(u, authors);
}

// listBasicAuthUsers - a project's basic-auth users, alphabetical by username.
export async function listBasicAuthUsers(
  appId: string,
): Promise<BasicAuthUserDTO[]> {
  // `manage_basic_auth` can be held on the app alone (ADR-0016), so the question is asked at the app.
  if (!(await hasAppCapability(appId, "manage_basic_auth"))) return [];
  const rows = await getDb()
    .select()
    .from(basicAuthTable)
    .where(eq(basicAuthTable.appId, appId))
    .orderBy(asc(basicAuthTable.username));
  const users = rows.map(assemble);
  const authors = await loadUserIdentities(
    users.flatMap((u) => [u.createdByUserId, u.updatedByUserId]),
  );
  return users.map((u) => toDTO(u, authors));
}

// revealBasicAuthPassword - the plaintext of ONE credential; "" always means a decrypt failure.
export async function revealBasicAuthPassword(id: string): Promise<string> {
  const [row] = await getDb()
    .select()
    .from(basicAuthTable)
    .where(eq(basicAuthTable.id, id))
    .limit(1);
  if (!row) throw new Error("Not found");
  // A credential in another team must answer like one that does not exist.
  try {
    await requireAppCapability(row.appId, "manage_basic_auth");
  } catch (e) {
    if ((e as Error).message === "App not found") throw new Error("Not found");
    throw e;
  }
  const password = decryptSecret(row.passwordEnc);
  if (password === "")
    throw new Error(
      `The stored password for "${row.username}" could not be decrypted. ` +
        `Set a new password for this credential.`,
    );
  return password;
}

export async function addBasicAuthUser(
  appId: string,
  username: string,
  password: string,
  opts?: {
    imported?: boolean;
  },
): Promise<BasicAuthUserDTO> {
  const { membership } = await requireAppCapability(appId, "manage_basic_auth");
  const user = (await getCurrentUser())!;
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");
  const name = username.trim();
  if (!USERNAME_RE.test(name))
    throw new Error("Username can't contain spaces, ':' or ','");
  if (!password) throw new Error("Password is required");

  // The (project_id, username) unique index is the real guard against a concurrent double-add.
  const dup = await getDb()
    .select({ id: basicAuthTable.id })
    .from(basicAuthTable)
    .where(
      and(eq(basicAuthTable.appId, appId), eq(basicAuthTable.username, name)),
    )
    .limit(1);
  if (dup.length > 0) throw new Error("A user with that name already exists");
  if (!opts?.imported) {
    assertPasswordPolicy(password);
    await assertPasswordNotPwned(password);
  }

  const now = nowIso();
  const row = {
    id: newId("bau"),
    appId,
    username: name,
    passwordEnc: encryptSecret(password),
    imported: opts?.imported === true,
    createdByUserId: user.id,
    updatedByUserId: user.id,
    createdAt: now,
    updatedAt: now,
  };
  await getDb().insert(basicAuthTable).values(row);
  await recordActivity(
    "domain",
    `Added basic-auth user ${name}`,
    user.name,
    appId,
  );
  return withAuthors(assemble(row));
}

// updateBasicAuthUserPassword - the username is immutable; delete and re-add to rename one.
export async function updateBasicAuthUserPassword(
  id: string,
  password: string,
): Promise<BasicAuthUserDTO> {
  const user = (await getCurrentUser())!;
  if (!password) throw new Error("Password is required");
  const [existing] = await getDb()
    .select()
    .from(basicAuthTable)
    .where(eq(basicAuthTable.id, id))
    .limit(1);
  if (!existing) throw new Error("Not found");
  const { membership } = await requireAppCapability(
    existing.appId,
    "manage_basic_auth",
  );
  if (!(await appInTeam(existing.appId, membership.teamId)))
    throw new Error("Not found");
  assertPasswordPolicy(password);
  await assertPasswordNotPwned(password);
  const updated = {
    ...existing,
    passwordEnc: encryptSecret(password),
    updatedByUserId: user.id,
    updatedAt: nowIso(),
  };
  await getDb()
    .update(basicAuthTable)
    .set({
      passwordEnc: updated.passwordEnc,
      updatedByUserId: updated.updatedByUserId,
      updatedAt: updated.updatedAt,
    })
    .where(eq(basicAuthTable.id, id));
  await recordActivity(
    "domain",
    `Updated basic-auth user ${existing.username}`,
    user.name,
    existing.appId,
  );
  return withAuthors(assemble(updated));
}

export async function removeBasicAuthUser(id: string): Promise<string> {
  const user = (await getCurrentUser())!;
  const [existing] = await getDb()
    .select()
    .from(basicAuthTable)
    .where(eq(basicAuthTable.id, id))
    .limit(1);
  if (!existing) throw new Error("Not found");
  const { membership } = await requireAppCapability(
    existing.appId,
    "manage_basic_auth",
  );
  if (!(await appInTeam(existing.appId, membership.teamId)))
    throw new Error("Not found");
  await getDb().delete(basicAuthTable).where(eq(basicAuthTable.id, id));
  await recordActivity(
    "domain",
    `Removed basic-auth user ${existing.username}`,
    user.name,
    existing.appId,
  );
  return existing.appId;
}

// basicAuthUsersValue - the Traefik `basicauth.users` list, freshly hashed on every call.
export async function basicAuthUsersValue(appId: string): Promise<string> {
  const rows = await getDb()
    .select()
    .from(basicAuthTable)
    .where(eq(basicAuthTable.appId, appId))
    .orderBy(asc(basicAuthTable.username));
  if (rows.length === 0) return "";
  const lines = await Promise.all(
    rows.map((r) => {
      const password = decryptSecret(r.passwordEnc);
      // A credential we cannot decrypt must REMOVE access, never grant it.
      if (password === "")
        throw new Error(
          `Cannot render basic-auth for user "${r.username}": its stored password could not be decrypted. ` +
            `Re-set the basic-auth credentials for this app.`,
        );
      return htpasswdLine(r.username, password);
    }),
  );
  return lines.join(",");
}

// appHasBasicAuth - cheap existence check for renderers that don't need the hashed value.
export async function appHasBasicAuth(appId: string): Promise<boolean> {
  const hit = await getDb()
    .select({ id: basicAuthTable.id })
    .from(basicAuthTable)
    .where(eq(basicAuthTable.appId, appId))
    .limit(1);
  return hit.length > 0;
}
