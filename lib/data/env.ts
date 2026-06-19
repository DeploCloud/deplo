import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret } from "../crypto";
import type { EnvTarget, EnvVar, EnvVarDTO } from "../types";

const MASK = "••••••••••••";

function toDTO(e: EnvVar): EnvVarDTO {
  const isSecret = e.type === "secret";
  return {
    id: e.id,
    key: e.key,
    // Secret values are always masked in the DTO, so don't pay to decrypt them.
    // Only plain vars need their stored value back. Revealing a secret goes
    // through revealEnv(), which decrypts the single requested var on demand.
    value: isSecret ? MASK : decryptSecret(e.valueEnc),
    masked: isSecret,
    targets: e.targets,
    type: e.type,
    updatedAt: e.updatedAt,
  };
}

/**
 * Env values are sensitive: VIEWING them requires `manage_env`, not just team
 * membership. A member without it can't see the Variables / Environment UIs
 * (the data calls below return empty / throw) — matching the hidden tabs.
 */
export async function listEnv(projectId: string): Promise<EnvVarDTO[]> {
  const { teamId } = await requireCapability("manage_env");
  // Env vars are owned through their project; an out-of-team project yields none.
  const inTeam = read().projects.some(
    (p) => p.id === projectId && p.teamId === teamId,
  );
  if (!inTeam) return [];
  return read()
    .envVars.filter((e) => e.projectId === projectId)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(toDTO);
}

export interface ProjectEnvGroup {
  project: { id: string; name: string; slug: string };
  vars: EnvVarDTO[];
}

/** Every project's env vars, grouped by project (for the global Variables tab). */
export async function listAllProjectEnv(): Promise<ProjectEnvGroup[]> {
  const { teamId } = await requireCapability("manage_env");
  const d = read();
  return d.projects
    .filter((p) => p.teamId === teamId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      project: { id: p.id, name: p.name, slug: p.slug },
      vars: d.envVars
        .filter((e) => e.projectId === p.id)
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(toDTO),
    }));
}

/** Reveal a single secret value. Requires `manage_env`; returns plaintext. */
export async function revealEnv(id: string): Promise<string> {
  const { teamId } = await requireCapability("manage_env");
  const e = read().envVars.find((x) => x.id === id);
  if (!e) throw new Error("Not found");
  const inTeam = read().projects.some(
    (p) => p.id === e.projectId && p.teamId === teamId,
  );
  if (!inTeam) throw new Error("Not found");
  return decryptSecret(e.valueEnc);
}

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

export async function upsertEnv(input: {
  projectId: string;
  key: string;
  value: string;
  targets: EnvTarget[];
  type: "plain" | "secret";
}): Promise<void> {
  const { membership } = await requireCapability("manage_env");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const key = input.key.trim();
  if (!KEY_RE.test(key)) throw new Error("Invalid variable name");
  if (input.targets.length === 0) throw new Error("Select at least one environment");
  const project = read().projects.find(
    (p) => p.id === input.projectId && p.teamId === membership.teamId,
  );
  if (!project) throw new Error("Project not found");

  mutate((d) => {
    const existing = d.envVars.find(
      (e) => e.projectId === input.projectId && e.key === key
    );
    if (existing) {
      existing.valueEnc = encryptSecret(input.value);
      existing.targets = input.targets;
      existing.type = input.type;
      existing.updatedAt = nowIso();
    } else {
      const e: EnvVar = {
        id: newId("env"),
        projectId: input.projectId,
        key,
        valueEnc: encryptSecret(input.value),
        targets: input.targets,
        type: input.type,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      d.envVars.push(e);
    }
  });
  recordActivity("env", `Updated env var ${key}`, user.name, input.projectId);
}

/** Bulk import from a .env style blob. */
export async function importEnv(
  projectId: string,
  blob: string,
  targets: EnvTarget[]
): Promise<number> {
  const { membership } = await requireCapability("manage_env");
  const project = read().projects.find(
    (p) => p.id === projectId && p.teamId === membership.teamId,
  );
  if (!project) throw new Error("Project not found");
  let count = 0;
  const lines = blob.split("\n");
  for (const raw of lines) {
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
    if (!KEY_RE.test(key)) continue;
    await upsertEnv({ projectId, key, value, targets, type: "secret" });
    count++;
  }
  return count;
}

export async function deleteEnv(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_env");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const e = read().envVars.find((x) => x.id === id);
  if (!e) throw new Error("Not found");
  const inTeam = read().projects.some(
    (p) => p.id === e.projectId && p.teamId === membership.teamId,
  );
  if (!inTeam) throw new Error("Not found");
  mutate((d) => {
    d.envVars = d.envVars.filter((x) => x.id !== id);
  });
  recordActivity("env", `Deleted env var ${e.key}`, user.name, e.projectId);
}
