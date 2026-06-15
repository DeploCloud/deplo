import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret } from "../crypto";
import type { EnvTarget, EnvVar, EnvVarDTO } from "../types";

const MASK = "••••••••••••";

function toDTO(e: EnvVar): EnvVarDTO {
  const decrypted = decryptSecret(e.valueEnc);
  return {
    id: e.id,
    key: e.key,
    value: e.type === "secret" ? MASK : decrypted,
    masked: e.type === "secret",
    targets: e.targets,
    type: e.type,
    updatedAt: e.updatedAt,
  };
}

export async function listEnv(projectId: string): Promise<EnvVarDTO[]> {
  await assertUser();
  return read()
    .envVars.filter((e) => e.projectId === projectId)
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(toDTO);
}

/** Reveal a single secret value. Requires auth; returns decrypted plaintext. */
export async function revealEnv(id: string): Promise<string> {
  await assertUser();
  const e = read().envVars.find((x) => x.id === id);
  if (!e) throw new Error("Not found");
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
  const user = await assertUser();
  const key = input.key.trim();
  if (!KEY_RE.test(key)) throw new Error("Invalid variable name");
  if (input.targets.length === 0) throw new Error("Select at least one environment");
  const project = read().projects.find((p) => p.id === input.projectId);
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
  await assertUser();
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
  const user = await assertUser();
  const e = read().envVars.find((x) => x.id === id);
  if (!e) throw new Error("Not found");
  mutate((d) => {
    d.envVars = d.envVars.filter((x) => x.id !== id);
  });
  recordActivity("env", `Deleted env var ${e.key}`, user.name, e.projectId);
}
