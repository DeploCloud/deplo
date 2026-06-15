import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret } from "../crypto";
import type { SharedEnvGroup, SharedEnvVar } from "../types";

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
    projectIds: g.projectIds,
    projects: g.projectIds
      .map((id) => projectsById.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
    updatedAt: g.updatedAt,
  };
}

export async function listSharedEnvGroups(): Promise<SharedEnvGroupDTO[]> {
  await assertUser();
  return [...groups()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(toDTO);
}

/** Decrypted `.env` text for one group, used to prefill the edit form. */
export async function getSharedEnvBlob(id: string): Promise<string> {
  await assertUser();
  const g = groups().find((x) => x.id === id);
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

export async function saveSharedEnvGroup(input: {
  id?: string;
  name: string;
  description: string;
  blob: string;
  projectIds: string[];
}): Promise<void> {
  const user = await assertUser();
  const name = input.name.trim();
  if (!name) throw new Error("Enter a name");
  const variables = parseBlob(input.blob);
  // Only attach to projects that actually exist.
  const validIds = new Set(read().projects.map((p) => p.id));
  const projectIds = input.projectIds.filter((id) => validIds.has(id));

  mutate((d) => {
    d.sharedEnvGroups ??= [];
    if (input.id) {
      const g = d.sharedEnvGroups.find((x) => x.id === input.id);
      if (!g) throw new Error("Group not found");
      g.name = name;
      g.description = input.description.trim();
      g.variables = variables;
      g.projectIds = projectIds;
      g.updatedAt = nowIso();
    } else {
      d.sharedEnvGroups.push({
        id: newId("shenv"),
        name,
        description: input.description.trim(),
        variables,
        projectIds,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
    }
  });
  recordActivity("env", `Updated shared variables ${name}`, user.name, null);
}

export async function deleteSharedEnvGroup(id: string): Promise<void> {
  const user = await assertUser();
  const g = groups().find((x) => x.id === id);
  if (!g) throw new Error("Group not found");
  mutate((d) => {
    d.sharedEnvGroups = (d.sharedEnvGroups ?? []).filter((x) => x.id !== id);
  });
  recordActivity("env", `Deleted shared variables ${g.name}`, user.name, null);
}
