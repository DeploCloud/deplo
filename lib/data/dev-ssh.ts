import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { devSshUser as devSshUserTable } from "../db/schema/control-plane";
import { assembleDevSshUser, devSshUserToRow } from "./infra-rows";
import { requireFolderCapabilityForProject } from "./folder-access";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { encryptSecret } from "../crypto";
import { recordActivity } from "./activity";
import {
  loadProjectGraph,
  loadTeamProject,
  projectInTeam,
} from "./project-graph-load";
import { provisionUser, deprovisionUser } from "../infra/ssh-gateway";
import type { DevSshUser, DevSshUserDTO } from "../types";

/**
 * `dev_ssh_user` is RELATIONAL as of cut-set (e) (relational-store PLAN Step 6).
 * It is the sole source of truth for the SSH gateway projection (ADR-0002); the
 * gateway reconciles from these rows. `username` is UNIQUE globally, and a CHECK
 * enforces "at least one credential" (public key OR password).
 */

/** A user-supplied name component → a gateway-safe, lowercased token. */
function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
}

/** Reject any control char / newline — these break the chpasswd-stdin and the
 *  authorized_keys line, and a newline in a password would inject a SECOND
 *  `user:password` mapping (cross-account takeover). */
function hasControlChars(s: string): boolean {
  return /[\x00-\x1f\x7f]/.test(s);
}

/** A public key must be a single, well-formed authorized_keys line. */
const PUBKEY_RE =
  /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-[a-z0-9-]+|sk-(ssh-ed25519|ecdsa-sha2-[a-z0-9-]+)@openssh\.com) [A-Za-z0-9+/=]+( \S.*)?$/;

/** Mask the password (write-only — no reveal path, unlike EnvVarDTO). */
function toDTO(u: DevSshUser): DevSshUserDTO {
  return {
    id: u.id,
    username: u.username,
    publicKey: u.publicKey,
    hasPassword: u.passwordEnc !== null,
    createdAt: u.createdAt,
  };
}

/** A project's SSH users (relational), oldest-first (insertion order). */
async function projectDevSshUsers(projectId: string): Promise<DevSshUser[]> {
  const rows = await getDb()
    .select()
    .from(devSshUserTable)
    .where(eq(devSshUserTable.projectId, projectId))
    .orderBy(devSshUserTable.createdAt);
  return rows.map(assembleDevSshUser);
}

/** List a project's SSH users (passwords never leave the server). */
export async function listDevSshUsers(
  projectId: string,
): Promise<DevSshUserDTO[]> {
  const teamId = await requireActiveTeamId();
  if (!(await projectInTeam(projectId, teamId))) return [];
  return (await projectDevSshUsers(projectId)).map(toDTO);
}

/** Whether a project has at least one SSH user (drift-repair gate, relational). */
export async function projectHasDevSshUsers(projectId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: devSshUserTable.id })
    .from(devSshUserTable)
    .where(eq(devSshUserTable.projectId, projectId))
    .limit(1);
  return rows.length > 0;
}

/** Every stored DevSshUser whose project lives on a server (gateway reconcile). */
export async function listDevSshUsersForProjects(
  projectIds: string[],
): Promise<DevSshUser[]> {
  if (projectIds.length === 0) return [];
  const rows = await getDb()
    .select()
    .from(devSshUserTable)
    .orderBy(devSshUserTable.createdAt);
  const wanted = new Set(projectIds);
  return rows.map(assembleDevSshUser).filter((u) => wanted.has(u.projectId));
}

/**
 * Create a dev SSH user. Namespaces the username gateway-globally as
 * `<slug>-<name>`, encrypts the password (reversibly — chpasswd needs it),
 * persists FIRST (store is the sole source of truth — ADR-0002), then ensures
 * the gateway exists and provisions the account. At least one credential is
 * required (also enforced at the action layer).
 */
