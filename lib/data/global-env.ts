import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  teamGlobalEnvVars as tgVars,
  teamGlobalEnvVarTargets as tgTargets,
  instanceEnvVars as instVars,
  instanceEnvVarTargets as instTargets,
  services as servicesTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireCapability, requireInstanceAdmin } from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret } from "../crypto";
import type {
  EnvTarget,
  GlobalEnvVar,
  GlobalEnvVarDTO,
} from "../types";

/**
 * GLOBAL environment variables — variables injected into services without a
 * per-project attachment. Two scopes:
 *   - team:     every project in one team           (gated `manage_env`)
 *   - instance: every project of every team         (gated instance admin)
 *
 * Storage mirrors `env_vars` (a value_enc + a targets junction) but keyed on the
 * team (or nothing, for instance). The deploy merge in lib/deploy/env-resolve.ts
 * layers these UNDER a project's own vars and shared groups, so a more specific
 * scope always wins on a key collision. Encryption is identical to project env
 * (encryptSecret at rest; decrypt only at the deploy edge or on explicit reveal).
 */

const MASK = "••••••••••••";
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

type VarRow = {
  id: string;
  key: string;
  valueEnc: string;
  type: string;
  createdAt: string;
  updatedAt: string;
};
type TargetRow = { envVarId: string; target: string };

