import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  projectBasicAuthUsers as basicAuthTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret, htpasswdLine } from "../crypto";
import { projectInTeam } from "./project-graph-load";
import { requireFolderCapabilityForProject } from "./folder-access";
import type { BasicAuthUser } from "../types";

/**
 * Per-project HTTP Basic Auth users.
 *
 * A project's basic-auth users gate EVERY one of its domains: the deploy/reroute
 * renderers read them via {@link basicAuthForProject} and inject a generated
 * Traefik `basicauth` middleware (built from all of them) at the head of every
 * router's middleware chain. Stored passwords are AES-GCM-encrypted (reversible,
 * like env secrets) so the htpasswd credentials can be re-derived on every
 * render; they are write-only over the API and never returned to a client.
 *
 * Gated on `manage_domains` — basic auth is a routing/edge concern attached to a
 * project's domains, so it shares the capability that governs them.
 */

/** A masked DTO for the UI — the password is never sent to the client. */
export interface BasicAuthUserDTO {
  id: string;
  username: string;
  createdAt: string;
  updatedAt: string;
}

/** Usernames are HTTP Basic Auth identities: no `:` (the htpasswd separator),
 * no commas (the Traefik `users=` list separator), no whitespace, non-empty. */
const USERNAME_RE = /^[^\s:,]+$/;

function toDTO(u: BasicAuthUser): BasicAuthUserDTO {
  return {
    id: u.id,
    username: u.username,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

function assemble(row: typeof basicAuthTable.$inferSelect): BasicAuthUser {
  return {
    id: row.id,
    projectId: row.projectId,
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
  projectId: string,
): Promise<BasicAuthUserDTO[]> {
  const { teamId } = await requireCapability("manage_domains");
  if (!(await projectInTeam(projectId, teamId))) return [];
  await requireFolderCapabilityForProject(projectId, "manage_domains");
  const rows = await getDb()
    .select()
    .from(basicAuthTable)
    .where(eq(basicAuthTable.projectId, projectId))
    .orderBy(asc(basicAuthTable.username));
  return rows.map(assemble).map(toDTO);
}

export async function addBasicAuthUser(
  projectId: string,
  username: string,
  password: string,
): Promise<BasicAuthUserDTO> {
  const { membership } = await requireCapability("manage_domains");
  const user = (await getCurrentUser())!;
  if (!(await projectInTeam(projectId, membership.teamId)))
    throw new Error("Project not found");
  await requireFolderCapabilityForProject(projectId, "manage_domains");
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
        eq(basicAuthTable.projectId, projectId),
        eq(basicAuthTable.username, name),
      ),
    )
    .limit(1);
  if (dup.length > 0) throw new Error("A user with that name already exists");

  const now = nowIso();
  const row = {
    id: newId("bau"),
    projectId,
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
    projectId,
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
  if (!(await projectInTeam(existing.projectId, membership.teamId)))
    throw new Error("Not found");
  await requireFolderCapabilityForProject(existing.projectId, "manage_domains");
  const updated = { ...existing, passwordEnc: encryptSecret(password), updatedAt: nowIso() };
  await getDb()
    .update(basicAuthTable)
    .set({ passwordEnc: updated.passwordEnc, updatedAt: updated.updatedAt })
    .where(eq(basicAuthTable.id, id));
  await recordActivity(
    "domain",
    `Updated basic-auth user ${existing.username}`,
    user.name,
    existing.projectId,
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
  if (!(await projectInTeam(existing.projectId, membership.teamId)))
    throw new Error("Not found");
  await requireFolderCapabilityForProject(existing.projectId, "manage_domains");
  await getDb().delete(basicAuthTable).where(eq(basicAuthTable.id, id));
  await recordActivity(
    "domain",
    `Removed basic-auth user ${existing.username}`,
    user.name,
    existing.projectId,
  );
  return existing.projectId;
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
export async function basicAuthUsersValue(projectId: string): Promise<string> {
  const rows = await getDb()
    .select()
    .from(basicAuthTable)
    .where(eq(basicAuthTable.projectId, projectId))
    .orderBy(asc(basicAuthTable.username));
  if (rows.length === 0) return "";
  return rows
    .map((r) => htpasswdLine(r.username, decryptSecret(r.passwordEnc)))
    .join(",");
}

/** Whether a project has any basic-auth users (a cheap existence check for the
 * renderers that don't need the hashed value, e.g. to decide the middleware
 * name). Batched form for callers with several projects is not needed yet. */
export async function projectHasBasicAuth(projectId: string): Promise<boolean> {
  const hit = await getDb()
    .select({ id: basicAuthTable.id })
    .from(basicAuthTable)
    .where(eq(basicAuthTable.projectId, projectId))
    .limit(1);
  return hit.length > 0;
}
