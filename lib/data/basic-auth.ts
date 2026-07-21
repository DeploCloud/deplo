import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  appBasicAuthUsers as basicAuthTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret, htpasswdLine } from "../crypto";
import { appInTeam } from "./app-graph-load";
import { requireFolderCapabilityForApp } from "./folder-access";
import type { BasicAuthUser } from "../types";

/**
 * Per-project HTTP Basic Auth users.
 *
 * A project's basic-auth users gate EVERY one of its domains: the deploy/reroute
 * renderers read them via {@link basicAuthUsersValue} and inject a generated
 * Traefik `basicauth` middleware (built from all of them) at the head of every
 * router's middleware chain. Stored passwords are AES-GCM-encrypted (reversible,
 * like env secrets) so the htpasswd credentials can be re-derived on every
 * render; they are write-only over the API and never returned to a client.
 *
 * Every mutation here is DB-only — the labels live on the running container, so
 * a write takes effect only once the stack is re-rendered. The API edge does
 * that for the caller (`lib/graphql/types/basic-auth.ts` re-applies routing after
 * each mutation, exactly as the domain mutations do), so a credential is live
 * seconds after it is saved. That reroute is NOT invoked from here: this module
 * is imported BY the deploy engine (`lib/deploy/build.ts` reads
 * {@link basicAuthUsersValue} when rendering), so calling back into it would
 * close an import cycle.
 *
 * Gated on `manage_domains` — basic auth is a routing/edge concern attached to a
 * project's domains, so it shares the capability that governs them.
 */

/** A masked DTO for the UI — the password is never sent to the client. */
export interface BasicAuthUserDTO {
  id: string;
  /** The owning app. Not exposed over GraphQL (the client already knows which
   * app it is looking at); it is here so the mutation edge can re-apply that
   * app's routing without a second lookup. */
  appId: string;
  username: string;
  createdAt: string;
  updatedAt: string;
}

/** Usernames are HTTP Basic Auth identities: no `:` (the htpasswd separator),
 * no commas (the Traefik `users=` list separator), no whitespace, and no `"` or
 * backtick (the username is embedded in a compose YAML label / Traefik rule and
 * a quote would break the scalar), non-empty. */
const USERNAME_RE = /^[^\s:,"`]+$/;

function toDTO(u: BasicAuthUser): BasicAuthUserDTO {
  return {
    id: u.id,
    appId: u.appId,
    username: u.username,
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The basic-auth users of a project, alphabetical by username. Requires
 * `manage_domains` — an out-of-team project yields none (matches a hidden tab).
 */
export async function listBasicAuthUsers(
  appId: string,
): Promise<BasicAuthUserDTO[]> {
  const { teamId } = await requireCapability("manage_domains");
  if (!(await appInTeam(appId, teamId))) return [];
  await requireFolderCapabilityForApp(appId, "manage_domains");
  const rows = await getDb()
    .select()
    .from(basicAuthTable)
    .where(eq(basicAuthTable.appId, appId))
    .orderBy(asc(basicAuthTable.username));
  return rows.map(assemble).map(toDTO);
}

export async function addBasicAuthUser(
  appId: string,
  username: string,
  password: string,
): Promise<BasicAuthUserDTO> {
  const { membership } = await requireCapability("manage_domains");
  const user = (await getCurrentUser())!;
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");
  await requireFolderCapabilityForApp(appId, "manage_domains");
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
      and(
        eq(basicAuthTable.appId, appId),
        eq(basicAuthTable.username, name),
      ),
    )
    .limit(1);
  if (dup.length > 0) throw new Error("A user with that name already exists");

  const now = nowIso();
  const row = {
    id: newId("bau"),
    appId,
    username: name,
    passwordEnc: encryptSecret(password),
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
  return toDTO(assemble(row));
}

/** Change a basic-auth user's password (the username is immutable — it is the
 * stable identity; deleting + re-adding is how you rename one). */
export async function updateBasicAuthUserPassword(
  id: string,
  password: string,
): Promise<BasicAuthUserDTO> {
  const { membership } = await requireCapability("manage_domains");
  const user = (await getCurrentUser())!;
  if (!password) throw new Error("Password is required");
  const [existing] = await getDb()
    .select()
    .from(basicAuthTable)
    .where(eq(basicAuthTable.id, id))
    .limit(1);
  if (!existing) throw new Error("Not found");
  if (!(await appInTeam(existing.appId, membership.teamId)))
    throw new Error("Not found");
  await requireFolderCapabilityForApp(existing.appId, "manage_domains");
  const updated = { ...existing, passwordEnc: encryptSecret(password), updatedAt: nowIso() };
  await getDb()
    .update(basicAuthTable)
    .set({ passwordEnc: updated.passwordEnc, updatedAt: updated.updatedAt })
    .where(eq(basicAuthTable.id, id));
  await recordActivity(
    "domain",
    `Updated basic-auth user ${existing.username}`,
    user.name,
    existing.appId,
  );
  return toDTO(assemble(updated));
}

export async function removeBasicAuthUser(id: string): Promise<string> {
  const { membership } = await requireCapability("manage_domains");
  const user = (await getCurrentUser())!;
  const [existing] = await getDb()
    .select()
    .from(basicAuthTable)
    .where(eq(basicAuthTable.id, id))
    .limit(1);
  if (!existing) throw new Error("Not found");
  if (!(await appInTeam(existing.appId, membership.teamId)))
    throw new Error("Not found");
  await requireFolderCapabilityForApp(existing.appId, "manage_domains");
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
 * The Traefik `basicauth.users` value for a project — a comma-separated list of
 * `user:apr1-hash` htpasswd lines, freshly hashed from the stored (decrypted)
 * passwords on every call. Empty string when the project has no basic-auth users
 * (the renderers then emit NO middleware, keeping the stack byte-identical to a
 * project that never had basic auth). Store-direct (no auth) so the deploy engine
 * can call it like the routing readers do.
 *
 * NOTE: the returned hashes contain literal `$`. The single-image renderer
 * embeds them in a docker-compose label and MUST double them to `$$` (compose
 * treats `$` as variable interpolation); the compose renderer does the same via
 * the shared escaping. This function returns the RAW (single-`$`) form.
 */
export async function basicAuthUsersValue(appId: string): Promise<string> {
  const rows = await getDb()
    .select()
    .from(basicAuthTable)
    .where(eq(basicAuthTable.appId, appId))
    .orderBy(asc(basicAuthTable.username));
  if (rows.length === 0) return "";
  return rows
    .map((r) => {
      const password = decryptSecret(r.passwordEnc);
      // decryptSecret fails CLOSED to "" (wrong/rotated key, restored DB, corrupt
      // ciphertext). For a normal secret that is fine, but here an empty password
      // would be hashed into a VALID apr1 hash of the empty string — the basic-auth
      // middleware would stay active and accept an empty password (fail OPEN). A
      // credential we cannot decrypt must REMOVE access, never grant it, so fail
      // the render loudly instead. (Empty passwords can't be stored — addBasicAuthUser
      // rejects them — so "" here always means a decrypt failure.)
      if (password === "")
        throw new Error(
          `Cannot render basic-auth for user "${r.username}": its stored password could not be decrypted. ` +
            `Re-set the basic-auth credentials for this app.`,
        );
      return htpasswdLine(r.username, password);
    })
    .join(",");
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