/** Stitch var rows to their targets junction into domain objects (key-sorted). */
function assemble(vars: VarRow[], targets: TargetRow[]): GlobalEnvVar[] {
  const byVar = new Map<string, EnvTarget[]>();
  for (const t of targets) {
    const list = byVar.get(t.envVarId) ?? [];
    list.push(t.target as EnvTarget);
    byVar.set(t.envVarId, list);
  }
  return vars
    .map((v) => ({
      id: v.id,
      key: v.key,
      valueEnc: v.valueEnc,
      type: v.type as "plain" | "secret",
      targets: byVar.get(v.id) ?? [],
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function toDTO(e: GlobalEnvVar): GlobalEnvVarDTO {
  const isSecret = e.type === "secret";
  return {
    id: e.id,
    key: e.key,
    // Secrets are always masked; only plain vars decrypt for display.
    value: isSecret ? MASK : decryptSecret(e.valueEnc),
    masked: isSecret,
    targets: e.targets,
    type: e.type,
    updatedAt: e.updatedAt,
  };
}

/* ------------------------------------------------------------------ */
/* Internal loaders (no auth gate) — reads for display + deploy.       */
/* ------------------------------------------------------------------ */

async function loadTeamVars(teamId: string): Promise<GlobalEnvVar[]> {
  const db = getDb();
  const vars = await db.select().from(tgVars).where(eq(tgVars.teamId, teamId));
  if (vars.length === 0) return [];
  const targets = await db
    .select()
    .from(tgTargets)
    .where(inArray(tgTargets.envVarId, vars.map((v) => v.id)));
  return assemble(vars, targets);
}

async function loadInstanceVars(): Promise<GlobalEnvVar[]> {
  const db = getDb();
  const vars = await db.select().from(instVars);
  if (vars.length === 0) return [];
  const targets = await db
    .select()
    .from(instTargets)
    .where(inArray(instTargets.envVarId, vars.map((v) => v.id)));
  return assemble(vars, targets);
}

/** Still-encrypted entry the deploy merge consumes (no serviceId — applies to all). */
export interface GlobalEnvEntry {
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
}

/**
 * The team-global + instance-global entries that apply to one project, for the
 * deploy-time merge. Resolves the project's team, then loads both scopes. NO auth
 * gate — it runs inside the deploy engine, which has already authorized the
 * deploy. Returns encrypted entries; the caller decrypts at the edge.
 */
export async function loadGlobalEnvForService(
  serviceId: string,
): Promise<{ teamGlobals: GlobalEnvEntry[]; instanceGlobals: GlobalEnvEntry[] }> {
  const prow = await getDb()
    .select({ teamId: servicesTable.teamId })
    .from(servicesTable)
    .where(eq(servicesTable.id, serviceId))
    .limit(1);
  const teamId = prow[0]?.teamId;
  const [team, instance] = await Promise.all([
    teamId ? loadTeamVars(teamId) : Promise.resolve<GlobalEnvVar[]>([]),
    loadInstanceVars(),
  ]);
  const strip = (e: GlobalEnvVar): GlobalEnvEntry => ({
    key: e.key,
    valueEnc: e.valueEnc,
    targets: e.targets,
  });
  return { teamGlobals: team.map(strip), instanceGlobals: instance.map(strip) };
}

/* ------------------------------------------------------------------ */
/* Team-global CRUD — gated `manage_env`, scoped to the active team.   */
/* ------------------------------------------------------------------ */

export async function listTeamGlobalEnv(): Promise<GlobalEnvVarDTO[]> {
  const { teamId } = await requireCapability("manage_env");
  return (await loadTeamVars(teamId)).map(toDTO);
}

export async function revealTeamGlobalEnv(id: string): Promise<string> {
  const { teamId } = await requireCapability("manage_env");
  const rows = await getDb()
    .select({ valueEnc: tgVars.valueEnc })
    .from(tgVars)
    .where(and(eq(tgVars.id, id), eq(tgVars.teamId, teamId)))
    .limit(1);
  if (!rows[0]) throw new Error("Not found");
  return decryptSecret(rows[0].valueEnc);
}

export async function upsertTeamGlobalEnv(input: {
  key: string;
  value: string;
  targets: EnvTarget[];
  type: "plain" | "secret";
}): Promise<void> {
  const { membership } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  const key = input.key.trim();
  if (!KEY_RE.test(key)) throw new Error("Invalid variable name");
  if (input.targets.length === 0)
    throw new Error("Select at least one environment");
  // The editor sends the MASK back unchanged when only targets/type changed on a
  // secret — keep the stored value rather than encrypting the mask string.
  const keepValue = input.value === MASK;

  await getDb().transaction(async (tx) => {
    const existing = await tx
      .select({ id: tgVars.id })
      .from(tgVars)
      .where(and(eq(tgVars.teamId, membership.teamId), eq(tgVars.key, key)))
      .limit(1);
    if (existing.length > 0) {
      const id = existing[0]!.id;
      await tx
        .update(tgVars)
        .set({
          ...(keepValue ? {} : { valueEnc: encryptSecret(input.value) }),
          type: input.type,
          updatedAt: nowIso(),
        })
        .where(eq(tgVars.id, id));
      await tx.delete(tgTargets).where(eq(tgTargets.envVarId, id));
      await tx
        .insert(tgTargets)
        .values(input.targets.map((target) => ({ envVarId: id, target })));
    } else {
      const id = newId("env");
      const now = nowIso();
      await tx.insert(tgVars).values({
        id,
        teamId: membership.teamId,
        key,
        valueEnc: encryptSecret(input.value),
        type: input.type,
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .insert(tgTargets)
        .values(input.targets.map((target) => ({ envVarId: id, target })));
    }
  });
  await recordActivity(
    "env",
    `Updated team global variable ${key}`,
    user.name,
    null,
    membership.teamId,
  );
}

export async function deleteTeamGlobalEnv(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  // Scope the delete to the team so one team can't delete another's var.
  const rows = await getDb()
    .select({ key: tgVars.key })
    .from(tgVars)
    .where(and(eq(tgVars.id, id), eq(tgVars.teamId, membership.teamId)))
    .limit(1);
  if (!rows[0]) throw new Error("Not found");
  // targets CASCADE on the delete.
  await getDb()
    .delete(tgVars)
    .where(and(eq(tgVars.id, id), eq(tgVars.teamId, membership.teamId)));
  await recordActivity(
    "env",
    `Deleted team global variable ${rows[0].key}`,
    user.name,
    null,
    membership.teamId,
  );
}

/* ------------------------------------------------------------------ */
/* Instance-global CRUD — gated instance admin (affects every team).  */
/* ------------------------------------------------------------------ */

export async function listInstanceEnv(): Promise<GlobalEnvVarDTO[]> {
  await requireInstanceAdmin();
  return (await loadInstanceVars()).map(toDTO);
}

export async function revealInstanceEnv(id: string): Promise<string> {
  await requireInstanceAdmin();
  const rows = await getDb()
    .select({ valueEnc: instVars.valueEnc })
    .from(instVars)
    .where(eq(instVars.id, id))
    .limit(1);
  if (!rows[0]) throw new Error("Not found");
  return decryptSecret(rows[0].valueEnc);
}

export async function upsertInstanceEnv(input: {
  key: string;
  value: string;
  targets: EnvTarget[];
  type: "plain" | "secret";
}): Promise<void> {
  await requireInstanceAdmin();
  const user = (await getCurrentUser())!;
  const key = input.key.trim();
  if (!KEY_RE.test(key)) throw new Error("Invalid variable name");
  if (input.targets.length === 0)
    throw new Error("Select at least one environment");
  const keepValue = input.value === MASK;

  await getDb().transaction(async (tx) => {
    const existing = await tx
      .select({ id: instVars.id })
      .from(instVars)
      .where(eq(instVars.key, key))
      .limit(1);
    if (existing.length > 0) {
      const id = existing[0]!.id;
      await tx
        .update(instVars)
        .set({
          ...(keepValue ? {} : { valueEnc: encryptSecret(input.value) }),
          type: input.type,
          updatedAt: nowIso(),
        })
        .where(eq(instVars.id, id));
      await tx.delete(instTargets).where(eq(instTargets.envVarId, id));
      await tx
        .insert(instTargets)
        .values(input.targets.map((target) => ({ envVarId: id, target })));
    } else {
      const id = newId("env");
      const now = nowIso();
      await tx.insert(instVars).values({
        id,
        key,
        valueEnc: encryptSecret(input.value),
        type: input.type,
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .insert(instTargets)
        .values(input.targets.map((target) => ({ envVarId: id, target })));
    }
  });
  await recordActivity(
    "env",
    `Updated instance-wide variable ${key}`,
    user.name,
  );
}

export async function deleteInstanceEnv(id: string): Promise<void> {
  await requireInstanceAdmin();
  const user = (await getCurrentUser())!;
  const rows = await getDb()
    .select({ key: instVars.key })
    .from(instVars)
    .where(eq(instVars.id, id))
    .limit(1);
  if (!rows[0]) throw new Error("Not found");
  await getDb().delete(instVars).where(eq(instVars.id, id));
  await recordActivity(
    "env",
    `Deleted instance-wide variable ${rows[0].key}`,
    user.name,
  );
}
