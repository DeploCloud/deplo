import "server-only";

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
import { requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { requireFolderCapabilityForApp } from "./folder-access";
import { encryptSecret, decryptSecret } from "../crypto";
import {
  insertEnvVars,
  loadEnvVar,
  loadEnvVarsForApp,
  loadEnvVarsForApps,
  appInTeam,
} from "./app-graph-load";
import { authorOf, loadUserIdentities } from "./user-identity";
import { ALL_ENV_TARGETS, sanitizeTargets } from "../types";
import type { EnvTarget, EnvVar, EnvVarDTO, VarAuthor } from "../types";

const MASK = "••••••••••••";

function toDTO(e: EnvVar, authors: Map<string, VarAuthor>): EnvVarDTO {
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
    // Authorship is metadata, not value — safe to project while `value` stays masked.
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
 * (the data calls below return empty / throw) — matching the hidden tabs.
 */
export async function listEnv(appId: string): Promise<EnvVarDTO[]> {
  const { teamId } = await requireCapability("manage_env");
  // Env vars are owned through their project; an out-of-team project yields none.
  if (!(await appInTeam(appId, teamId))) return [];
  await requireFolderCapabilityForApp(appId, "manage_env");
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
   * them to tell you what a scope actually reaches. Both are null for a loose app.
   *
   * `logo` / `primaryDomain` are what the wizard's app cards show, so two apps
   * with near-identical names are told apart by sight instead of by slug.
   */
  app: {
    id: string;
    name: string;
    slug: string;
    projectId: string | null;
    environmentId: string | null;
    logo: string | null;
    /** Hostname of the app's primary domain — at most one per app (DB-enforced). */
    primaryDomain: string | null;
  };
  vars: EnvVarDTO[];
}

/** The primary domain hostname of each given app, for the ones that have one. */
async function loadPrimaryDomains(appIds: string[]): Promise<Map<string, string>> {
  if (appIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ appId: domainsTable.appId, name: domainsTable.name })
    .from(domainsTable)
    .where(
      and(inArray(domainsTable.appId, appIds), eq(domainsTable.isPrimary, true)),
    );
  return new Map(rows.map((r) => [r.appId, r.name]));
}

/** Every project's env vars, grouped by project (for the global Variables tab). */
export async function listAllAppEnv(): Promise<AppEnvGroup[]> {
  const { teamId } = await requireCapability("manage_env");
  const apps = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      slug: appsTable.slug,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
      logo: appsTable.logo,
    })
    .from(appsTable)
    .where(eq(appsTable.teamId, teamId));
  // Batch-load every var across the team's apps (one pair of queries), then
  // group in memory — no per-project round-trip.
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

/** Reveal a single secret value. Requires `manage_env`; returns plaintext. */
export async function revealEnv(id: string): Promise<string> {
  const { teamId } = await requireCapability("manage_env");
  const e = await loadEnvVar(id);
  if (!e) throw new Error("Not found");
  if (!(await appInTeam(e.appId, teamId))) throw new Error("Not found");
  await requireFolderCapabilityForApp(e.appId, "manage_env");
  return decryptSecret(e.valueEnc);
}

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

export async function upsertEnv(input: {
  appId: string;
  key: string;
  value: string;
  /**
   * Omitted (the UI no longer asks): a NEW var gets every runtime; an EDIT keeps
   * whatever targets the var already has — an edit must never widen them.
   */
  targets?: EnvTarget[];
  type: "plain" | "secret";
}): Promise<void> {
  const { membership, userId } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  const key = input.key.trim();
  if (!KEY_RE.test(key)) throw new Error("Invalid variable name");
  // `null` ⇒ the caller named no targets: default them on insert, PRESERVE them on
  // update. Silently widening a legacy production-only secret would inject it into
  // the dev container (lib/deploy/dev.ts).
  const targets = input.targets?.length ? sanitizeTargets(input.targets) : null;
  if (!(await appInTeam(input.appId, membership.teamId)))
    throw new Error("App not found");
  await requireFolderCapabilityForApp(input.appId, "manage_env");
  // The editor sends the MASK back unchanged when only the targets/type changed on
  // a secret (you cannot read back a secret you didn't set) — keep the stored value
  // rather than encrypting the mask string over it. Same contract as the shared and
  // global scopes; without it, editing a secret's environments WIPED its value.
  const keepValue = input.value === MASK;

  await getDb().transaction(async (tx) => {
    const existing = await tx
      .select({ id: envVarsTable.id })
      .from(envVarsTable)
      .where(
        and(
          eq(envVarsTable.appId, input.appId),
          eq(envVarsTable.key, key),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      const varId = existing[0]!.id;
      await tx
        .update(envVarsTable)
        .set({
          ...(keepValue ? {} : { valueEnc: encryptSecret(input.value) }),
          type: input.type,
          // An edit never rewrites who created the var.
          updatedByUserId: userId,
          updatedAt: nowIso(),
        })
        .where(eq(envVarsTable.id, varId));
      // Whole-set replace of the targets junction — only when the caller sent one.
      if (targets) {
        await tx.delete(envVarTargetsTable).where(eq(envVarTargetsTable.envVarId, varId));
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

/** Bulk import from a .env style blob. */
export async function importEnv(
  appId: string,
  blob: string,
  targets?: EnvTarget[],
): Promise<number> {
  const { membership } = await requireCapability("manage_env");
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");
  await requireFolderCapabilityForApp(appId, "manage_env");
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
    await upsertEnv({ appId, key, value, targets, type: "plain" });
    count++;
  }
  return count;
}

/**
 * Replace a project's whole env set from the ".env editor": upsert every entry
 * and delete the ones the editor dropped, in a single atomic write.
 *
 *  - New keys are created as PLAIN (never secret by default) with `defaultTargets`
 *    (omitted ⇒ every runtime).
 *  - Existing keys keep their `type` and `targets` (the flat editor can't express
 *    them); only the value changes.
 *  - A SECRET whose incoming value is still the mask (the editor hides secret
 *    values) is left untouched — so editing the file never clobbers a secret you
 *    couldn't see. Changing a secret's masked value to anything else updates it
 *    (and it stays secret).
 */
export async function setAppEnv(
  appId: string,
  entries: { key: string; value: string }[],
  defaultTargets?: EnvTarget[],
): Promise<number> {
  const { membership, userId } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");
  await requireFolderCapabilityForApp(appId, "manage_env");
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
        // Skip an unchanged secret (its masked value came back verbatim).
        if (e.type === "secret" && value === MASK) continue;
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
    const removed = existing
      .filter((e) => !wanted.has(e.key))
      .map((e) => e.id);
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

export async function deleteEnv(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  const e = await loadEnvVar(id);
  if (!e) throw new Error("Not found");
  if (!(await appInTeam(e.appId, membership.teamId)))
    throw new Error("Not found");
  await requireFolderCapabilityForApp(e.appId, "manage_env");
  // The env_var_targets child rows CASCADE on the delete.
  await getDb().delete(envVarsTable).where(eq(envVarsTable.id, id));
  await recordActivity("env", `Deleted env var ${e.key}`, user.name, e.appId);
}
