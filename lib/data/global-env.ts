import "server-only";

import { eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  instanceEnvVars as instVars,
  instanceEnvVarTargets as instTargets,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireInstanceAdmin } from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret } from "../crypto";
import type {
  EnvTarget,
  GlobalEnvVar,
  GlobalEnvVarDTO,
} from "../types";

/**
 * INSTANCE-global environment variables — variables injected into every app of
 * every team, managed by an instance admin (gated instance admin). Storage
 * mirrors `env_vars` (a value_enc + a targets junction) but with no team scope.
 * The deploy merge in lib/deploy/env-resolve.ts layers these UNDER every other
 * source (they are the broadest default), so any more-specific scope wins on a
 * key collision. Encryption is identical to app env (encryptSecret at rest;
 * decrypt only at the deploy edge or on explicit reveal).
 *
 * NOTE: team-global vars used to live here too; they are now team-wide shared
 * vars in lib/data/shared-vars.ts (ADR-0010).
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

/** Still-encrypted entry the deploy merge consumes (no appId — applies to all). */
export interface GlobalEnvEntry {
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
}

/**
 * The instance-global entries that apply to every app, for the deploy-time merge.
 * NO auth gate — it runs inside the deploy engine, which has already authorized
 * the deploy. Returns encrypted entries; the caller decrypts at the edge. (These
 * are app-independent — every app of every team inherits them.)
 */
export async function loadInstanceEnv(): Promise<GlobalEnvEntry[]> {
  const instance = await loadInstanceVars();
  return instance.map((e) => ({
    key: e.key,
    valueEnc: e.valueEnc,
    targets: e.targets,
  }));
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
