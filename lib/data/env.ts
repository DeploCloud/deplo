import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  envVars as envVarsTable,
  envVarTargets as envVarTargetsTable,
  projects as projectsTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret } from "../crypto";
import {
  insertEnvVars,
  loadEnvVar,
  loadEnvVarsForProject,
  loadEnvVarsForProjects,
  projectInTeam,
} from "./project-graph-load";
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
  if (!(await projectInTeam(projectId, teamId))) return [];
  return (await loadEnvVarsForProject(projectId))
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
  const projects = await getDb()
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      slug: projectsTable.slug,
    })
    .from(projectsTable)
    .where(eq(projectsTable.teamId, teamId));
  // Batch-load every var across the team's projects (one pair of queries), then
  // group in memory — no per-project round-trip.
  const all = await loadEnvVarsForProjects(projects.map((p) => p.id));
  const byProject = new Map<string, EnvVar[]>();
  for (const e of all) {
    const list = byProject.get(e.projectId) ?? [];
    list.push(e);
    byProject.set(e.projectId, list);
  }
  return projects
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      project: { id: p.id, name: p.name, slug: p.slug },
      vars: (byProject.get(p.id) ?? [])
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(toDTO),
    }));
}

/** Reveal a single secret value. Requires `manage_env`; returns plaintext. */
export async function revealEnv(id: string): Promise<string> {
  const { teamId } = await requireCapability("manage_env");
  const e = await loadEnvVar(id);
  if (!e) throw new Error("Not found");
  if (!(await projectInTeam(e.projectId, teamId))) throw new Error("Not found");
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
  const user = (await getCurrentUser())!;
  const key = input.key.trim();
  if (!KEY_RE.test(key)) throw new Error("Invalid variable name");
  if (input.targets.length === 0) throw new Error("Select at least one environment");
  if (!(await projectInTeam(input.projectId, membership.teamId)))
    throw new Error("Project not found");

  await getDb().transaction(async (tx) => {
    const existing = await tx
      .select({ id: envVarsTable.id })
      .from(envVarsTable)
      .where(
        and(
          eq(envVarsTable.projectId, input.projectId),
          eq(envVarsTable.key, key),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      const varId = existing[0]!.id;
      await tx
        .update(envVarsTable)
        .set({
          valueEnc: encryptSecret(input.value),
          type: input.type,
          updatedAt: nowIso(),
        })
        .where(eq(envVarsTable.id, varId));
      // Whole-set replace of the targets junction.
      await tx.delete(envVarTargetsTable).where(eq(envVarTargetsTable.envVarId, varId));
      await tx
        .insert(envVarTargetsTable)
        .values(input.targets.map((target) => ({ envVarId: varId, target })));
    } else {
      await insertEnvVars(tx, [
        {
          id: newId("env"),
          projectId: input.projectId,
          key,
          valueEnc: encryptSecret(input.value),
          targets: input.targets,
          type: input.type,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      ]);
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
  if (!(await projectInTeam(projectId, membership.teamId)))
    throw new Error("Project not found");
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
    // Imported vars are PLAIN by default — never silently marked secret. A user
    // can flip individual vars to secret afterwards from the table.
    await upsertEnv({ projectId, key, value, targets, type: "plain" });
    count++;
  }
  return count;
}

/**
 * Replace a project's whole env set from the ".env editor": upsert every entry
 * and delete the ones the editor dropped, in a single atomic write.
 *
 *  - New keys are created as PLAIN (never secret by default) with `defaultTargets`.
 *  - Existing keys keep their `type` and `targets` (the flat editor can't express
 *    them); only the value changes.
 *  - A SECRET whose incoming value is still the mask (the editor hides secret
 *    values) is left untouched — so editing the file never clobbers a secret you
 *    couldn't see. Changing a secret's masked value to anything else updates it
 *    (and it stays secret).
 */
export async function setProjectEnv(
  projectId: string,
  entries: { key: string; value: string }[],
  defaultTargets: EnvTarget[],
): Promise<number> {
  const { membership } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  if (!(await projectInTeam(projectId, membership.teamId)))
    throw new Error("Project not found");
  if (defaultTargets.length === 0) {
    throw new Error("Select at least one environment for new variables");
  }

  // Validate + dedupe (last assignment of a key wins), dropping invalid names.
  const wanted = new Map<string, string>();
  for (const e of entries) {
    const key = e.key.trim();
    if (!KEY_RE.test(key)) continue;
    wanted.set(key, e.value);
  }

  await getDb().transaction(async (tx) => {
    const existing = await loadEnvVarsForProject(projectId, tx);
    const byKey = new Map(existing.map((e) => [e.key, e] as const));
    const created: EnvVar[] = [];
    for (const [key, value] of wanted) {
      const e = byKey.get(key);
      if (e) {
        // Skip an unchanged secret (its masked value came back verbatim).
        if (e.type === "secret" && value === MASK) continue;
        await tx
          .update(envVarsTable)
          .set({ valueEnc: encryptSecret(value), updatedAt: nowIso() })
          .where(eq(envVarsTable.id, e.id));
      } else {
        created.push({
          id: newId("env"),
          projectId,
          key,
          valueEnc: encryptSecret(value),
          targets: defaultTargets,
          type: "plain",
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
      }
    }
    if (created.length > 0) await insertEnvVars(tx, created);
    // Drop variables removed in the editor (their targets CASCADE).
    const removed = existing
      .filter((e) => !wanted.has(e.key))
      .map((e) => e.id);
    if (removed.length > 0)
      await tx.delete(envVarsTable).where(inArray(envVarsTable.id, removed));
  });
  recordActivity(
    "env",
    `Edited environment (${wanted.size} variable${wanted.size === 1 ? "" : "s"})`,
    user.name,
    projectId,
  );
  return wanted.size;
}

export async function deleteEnv(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  const e = await loadEnvVar(id);
  if (!e) throw new Error("Not found");
  if (!(await projectInTeam(e.projectId, membership.teamId)))
    throw new Error("Not found");
  // The env_var_targets child rows CASCADE on the delete.
  await getDb().delete(envVarsTable).where(eq(envVarsTable.id, id));
  recordActivity("env", `Deleted env var ${e.key}`, user.name, e.projectId);
}
