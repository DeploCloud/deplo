import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret } from "../crypto";
import { ALL_ENV_TARGETS } from "../types";
import { groupTargets } from "../deploy/env-resolve";
import type { EnvTarget, SharedEnvGroup, SharedEnvVar } from "../types";

const MASK = "••••••••••••";
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

/** Heuristic: treat secret-looking keys as masked secrets. */
function isSecretKey(key: string): boolean {
  return /pass|secret|token|key|api|private|credential|dsn|url/i.test(key);
}

export interface SharedEnvVarDTO {
  key: string;
  value: string;
  masked: boolean;
  type: "plain" | "secret";
}

export interface SharedEnvGroupDTO {
  id: string;
  name: string;
  description: string;
  variables: SharedEnvVarDTO[];
  targets: EnvTarget[];
  projectIds: string[];
  projects: { id: string; name: string; slug: string }[];
  updatedAt: string;
}

function groups(): SharedEnvGroup[] {
  return read().sharedEnvGroups ?? [];
}

function toDTO(g: SharedEnvGroup): SharedEnvGroupDTO {
  const projectsById = new Map(read().projects.map((p) => [p.id, p]));
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    variables: g.variables.map((v) => ({
      key: v.key,
      value: v.type === "secret" ? MASK : decryptSecret(v.valueEnc),
      masked: v.type === "secret",
      type: v.type,
    })),
    targets: groupTargets(g),
    projectIds: g.projectIds,
    projects: g.projectIds
      .map((id) => projectsById.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
    updatedAt: g.updatedAt,
  };
}

export async function listSharedEnvGroups(): Promise<SharedEnvGroupDTO[]> {
  // Viewing shared env values requires manage_env (same as project env).
  const { teamId } = await requireCapability("manage_env");
  return groups()
    .filter((g) => g.teamId === teamId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(toDTO);
}

/** Decrypted `.env` text for one group, used to prefill the edit form. */
export async function getSharedEnvBlob(id: string): Promise<string> {
  const { teamId } = await requireCapability("manage_env");
  const g = groups().find((x) => x.id === id && x.teamId === teamId);
  if (!g) throw new Error("Group not found");
  return g.variables.map((v) => `${v.key}=${decryptSecret(v.valueEnc)}`).join("\n");
}

/** Parse a `.env` blob into encrypted shared variables. */
function parseBlob(blob: string): SharedEnvVar[] {
  const out: SharedEnvVar[] = [];
  const seen = new Set<string>();
  for (const raw of blob.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (!KEY_RE.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      valueEnc: encryptSecret(value),
      type: isSecretKey(key) ? "secret" : "plain",
    });
  }
  return out;
}

/** Keep only valid, deduped targets; fall back to all three if none survive. */
function sanitizeTargets(targets: EnvTarget[]): EnvTarget[] {
  const allowed = new Set(ALL_ENV_TARGETS);
  const kept = ALL_ENV_TARGETS.filter((t) => targets.includes(t) && allowed.has(t));
  return kept.length ? kept : ALL_ENV_TARGETS;
}

export async function saveSharedEnvGroup(input: {
  id?: string;
  name: string;
  description: string;
  blob: string;
  projectIds: string[];
  targets: EnvTarget[];
}): Promise<void> {
  const { membership } = await requireCapability("manage_env");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const name = input.name.trim();
  if (!name) throw new Error("Enter a name");
  const variables = parseBlob(input.blob);
  const targets = sanitizeTargets(input.targets);
  // Only attach to the active team's projects that actually exist.
  const validIds = new Set(
    read()
      .projects.filter((p) => p.teamId === membership.teamId)
      .map((p) => p.id),
  );
  const projectIds = input.projectIds.filter((id) => validIds.has(id));

  mutate((d) => {
    d.sharedEnvGroups ??= [];
    if (input.id) {
      const g = d.sharedEnvGroups.find(
        (x) => x.id === input.id && x.teamId === membership.teamId,
      );
      if (!g) throw new Error("Group not found");
      g.name = name;
      g.description = input.description.trim();
      g.variables = variables;
      g.projectIds = projectIds;
      g.targets = targets;
      g.updatedAt = nowIso();
    } else {
      d.sharedEnvGroups.push({
        id: newId("shenv"),
        teamId: membership.teamId,
        name,
        description: input.description.trim(),
        variables,
        projectIds,
        targets,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
  });
  recordActivity("env", `Updated shared variables ${name}`, user.name, null, membership.teamId);
}

/**
 * Shared groups annotated with whether they are attached to one project — the
 * data behind the per-project "Shared groups" picker. Variable values are never
 * decrypted here; only keys and metadata travel to the client.
 */
export interface ProjectSharedEnvGroupDTO {
  id: string;
  name: string;
  description: string;
  keys: string[];
  targets: EnvTarget[];
  attached: boolean;
}

export async function listSharedEnvGroupsForProject(
  projectId: string,
): Promise<ProjectSharedEnvGroupDTO[]> {
  const { teamId } = await requireCapability("manage_env");
  return groups()
    .filter((g) => g.teamId === teamId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      keys: g.variables.map((v) => v.key),
      targets: groupTargets(g),
      attached: g.projectIds.includes(projectId),
    }));
}

/** Attach or detach a single shared group to one project (idempotent). */
export async function setSharedEnvGroupAttachment(
  groupId: string,
  projectId: string,
  attached: boolean,
): Promise<void> {
  const { membership } = await requireCapability("manage_env");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const exists = read().projects.some(
    (p) => p.id === projectId && p.teamId === membership.teamId,
  );
  if (!exists) throw new Error("Project not found");
  let groupName = "";
  mutate((d) => {
    const g = (d.sharedEnvGroups ?? []).find(
      (x) => x.id === groupId && x.teamId === membership.teamId,
    );
    if (!g) throw new Error("Group not found");
    groupName = g.name;
    const has = g.projectIds.includes(projectId);
    if (attached && !has) g.projectIds.push(projectId);
    else if (!attached && has)
      g.projectIds = g.projectIds.filter((id) => id !== projectId);
    g.updatedAt = nowIso();
  });
  recordActivity(
    "env",
    `${attached ? "Attached" : "Detached"} shared variables ${groupName}`,
    user.name,
    projectId,
  );
}

export async function deleteSharedEnvGroup(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_env");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const g = groups().find((x) => x.id === id && x.teamId === membership.teamId);
  if (!g) throw new Error("Group not found");
  mutate((d) => {
    d.sharedEnvGroups = (d.sharedEnvGroups ?? []).filter((x) => x.id !== id);
  });
  recordActivity("env", `Deleted shared variables ${g.name}`, user.name, null, membership.teamId);
}
