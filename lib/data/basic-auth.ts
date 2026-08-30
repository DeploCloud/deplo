// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { appBasicAuthUsers as basicAuthTable } from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret, htpasswdLine } from "../crypto";
import { assertPasswordNotPwned } from "../pwned-password";
import { assertPasswordPolicy } from "../password-policy";
import { appInTeam } from "./app-graph-load";
import { hasAppCapability, requireAppCapability } from "./node-access";
import { authorOf, loadUserIdentities } from "./user-identity";
import type { BasicAuthUser, VarAuthor } from "../types";

/**
 * Per-project HTTP Basic Auth users. A password is NEVER part of a DTO; the only
 * way back to the plaintext is {@link revealBasicAuthPassword}, one credential at
 * a time, behind the same `manage_basic_auth` gate as every write here.
 */

/** A masked DTO for the UI - the password is never sent to the client. */
export interface BasicAuthUserDTO {
  id: string;
  /** The owning app. Not exposed over GraphQL (the client already knows which
   * app it is looking at); it is here so the mutation edge can re-apply that
   * app's routing without a second lookup. */
  appId: string;
  username: string;
  /**
   * Who added the credential, and who last changed its password. Identity metadata -
   * safe to project while the password itself never is.
   */
  createdBy: VarAuthor | null;
  updatedBy: VarAuthor | null;
  /**
   * The credential came from another platform verbatim, so it never went through
   * Deplo's password policy or the breach check.
   */
  imported: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Usernames are HTTP Basic Auth identities: no `:` (the htpasswd separator), no
 * commas (the Traefik `users=` list separator), no whitespace, and no `"` or
 * backtick (the username is embedded in a compose YAML label / Traefik rule and a
 * quote would break the scalar), non-empty.
 */
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

/**
 * Resolve one credential's authors for the DTO a mutation hands back.
 */
async function withAuthors(u: BasicAuthUser): Promise<BasicAuthUserDTO> {
  const authors = await loadUserIdentities([
    u.createdByUserId,
    u.updatedByUserId,
  ]);
  return toDTO(u, authors);
}

/**
 * The basic-auth users of a project, alphabetical by username. Requires
 * `manage_basic_auth` - an out-of-team project yields none (matches a hidden tab).
 */
export async function listBasicAuthUsers(
  appId: string,
): Promise<BasicAuthUserDTO[]> {
  // A read: an app the caller can't reach lists nothing rather than throwing, so
  // the tab is simply absent. `manage_basic_auth` can be held on the app alone
  // (ADR-0016), which is why the question is asked at the app.
  if (!(await hasAppCapability(appId, "manage_basic_auth"))) return [];
  const rows = await getDb()
    .select()
    .from(basicAuthTable)
    .where(eq(basicAuthTable.appId, appId))
    .orderBy(asc(basicAuthTable.username));
  const users = rows.map(assemble);
  // ONE identity query for the whole page, never one per credential.
  const authors = await loadUserIdentities(
    users.flatMap((u) => [u.createdByUserId, u.updatedByUserId]),
  );
  return users.map((u) => toDTO(u, authors));
}

/**
 * The plaintext password of ONE credential, for the person who may change it.
 * Empty passwords are rejected at write time, so `""` here always means a decrypt
 * failure - the same reasoning as {@link basicAuthUsersValue}.
 */
export async function revealBasicAuthPassword(id: string): Promise<string> {
  const [row] = await getDb()
    .select()
    .from(basicAuthTable)
    .where(eq(basicAuthTable.id, id))
    .limit(1);
  if (!row) throw new Error("Not found");
  // A credential in ANOTHER team answers exactly like one that does not exist: the
  // gate's own "App not found" would otherwise tell a caller holding a stranger's id
  // that it is real.
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
    /**
     * The credential is being CARRIED OVER from another platform, not chosen.
     */
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

  // Friendly pre-check; the (project_id, username) unique index is the real guard
  // against a concurrent double-add.
  const dup = await getDb()
    .select({ id: basicAuthTable.id })
    .from(basicAuthTable)
    .where(
      and(eq(basicAuthTable.appId, appId), eq(basicAuthTable.username, name)),
    )
    .limit(1);
  if (dup.length > 0) throw new Error("A user with that name already exists");
  // A basic-auth credential is a password a PERSON chooses and is handed to another
  // person, on an internet-facing URL: same two gates as an account password, in the
  // same order (the local rules before the network call).
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
    // Both stamped on create: "added by" is the author of record until someone
    // rotates the password, and the Access page reads `updatedBy ?? createdBy`
    // exactly as the variables table does.
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

/** Change a basic-auth user's password (the username is immutable - it is the
 * stable identity; deleting + re-adding is how you rename one). */
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
  // A basic-auth credential is a password a PERSON chooses and is handed to
  // another person, on an internet-facing URL: same two gates as an account
  // password, in the same order (the local rules before the network call).
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

/**
 * The Traefik `basicauth.users` value for a project - a comma-separated list of
 * `user:bcrypt-hash` htpasswd lines, freshly hashed from the stored (decrypted)
 * passwords on every call.
 */
export async function basicAuthUsersValue(appId: string): Promise<string> {
  const rows = await getDb()
    .select()
    .from(basicAuthTable)
    .where(eq(basicAuthTable.appId, appId))
    .orderBy(asc(basicAuthTable.username));
  if (rows.length === 0) return "";
  // `htpasswdLine` is async (bcrypt), so the map is awaited rather than joined
  // directly. Parallel: the hashes are independent and each is ~60ms.
  const lines = await Promise.all(
    rows.map((r) => {
      const password = decryptSecret(r.passwordEnc);
      // decryptSecret fails CLOSED to "" (wrong/rotated key, restored DB, corrupt
      // ciphertext). A credential we cannot decrypt must REMOVE access, never grant it,
      // so fail the render loudly instead.
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

/** Whether a project has any basic-auth users (a cheap existence check for the
 * renderers that don't need the hashed value, e.g. to decide the middleware
 * name). Batched form for callers with several apps is not needed yet. */
export async function appHasBasicAuth(appId: string): Promise<boolean> {
  const hit = await getDb()
    .select({ id: basicAuthTable.id })
    .from(basicAuthTable)
    .where(eq(basicAuthTable.appId, appId))
    .limit(1);
  return hit.length > 0;
}
