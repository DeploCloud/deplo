import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import type { DbTx } from "../db/client";
import {
  services as servicesTable,
  sharedEnvGroups as sharedEnvGroupsTable,
  sharedEnvGroupServices,
  sharedEnvGroupTargets,
  sharedEnvGroupVars,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { requireFolderCapabilityForService } from "./folder-access";
import { encryptSecret, decryptSecret } from "../crypto";
import { ALL_ENV_TARGETS } from "../types";
import { groupTargets } from "../deploy/env-resolve";
import {
  loadSharedEnvGroup,
  loadSharedEnvGroupsForTeam,
  serviceInTeam,
} from "./service-graph-load";
import { sharedEnvGroupToRow } from "./service-graph-rows";
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
  serviceIds: string[];
  services: { id: string; name: string; slug: string }[];
  updatedAt: string;
}

async function toDTO(
  g: SharedEnvGroup,
  projectsById: Map<string, { id: string; name: string; slug: string }>,
): Promise<SharedEnvGroupDTO> {
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
    serviceIds: g.serviceIds,
    services: g.serviceIds
      .map((id) => projectsById.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map((p) => ({ id: p.id, name: p.name, slug: p.slug })),
    updatedAt: g.updatedAt,
  };
}

export async function listSharedEnvGroups(): Promise<SharedEnvGroupDTO[]> {
  // Viewing shared env values requires manage_env (same as project env).
  const { teamId } = await requireCapability("manage_env");
  const groups = (await loadSharedEnvGroupsForTeam(teamId)).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const projectsById = await teamServicesById(teamId);
  return Promise.all(groups.map((g) => toDTO(g, projectsById)));
}

/** The team's services keyed by id (the DTO's attached-project decoration). */
async function teamServicesById(
  teamId: string,
): Promise<Map<string, { id: string; name: string; slug: string }>> {
  const rows = await getDb()
    .select({
      id: servicesTable.id,
      name: servicesTable.name,
      slug: servicesTable.slug,
    })
    .from(servicesTable)
    .where(eq(servicesTable.teamId, teamId));
  return new Map(rows.map((p) => [p.id, p] as const));
}

/** Decrypted `.env` text for one group, used to prefill the edit form. */
export async function getSharedEnvBlob(id: string): Promise<string> {
  const { teamId } = await requireCapability("manage_env");
  const g = await loadSharedEnvGroup(id);
  if (!g || g.teamId !== teamId) throw new Error("Group not found");
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
  serviceIds: string[];
  targets: EnvTarget[];
}): Promise<void> {
  const { membership } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  const name = input.name.trim();
  if (!name) throw new Error("Enter a name");
  const variables = parseBlob(input.blob);
  const targets = sanitizeTargets(input.targets);
  // Only attach to the active team's services that actually exist.
  const validIds = new Set((await teamServicesById(membership.teamId)).keys());
  const serviceIds = [...new Set(input.serviceIds.filter((id) => validIds.has(id)))];

  const group: SharedEnvGroup = {
    id: input.id ?? newId("shenv"),
    teamId: membership.teamId,
    name,
    description: input.description.trim(),
    variables,
    serviceIds,
    targets,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  await getDb().transaction(async (tx) => {
    if (input.id) {
      const existing = await loadSharedEnvGroup(input.id, tx);
      if (!existing || existing.teamId !== membership.teamId)
        throw new Error("Group not found");
      group.createdAt = existing.createdAt; // preserve
      await tx
        .update(sharedEnvGroupsTable)
        .set({ name, description: group.description, updatedAt: group.updatedAt })
        .where(eq(sharedEnvGroupsTable.id, input.id));
      // Whole-set replace of the 3 child sets.
      await tx.delete(sharedEnvGroupVars).where(eq(sharedEnvGroupVars.groupId, input.id));
      await tx.delete(sharedEnvGroupServices).where(eq(sharedEnvGroupServices.groupId, input.id));
      await tx.delete(sharedEnvGroupTargets).where(eq(sharedEnvGroupTargets.groupId, input.id));
    } else {
      await tx.insert(sharedEnvGroupsTable).values(sharedEnvGroupToRow(group));
    }
    await insertSharedEnvChildren(tx, group);
  });
  await recordActivity("env", `Updated shared variables ${name}`, user.name, null, membership.teamId);
}

/** Insert a group's 3 child sets (vars / project junction / targets). */
async function insertSharedEnvChildren(
  tx: DbTx,
  group: SharedEnvGroup,
): Promise<void> {
  if (group.variables.length > 0)
    await tx.insert(sharedEnvGroupVars).values(
      group.variables.map((v) => ({
        groupId: group.id,
        key: v.key,
        valueEnc: v.valueEnc,
        type: v.type,
      })),
    );
  if (group.serviceIds.length > 0)
    await tx
      .insert(sharedEnvGroupServices)
      .values(group.serviceIds.map((serviceId) => ({ groupId: group.id, serviceId })));
  if (group.targets.length > 0)
    await tx
      .insert(sharedEnvGroupTargets)
      .values(group.targets.map((target) => ({ groupId: group.id, target })));
}

/**
 * Shared groups annotated with whether they are attached to one project — the
 * data behind the per-project "Shared groups" picker. Variable values are never
 * decrypted here; only keys and metadata travel to the client.
 */
export interface ServiceSharedEnvGroupDTO {
  id: string;
  name: string;
  description: string;
  keys: string[];
  targets: EnvTarget[];
  attached: boolean;
}

export async function listSharedEnvGroupsForService(
  serviceId: string,
): Promise<ServiceSharedEnvGroupDTO[]> {
  const { teamId } = await requireCapability("manage_env");
  await requireFolderCapabilityForService(serviceId, "manage_env");
  return (await loadSharedEnvGroupsForTeam(teamId))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      keys: g.variables.map((v) => v.key),
      targets: groupTargets(g),
      attached: g.serviceIds.includes(serviceId),
    }));
}

/** Attach or detach a single shared group to one project (idempotent). */
export async function setSharedEnvGroupAttachment(
  groupId: string,
  serviceId: string,
  attached: boolean,
): Promise<void> {
  const { membership } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  if (!(await serviceInTeam(serviceId, membership.teamId)))
    throw new Error("Service not found");
  await requireFolderCapabilityForService(serviceId, "manage_env");
  const g = await loadSharedEnvGroup(groupId);
  if (!g || g.teamId !== membership.teamId) throw new Error("Group not found");
  if (attached) {
    await getDb()
      .insert(sharedEnvGroupServices)
      .values({ groupId, serviceId })
      .onConflictDoNothing();
  } else {
    await getDb()
      .delete(sharedEnvGroupServices)
      .where(
        and(
          eq(sharedEnvGroupServices.groupId, groupId),
          eq(sharedEnvGroupServices.serviceId, serviceId),
        ),
      );
  }
  await getDb()
    .update(sharedEnvGroupsTable)
    .set({ updatedAt: nowIso() })
    .where(eq(sharedEnvGroupsTable.id, groupId));
  await recordActivity(
    "env",
    `${attached ? "Attached" : "Detached"} shared variables ${g.name}`,
    user.name,
    serviceId,
  );
}

export async function deleteSharedEnvGroup(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  const g = await loadSharedEnvGroup(id);
  if (!g || g.teamId !== membership.teamId) throw new Error("Group not found");
  // The 3 child sets CASCADE on the group delete.
  await getDb().delete(sharedEnvGroupsTable).where(eq(sharedEnvGroupsTable.id, id));
  await recordActivity("env", `Deleted shared variables ${g.name}`, user.name, null, membership.teamId);
}
