import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import { encryptSecret } from "../crypto";
import { recordActivity } from "./activity";
import {
  ensureGateway,
  provisionUser,
  deprovisionUser,
} from "../infra/ssh-gateway";
import type { DevSshUser, DevSshUserDTO } from "../types";

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

/** List a project's SSH users (passwords never leave the server). */
export async function listDevSshUsers(
  projectId: string,
): Promise<DevSshUserDTO[]> {
  await assertUser();
  return read()
    .devSshUsers.filter((u) => u.projectId === projectId)
    .map(toDTO);
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
  const user = await assertUser();
  const project = read().projects.find((p) => p.id === input.projectId);
  if (!project) throw new Error("Project not found");

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

  if (read().devSshUsers.some((u) => u.username === username)) {
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

  // Store leads, gateway exec follows.
  mutate((d) => {
    d.devSshUsers.push(record);
  });
  await ensureGateway();
  await provisionUser(record);

  recordActivity(
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
  const user = await assertUser();
  const record = read().devSshUsers.find((u) => u.id === id);
  if (!record) throw new Error("SSH user not found");

  mutate((d) => {
    d.devSshUsers = d.devSshUsers.filter((u) => u.id !== id);
  });
  await deprovisionUser(record.username).catch(() => {});

  recordActivity(
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
  const usernames = read()
    .devSshUsers.filter((u) => u.projectId === projectId)
    .map((u) => u.username);
  if (usernames.length === 0) return;
  mutate((d) => {
    d.devSshUsers = d.devSshUsers.filter((u) => u.projectId !== projectId);
  });
  for (const username of usernames) {
    await deprovisionUser(username).catch(() => {});
  }
}
