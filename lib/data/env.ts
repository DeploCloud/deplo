import "server-only";

// https://deplo.build/docs/guides/config/environment-variables

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  envVars as envVarsTable,
  envVarTargets as envVarTargetsTable,
  apps as appsTable,
  domains as domainsTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireMembership } from "../membership";
import { recordActivity } from "./activity";
import {
  appCapabilitiesForTeam,
  hasAppCapability,
  requireAppCapability,
} from "./node-access";
import { encryptSecret, decryptSecret } from "../crypto";
import {
  insertEnvVars,
  loadEnvVar,
  loadEnvVarsForApp,
  loadEnvVarsForApps,
  appScopeWhere,
} from "./app-graph-load";
import { authorOf, loadUserIdentities } from "./user-identity";
import { ALL_ENV_TARGETS, sanitizeTargets, secretImmutable } from "../types";
import type { EnvTarget, EnvVar, EnvVarDTO, VarAuthor } from "../types";

const MASK = "••••••••••••";

function toDTO(e: EnvVar, authors: Map<string, VarAuthor>): EnvVarDTO {
  const isSecret = e.type === "secret";
  return {
    id: e.id,
    key: e.key,
    // Secret values are always masked in the DTO, so don't pay to decrypt them.
    // Only plain vars need their stored value back - a secret has NO read-back
    // path at all, which is what makes its immutability worth anything.
    value: isSecret ? MASK : decryptSecret(e.valueEnc),
    masked: isSecret,
    targets: e.targets,
    type: e.type,
    // Authorship is metadata, not value - safe to project while `value` stays masked.
    createdBy: authorOf(e.createdByUserId, authors),
    updatedBy: authorOf(e.updatedByUserId, authors),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

/** Every author id a set of vars references, for one batched identity lookup. */
function authorIds(vars: EnvVar[]): (string | null)[] {
  return vars.flatMap((e) => [e.createdByUserId, e.updatedByUserId]);
}

/**
 * Env values are sensitive: VIEWING them requires `manage_env`, not just team
 * membership. A member without it can't see the Variables / Environment UIs
 * (the data calls below return empty / throw) - matching the hidden tabs.
 */
export async function listEnv(appId: string): Promise<EnvVarDTO[]> {
  // Env vars are owned through their app, and `manage_env` can be held on the app
  // alone (ADR-0016), so the reach question is asked once, at the app. A project
  // the caller can't reach yields nothing rather than an error.
  if (!(await hasAppCapability(appId, "manage_env"))) return [];
  const vars = (await loadEnvVarsForApp(appId)).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const authors = await loadUserIdentities(authorIds(vars));
  return vars.map((e) => toDTO(e, authors));
}

export interface AppEnvGroup {
  /**
   * `projectId` / `environmentId` are how a shared variable's project scope
   * resolves to apps (see `listSharedVarsForApp`), so the shared-var wizard needs
   * them to tell you what a scope actually reaches.
   */
  app: {
    id: string;
    name: string;
    slug: string;
    projectId: string | null;
    environmentId: string | null;
    logo: string | null;
    /** Hostname of the app's primary domain - at most one per app (DB-enforced). */
    primaryDomain: string | null;
  };
  vars: EnvVarDTO[];
}

/** The primary domain hostname of each given app, for the ones that have one. */
async function loadPrimaryDomains(
  appIds: string[],
): Promise<Map<string, string>> {
  if (appIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ appId: domainsTable.appId, name: domainsTable.name })
    .from(domainsTable)
    .where(
      and(
        inArray(domainsTable.appId, appIds),
        eq(domainsTable.isPrimary, true),
      ),
    );
  return new Map(rows.map((r) => [r.appId, r.name]));
}

/** Every project's env vars, grouped by project (for the global Variables tab). */
export async function listAllAppEnv(): Promise<AppEnvGroup[]> {
  const { teamId } = await requireMembership();
  const rows = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      slug: appsTable.slug,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
      logo: appsTable.logo,
      folderId: appsTable.folderId,
    })
    .from(appsTable)
    .where(and(eq(appsTable.teamId, teamId), appScopeWhere()));
  // The gate is asked PER APP, not once for the team: `manage_env` can now be held on
  // a single folder or app (ADR-0016), so a team-level check would both refuse
  // someone who legitimately holds it somewhere and, the old bug, wave through
  const reach = await appCapabilitiesForTeam(teamId, rows);
  const apps = rows.filter((p) => reach.get(p.id)?.includes("manage_env"));
  // Batch-load every var across the team's apps (one pair of queries), then
  // group in memory, no per-project round-trip.
  const all = await loadEnvVarsForApps(apps.map((p) => p.id));
  // Same shape for the primary domains: one query for the whole team, keyed by
  // app. `domains_one_primary_uq` guarantees at most one row per app.
  const primaryDomains = await loadPrimaryDomains(apps.map((p) => p.id));
  // One identity query for the whole page, not one per var / per app.
  const authors = await loadUserIdentities(authorIds(all));
  const byApp = new Map<string, EnvVar[]>();
  for (const e of all) {
    const list = byApp.get(e.appId) ?? [];
    list.push(e);
    byApp.set(e.appId, list);
  }
  return apps
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      app: {
        id: p.id,
        name: p.name,
        slug: p.slug,
        projectId: p.projectId,
        environmentId: p.environmentId,
        logo: p.logo ?? null,
        primaryDomain: primaryDomains.get(p.id) ?? null,
      },
      vars: (byApp.get(p.id) ?? [])
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((e) => toDTO(e, authors)),
    }));
}

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

