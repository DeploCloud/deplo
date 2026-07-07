import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  environmentEnvVars as envVarsTable,
  environments as environmentsTable,
  projects as projectsTable,
  services as servicesTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret } from "../crypto";
import type {
  EnvironmentEnvVar,
  EnvironmentEnvVarDTO,
  EnvironmentKind,
} from "../types";

/**
 * ENVIRONMENT-scoped shared env vars (ADR-0008 Phase 3) — variables stored on
 * one of a Project's Environments and injected into EVERY service of that
 * Project, in that environment's context. The environment IS the scope, so
 * (unlike per-service/global vars) there is no `targets` axis: the environment's
 * `kind` bridges to the runtime target until the pipeline is fully
 * environment-parameterized. The deploy merge in lib/deploy/env-resolve.ts
 * layers these ABOVE team/instance globals but UNDER a service's own vars, so a
 * service can still override its project's environment default. CRUD is gated
 * `manage_env` like every other env-var surface; encryption is identical
 * (encryptSecret at rest; decrypt only at the deploy edge or on explicit reveal).
 */

const MASK = "••••••••••••";
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

function toDTO(e: EnvironmentEnvVar): EnvironmentEnvVarDTO {
  const isSecret = e.type === "secret";
  return {
    id: e.id,
    environmentId: e.environmentId,
    key: e.key,
    // Secrets are always masked; only plain vars decrypt for display.
    value: isSecret ? MASK : decryptSecret(e.valueEnc),
    masked: isSecret,
    type: e.type,
    updatedAt: e.updatedAt,
  };
}

function assemble(r: typeof envVarsTable.$inferSelect): EnvironmentEnvVar {
  return {
    id: r.id,
    environmentId: r.environmentId,
    key: r.key,
    valueEnc: r.valueEnc,
    type: r.type as "plain" | "secret",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Verify an environment's Project belongs to the active team (the caller has
 * already been capability-gated); returns the rows the mutations log with.
 */
async function requireOwnedEnvironment(
  environmentId: string,
  teamId: string,
): Promise<{ envName: string; projectName: string }> {
  const rows = await getDb()
    .select({
      envName: environmentsTable.name,
      projectName: projectsTable.name,
      teamId: projectsTable.teamId,
    })
    .from(environmentsTable)
    .innerJoin(projectsTable, eq(environmentsTable.projectId, projectsTable.id))
    .where(eq(environmentsTable.id, environmentId))
    .limit(1);
  if (rows[0]?.teamId !== teamId) throw new Error("Environment not found");
  return { envName: rows[0].envName, projectName: rows[0].projectName };
}

/* ------------------------------------------------------------------ */
/* Reads — gated `manage_env`, scoped to the active team.              */
/* ------------------------------------------------------------------ */

/** One environment's shared variables, key-sorted. */
export async function listEnvironmentEnv(
  environmentId: string,
): Promise<EnvironmentEnvVarDTO[]> {
  const { teamId } = await requireCapability("manage_env");
  await requireOwnedEnvironment(environmentId, teamId);
  const rows = await getDb()
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.environmentId, environmentId))
    .orderBy(asc(envVarsTable.key));
  return rows.map(assemble).map(toDTO);
}

/** A Variables-page group: one environment of one project, with its vars. */
export interface EnvironmentEnvGroup {
  environmentId: string;
  environmentName: string;
  environmentSlug: string;
  kind: EnvironmentKind;
  isDefault: boolean;
  vars: EnvironmentEnvVarDTO[];
}

/**
 * Every environment of one Project with its shared vars, in display order —
 * including var-less environments (the page offers "add" there, so an empty
 * environment is signal, not noise).
 */
export async function listProjectEnvironmentEnv(
  projectId: string,
): Promise<EnvironmentEnvGroup[]> {
  const { teamId } = await requireCapability("manage_env");
  const owned = await getDb()
    .select({ teamId: projectsTable.teamId })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId))
    .limit(1);
  if (owned[0]?.teamId !== teamId) throw new Error("Project not found");
  const envs = await getDb()
    .select()
    .from(environmentsTable)
    .where(eq(environmentsTable.projectId, projectId))
    .orderBy(asc(environmentsTable.position));
  if (envs.length === 0) return [];
  const vars = await getDb()
    .select()
    .from(envVarsTable)
    .where(inArray(envVarsTable.environmentId, envs.map((e) => e.id)))
    .orderBy(asc(envVarsTable.key));
  return envs.map((e) => ({
    environmentId: e.id,
    environmentName: e.name,
    environmentSlug: e.slug,
    kind: e.kind as EnvironmentKind,
    isDefault: e.isDefault,
    vars: vars
      .filter((v) => v.environmentId === e.id)
      .map(assemble)
      .map(toDTO),
  }));
}

