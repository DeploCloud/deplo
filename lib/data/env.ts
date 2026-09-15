import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import {
  envVars as envVarsTable,
  envVarTargets as envVarTargetsTable,
} from "../db/schema/control-plane/env-vars";
import { getCurrentUser } from "../auth/current-user";
import { newId, nowIso } from "../ids";
import { requireMembership } from "../membership";
import { recordActivity } from "./activity";
import { markPendingChanges } from "./pending-changes";
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
import {
  ALL_ENV_TARGETS,
  sanitizeTargets,
  secretImmutable,
} from "../types/env";
import type { EnvTarget, EnvVar, EnvVarDTO } from "../types/env";
import type { VarAuthor } from "../types/identity";

const MASK = "••••••••••••";

function toDTO(e: EnvVar, authors: Map<string, VarAuthor>): EnvVarDTO {
  const isSecret = e.type === "secret";
  return {
    id: e.id,
    key: e.key,
    value: isSecret ? MASK : decryptSecret(e.valueEnc),
    masked: isSecret,
    targets: e.targets,
    type: e.type,
    createdBy: authorOf(e.createdByUserId, authors),
    updatedBy: authorOf(e.updatedByUserId, authors),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

function authorIds(vars: EnvVar[]): (string | null)[] {
  return vars.flatMap((e) => [e.createdByUserId, e.updatedByUserId]);
}

export async function listEnv(appId: string): Promise<EnvVarDTO[]> {
  if (!(await hasAppCapability(appId, "manage_env"))) return [];
  const vars = (await loadEnvVarsForApp(appId)).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const authors = await loadUserIdentities(authorIds(vars));
  return vars.map((e) => toDTO(e, authors));
}

export interface AppEnvGroup {
  app: {
    id: string;
    name: string;
    slug: string;
    projectId: string | null;
    environmentId: string | null;
    logo: string | null;
    primaryDomain: string | null;
  };
  vars: EnvVarDTO[];
}

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

export async function listEnvManageableApps(): Promise<AppEnvGroup["app"][]> {
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
  const reach = await appCapabilitiesForTeam(teamId, rows);
  const apps = rows.filter((p) => reach.get(p.id)?.includes("manage_env"));
  const primaryDomains = await loadPrimaryDomains(apps.map((p) => p.id));
  return apps
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      projectId: p.projectId,
      environmentId: p.environmentId,
      logo: p.logo ?? null,
      primaryDomain: primaryDomains.get(p.id) ?? null,
    }));
}

export async function listAllAppEnv(): Promise<AppEnvGroup[]> {
  const apps = await listEnvManageableApps();
  const all = await loadEnvVarsForApps(apps.map((p) => p.id));
  const authors = await loadUserIdentities(authorIds(all));
  const byApp = new Map<string, EnvVar[]>();
  for (const e of all) {
    const list = byApp.get(e.appId) ?? [];
    list.push(e);
    byApp.set(e.appId, list);
  }
  return apps.map((app) => ({
    app,
    vars: (byApp.get(app.id) ?? [])
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((e) => toDTO(e, authors)),
  }));
}

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

export async function upsertEnv(input: {
  appId: string;
  key: string;
  value: string;
  targets?: EnvTarget[];
  type: "plain" | "secret";
}): Promise<void> {
  const { userId } = await requireAppCapability(input.appId, "manage_env");
  const user = (await getCurrentUser())!;
  const key = input.key.trim();
  if (!KEY_RE.test(key)) throw new Error("Invalid variable name");
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
      if (existing[0]!.type === "secret") throw new Error(secretImmutable(key));
      const varId = existing[0]!.id;
      await tx
        .update(envVarsTable)
        .set({
          valueEnc: encryptSecret(input.value),
          type: input.type,
          updatedByUserId: userId,
          updatedAt: nowIso(),
        })
        .where(eq(envVarsTable.id, varId));
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
  await markPendingChanges([input.appId]);
  await recordActivity("env", `Updated env var ${key}`, user.name, input.appId);
}

export async function renameEnv(
  id: string,
  newKeyRaw: string,
): Promise<string> {
  const user = (await getCurrentUser())!;
  const newKey = newKeyRaw.trim();
  if (!KEY_RE.test(newKey)) throw new Error("Invalid variable name");
  const existing = await loadEnvVar(id);
  if (!existing) throw new Error("Env var not found");
  const { userId } = await requireAppCapability(existing.appId, "manage_env");
  if (existing.type === "secret")
    throw new Error(secretImmutable(existing.key));
  if (existing.key === newKey) return existing.appId;
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
  await markPendingChanges([existing.appId]);
  await recordActivity(
    "env",
    `Renamed env var ${existing.key} → ${newKey}`,
    user.name,
    existing.appId,
  );
  return existing.appId;
}

export async function importEnv(
  appId: string,
  blob: string,
  targets?: EnvTarget[],
): Promise<{ added: number; skippedSecrets: number }> {
  await requireAppCapability(appId, "manage_env");
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
    await upsertEnv({ appId, key, value, targets, type: "plain" });
    added++;
  }
  return { added, skippedSecrets };
}

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
    const removed = existing.filter((e) => !wanted.has(e.key)).map((e) => e.id);
    if (removed.length > 0)
      await tx.delete(envVarsTable).where(inArray(envVarsTable.id, removed));
  });
  await markPendingChanges([appId]);
  await recordActivity(
    "env",
    `Edited environment (${wanted.size} variable${wanted.size === 1 ? "" : "s"})`,
    user.name,
    appId,
  );
  return wanted.size;
}

export async function deleteEnv(id: string): Promise<void> {
  const user = (await getCurrentUser())!;
  const e = await loadEnvVar(id);
  if (!e) throw new Error("Not found");
  await requireAppCapability(e.appId, "manage_env");
  await getDb().delete(envVarsTable).where(eq(envVarsTable.id, id));
  await markPendingChanges([e.appId]);
  await recordActivity("env", `Deleted env var ${e.key}`, user.name, e.appId);
}