export async function upsertEnv(input: {
  appId: string;
  key: string;
  value: string;
  /**
   * Omitted (the UI no longer asks): a NEW var gets every runtime; an EDIT keeps
   * whatever targets the var already has - an edit must never widen them.
   */
  targets?: EnvTarget[];
  type: "plain" | "secret";
}): Promise<void> {
  const { userId } = await requireAppCapability(input.appId, "manage_env");
  const user = (await getCurrentUser())!;
  const key = input.key.trim();
  if (!KEY_RE.test(key)) throw new Error("Invalid variable name");
  // `null` ⇒ the caller named no targets: default them on insert, PRESERVE them on
  // update. Silently widening a legacy production-only secret would leak it into
  // runtimes it was never meant to reach.
  const targets = input.targets?.length ? sanitizeTargets(input.targets) : null;

  await getDb().transaction(async (tx) => {
    const existing = await tx
      .select({ id: envVarsTable.id, type: envVarsTable.type })
      .from(envVarsTable)
      .where(
        and(eq(envVarsTable.appId, input.appId), eq(envVarsTable.key, key)),
      )
      .limit(1);
    if (existing.length > 0) {
      // A SECRET is frozen. Promotion plain -> secret still lands here: `existing` is
      // plain, so there is nothing to protect yet.
      if (existing[0]!.type === "secret") throw new Error(secretImmutable(key));
      const varId = existing[0]!.id;
      await tx
        .update(envVarsTable)
        .set({
          valueEnc: encryptSecret(input.value),
          type: input.type,
          // An edit never rewrites who created the var.
          updatedByUserId: userId,
          updatedAt: nowIso(),
        })
        .where(eq(envVarsTable.id, varId));
      // Whole-set replace of the targets junction - only when the caller sent one.
      if (targets) {
        await tx
          .delete(envVarTargetsTable)
          .where(eq(envVarTargetsTable.envVarId, varId));
        await tx
          .insert(envVarTargetsTable)
          .values(targets.map((target) => ({ envVarId: varId, target })));
      }
    } else {
      await insertEnvVars(tx, [
        {
          id: newId("env"),
          appId: input.appId,
          key,
          valueEnc: encryptSecret(input.value),
          targets: targets ?? [...ALL_ENV_TARGETS],
          type: input.type,
          createdByUserId: userId,
          updatedByUserId: userId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        },
      ]);
    }
  });
  await recordActivity("env", `Updated env var ${key}`, user.name, input.appId);
}

/**
 * Rename an existing env var's key. Kept OUT of `upsertEnv` on purpose: that one
 * locates the row by `(appId, key)`, so feeding it a changed key would mint a
 * brand-new var beside the old, not rename it.
 */
export async function renameEnv(
  id: string,
  newKeyRaw: string,
): Promise<string> {
  const user = (await getCurrentUser())!;
  const newKey = newKeyRaw.trim();
  if (!KEY_RE.test(newKey)) throw new Error("Invalid variable name");
  const existing = await loadEnvVar(id);
  if (!existing) throw new Error("Env var not found");
  // Env vars are owned through their app; an out-of-team id reads as "not found".
  const { userId } = await requireAppCapability(existing.appId, "manage_env");
  // A secret is frozen whole, key included: "cannot be edited" that still let you
  // rename it would be a promise kept in one field only.
  if (existing.type === "secret")
    throw new Error(secretImmutable(existing.key));
  if (existing.key === newKey) return existing.appId; // no-op rename
  // Guard the `env_vars_app_key_uq (appId, key)` uniqueness with a readable message
  // instead of leaking the raw constraint violation the DB would otherwise throw.
  const clash = await getDb()
    .select({ id: envVarsTable.id })
    .from(envVarsTable)
    .where(
      and(eq(envVarsTable.appId, existing.appId), eq(envVarsTable.key, newKey)),
    )
    .limit(1);
  if (clash.length > 0)
    throw new Error(`A variable named ${newKey} already exists on this app`);
  await getDb()
    .update(envVarsTable)
    .set({ key: newKey, updatedByUserId: userId, updatedAt: nowIso() })
    .where(
      and(eq(envVarsTable.id, id), eq(envVarsTable.appId, existing.appId)),
    );
  await recordActivity(
    "env",
    `Renamed env var ${existing.key} → ${newKey}`,
    user.name,
    existing.appId,
  );
  return existing.appId;
}

/**
 * Bulk import from a .env style blob.
 */