export async function revealEnvironmentEnv(id: string): Promise<string> {
  const { teamId } = await requireCapability("manage_env");
  const rows = await getDb()
    .select({ valueEnc: envVarsTable.valueEnc, environmentId: envVarsTable.environmentId })
    .from(envVarsTable)
    .where(eq(envVarsTable.id, id))
    .limit(1);
  if (!rows[0]) throw new Error("Not found");
  await requireOwnedEnvironment(rows[0].environmentId, teamId);
  return decryptSecret(rows[0].valueEnc);
}

/* ------------------------------------------------------------------ */
/* Mutations — gated `manage_env`, scoped to the active team.          */
/* ------------------------------------------------------------------ */

export async function upsertEnvironmentEnv(input: {
  environmentId: string;
  key: string;
  value: string;
  type: "plain" | "secret";
}): Promise<void> {
  const { membership } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  const { envName, projectName } = await requireOwnedEnvironment(
    input.environmentId,
    membership.teamId,
  );
  const key = input.key.trim();
  if (!KEY_RE.test(key)) throw new Error("Invalid variable name");
  // The editor sends the MASK back unchanged when only the type changed on a
  // secret — keep the stored value rather than encrypting the mask string.
  const keepValue = input.value === MASK;

  await getDb().transaction(async (tx) => {
    const existing = await tx
      .select({ id: envVarsTable.id })
      .from(envVarsTable)
      .where(
        and(
          eq(envVarsTable.environmentId, input.environmentId),
          eq(envVarsTable.key, key),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      await tx
        .update(envVarsTable)
        .set({
          ...(keepValue ? {} : { valueEnc: encryptSecret(input.value) }),
          type: input.type,
          updatedAt: nowIso(),
        })
        .where(eq(envVarsTable.id, existing[0]!.id));
    } else {
      const now = nowIso();
      await tx.insert(envVarsTable).values({
        id: newId("env"),
        environmentId: input.environmentId,
        key,
        valueEnc: encryptSecret(input.value),
        type: input.type,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  await recordActivity(
    "env",
    `Updated ${projectName}/${envName} environment variable ${key}`,
    user.name,
    null,
    membership.teamId,
  );
}

export async function deleteEnvironmentEnv(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_env");
  const user = (await getCurrentUser())!;
  const rows = await getDb()
    .select({ key: envVarsTable.key, environmentId: envVarsTable.environmentId })
    .from(envVarsTable)
    .where(eq(envVarsTable.id, id))
    .limit(1);
  if (!rows[0]) throw new Error("Not found");
  const { envName, projectName } = await requireOwnedEnvironment(
    rows[0].environmentId,
    membership.teamId,
  );
  await getDb().delete(envVarsTable).where(eq(envVarsTable.id, id));
  await recordActivity(
    "env",
    `Deleted ${projectName}/${envName} environment variable ${rows[0].key}`,
    user.name,
    null,
    membership.teamId,
  );
}

/* ------------------------------------------------------------------ */
/* Deploy-time loader — NO auth gate (the deploy is already authorized). */
/* ------------------------------------------------------------------ */

/** Still-encrypted entry the deploy merge consumes; `kind` gates the runtime. */
export interface EnvironmentEnvEntry {
  key: string;
  valueEnc: string;
  kind: EnvironmentKind;
}

/**
 * The environment-scoped entries that apply to one service: every variable of
 * every Environment of the service's Project (a service with no Project has
 * none). The resolver keeps only entries whose `kind` matches the deploy
 * target — a `custom` environment's vars reach no legacy runtime until the
 * per-environment pipeline lands. Returns encrypted entries; the caller
 * decrypts at the edge.
 */
export async function loadEnvironmentEnvForService(
  serviceId: string,
): Promise<EnvironmentEnvEntry[]> {
  const srow = await getDb()
    .select({ projectId: servicesTable.projectId })
    .from(servicesTable)
    .where(eq(servicesTable.id, serviceId))
    .limit(1);
  const projectId = srow[0]?.projectId;
  if (!projectId) return [];
  const rows = await getDb()
    .select({
      key: envVarsTable.key,
      valueEnc: envVarsTable.valueEnc,
      kind: environmentsTable.kind,
    })
    .from(envVarsTable)
    .innerJoin(
      environmentsTable,
      eq(envVarsTable.environmentId, environmentsTable.id),
    )
    .where(eq(environmentsTable.projectId, projectId))
    .orderBy(asc(envVarsTable.key));
  return rows.map((r) => ({
    key: r.key,
    valueEnc: r.valueEnc,
    kind: r.kind as EnvironmentKind,
  }));
}