export async function createDevSshUser(input: {
  projectId: string;
  name: string;
  publicKey?: string | null;
  password?: string | null;
}): Promise<DevSshUserDTO> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const project = await loadTeamProject(input.projectId, membership.teamId);
  if (!project) throw new Error("Project not found");
  await requireFolderCapabilityForProject(input.projectId, "deploy");

  const publicKey = input.publicKey?.trim() || null;
  const password = input.password?.trim() || null;
  // Invariant: the "neither" state is unrepresentable (key is the default).
  if (!publicKey && !password) {
    throw new Error("Provide an SSH key or a password (at least one)");
  }
  // A password with a control char / newline would inject a second
  // `user:password` line into chpasswd's stdin — a cross-account takeover.
  if (password && hasControlChars(password)) {
    throw new Error("Password must not contain control characters or newlines");
  }
  // A public key must be exactly one well-formed authorized_keys line — an
  // embedded newline would inject an extra, unrestricted authorized_keys entry.
  if (publicKey && (publicKey.includes("\n") || !PUBKEY_RE.test(publicKey))) {
    throw new Error("Invalid SSH public key (must be a single key line)");
  }

  const namePart = sanitizeName(input.name);
  if (!namePart) throw new Error("Invalid username");
  const username = `${project.slug}-${namePart}`;

  const existing = await getDb()
    .select({ id: devSshUserTable.id })
    .from(devSshUserTable)
    .where(eq(devSshUserTable.username, username))
    .limit(1);
  if (existing.length > 0) {
    throw new Error(`An SSH user "${username}" already exists`);
  }

  const record: DevSshUser = {
    id: newId("ssh"),
    projectId: input.projectId,
    username,
    publicKey,
    passwordEnc: password ? encryptSecret(password) : null,
    createdAt: nowIso(),
  };

  // Store leads, gateway exec follows. provisionUser ensures the gateway on the
  // project's owning server first (lazy create — the user may be the first), then
  // reconciles the full user set, so a fresh gateway rebuilds from the store.
  await getDb().insert(devSshUserTable).values(devSshUserToRow(record));
  await provisionUser(record);

  await recordActivity(
    "project",
    `Added SSH user ${username}`,
    user.name,
    input.projectId,
  );
  return toDTO(record);
}

/**
 * Remove a dev SSH user from the store and the gateway. Removing the last user
 * does NOT tear down the gateway — it is a platform singleton (ADR-0002).
 */
export async function removeDevSshUser(id: string): Promise<void> {
  const { membership } = await requireCapability("deploy");
  const user = (await getCurrentUser())!;
  const rows = await getDb()
    .select()
    .from(devSshUserTable)
    .where(eq(devSshUserTable.id, id))
    .limit(1);
  const record = rows[0] ? assembleDevSshUser(rows[0]) : null;
  if (!record) throw new Error("SSH user not found");
  const project = await loadTeamProject(record.projectId, membership.teamId);
  if (!project) throw new Error("SSH user not found");
  await requireFolderCapabilityForProject(record.projectId, "deploy");
  // Resolve the owning server BEFORE the store mutation — deprovision routes to
  // that server's gateway agent.
  const serverId = project.serverId;

  await getDb().delete(devSshUserTable).where(eq(devSshUserTable.id, id));
  await deprovisionUser(serverId, record.username).catch(() => {});

  await recordActivity(
    "project",
    `Removed SSH user ${record.username}`,
    user.name,
    record.projectId,
  );
}

/**
 * Remove every SSH user of a project (used on project delete). Store first,
 * then evict each from the gateway. The gateway stays up for other projects.
 */
export async function removeProjectDevSshUsers(
  projectId: string,
): Promise<void> {
  const usernames = (await projectDevSshUsers(projectId)).map((u) => u.username);
  if (usernames.length === 0) return;
  // Every user of a project lives on the project's server (the gateway runs on
  // the dev container's host). Resolve it before the store mutation.
  const serverId = (await loadProjectGraph(projectId))?.serverId;
  await getDb()
    .delete(devSshUserTable)
    .where(eq(devSshUserTable.projectId, projectId));
  if (!serverId) return;
  for (const username of usernames) {
    await deprovisionUser(serverId, username).catch(() => {});
  }
}