export async function importEnv(
  appId: string,
  blob: string,
  targets?: EnvTarget[],
): Promise<{ added: number; skippedSecrets: number }> {
  await requireAppCapability(appId, "manage_env");
  // One query, not one per line: the whole point is to know which keys to leave.
  const secretKeys = new Set(
    (
      await getDb()
        .select({ key: envVarsTable.key })
        .from(envVarsTable)
        .where(
          and(eq(envVarsTable.appId, appId), eq(envVarsTable.type, "secret")),
        )
    ).map((r) => r.key),
  );
  let added = 0;
  let skippedSecrets = 0;
  const lines = blob.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.indexOf("=");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (!KEY_RE.test(key)) continue;
    if (secretKeys.has(key)) {
      skippedSecrets++;
      continue;
    }
    // Imported vars are PLAIN by default, never silently marked secret. A user
    // can flip individual vars to secret afterwards from the table.
    await upsertEnv({ appId, key, value, targets, type: "plain" });
    added++;
  }
  return { added, skippedSecrets };
}

/**
 * Replace a project's whole env set from the ".env editor": upsert every entry and
 * delete the ones the editor dropped, in a single atomic write.
 */
export async function setAppEnv(
  appId: string,
  entries: { key: string; value: string }[],
  defaultTargets?: EnvTarget[],
  opts?: { overwriteSecrets?: boolean },
): Promise<number> {
  const { userId } = await requireAppCapability(appId, "manage_env");
  const user = (await getCurrentUser())!;
  const targets = defaultTargets?.length
    ? sanitizeTargets(defaultTargets)
    : [...ALL_ENV_TARGETS];

  // Validate + dedupe (last assignment of a key wins), dropping invalid names.
  const wanted = new Map<string, string>();
  for (const e of entries) {
    const key = e.key.trim();
    if (!KEY_RE.test(key)) continue;
    wanted.set(key, e.value);
  }

  await getDb().transaction(async (tx) => {
    const existing = await loadEnvVarsForApp(appId, tx);
    const byKey = new Map(existing.map((e) => [e.key, e] as const));
    const created: EnvVar[] = [];
    for (const [key, value] of wanted) {
      const e = byKey.get(key);
      if (e) {
        // A secret is frozen: skip it unconditionally. Comparing against the MASK
        // used to be the whole guard, so any OTHER string overwrote the value.
        // `overwriteSecrets` is the import correcting a value it wrote itself.
        if (e.type === "secret" && !opts?.overwriteSecrets) continue;
        await tx
          .update(envVarsTable)
          .set({
            valueEnc: encryptSecret(value),
            updatedByUserId: userId,
            updatedAt: nowIso(),
          })
          .where(eq(envVarsTable.id, e.id));
      } else {
        created.push({
          id: newId("env"),
          appId,
          key,
          valueEnc: encryptSecret(value),
          targets,
          type: "plain",
          createdByUserId: userId,
          updatedByUserId: userId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
      }
    }
    if (created.length > 0) await insertEnvVars(tx, created);
    // Drop variables removed in the editor (their targets CASCADE).
    const removed = existing.filter((e) => !wanted.has(e.key)).map((e) => e.id);
    if (removed.length > 0)
      await tx.delete(envVarsTable).where(inArray(envVarsTable.id, removed));
  });
  await recordActivity(
    "env",
    `Edited environment (${wanted.size} variable${wanted.size === 1 ? "" : "s"})`,
    user.name,
    appId,
  );
  return wanted.size;
}

/**
 * Turn a secret back into a plain variable, with a value the caller types.
 *
 * The old value is never handed back - that is the whole promise of write-only -
 * so this REPLACES it. Without a way out, a variable the import typed as a secret
 * by mistake could only be deleted and remade.
 */
export async function makeEnvPlain(id: string, value: string): Promise<string> {
  const user = (await getCurrentUser())!;
  const existing = await loadEnvVar(id);
  if (!existing) throw new Error("Env var not found");
  const { userId } = await requireAppCapability(existing.appId, "manage_env");
  if (existing.type !== "secret")
    throw new Error(`${existing.key} is already a plain variable`);
  await getDb()
    .update(envVarsTable)
    .set({
      type: "plain",
      valueEnc: encryptSecret(value),
      updatedByUserId: userId,
      updatedAt: nowIso(),
    })
    .where(
      and(eq(envVarsTable.id, id), eq(envVarsTable.appId, existing.appId)),
    );
  await recordActivity(
    "env",
    `Made env var ${existing.key} plain`,
    user.name,
    existing.appId,
  );
  return existing.appId;
}

export async function deleteEnv(id: string): Promise<void> {
  const user = (await getCurrentUser())!;
  const e = await loadEnvVar(id);
  if (!e) throw new Error("Not found");
  await requireAppCapability(e.appId, "manage_env");
  // The env_var_targets child rows CASCADE on the delete.
  await getDb().delete(envVarsTable).where(eq(envVarsTable.id, id));
  await recordActivity("env", `Deleted env var ${e.key}`, user.name, e.appId);
}
