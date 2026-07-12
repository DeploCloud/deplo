import "server-only";

import { and, asc, eq, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  environments as environmentsTable,
  projects as projectsTable,
  apps as appsTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import type { Environment, EnvironmentKind } from "../types";

/**
 * Environment CRUD (ADR-0008 Phase 3). Environments are owned by a Project
 * container and gate on the container's team (`deploy`) — there are no
 * per-environment grants. The three defaults are seeded on Project create via
 * {@link defaultEnvironmentRows}; users may add `custom` ones, rename them, pick
 * the default, and delete any non-default (never the last).
 */

const MAX_NAME = 40;

/** The seeded three, in display order. Production is the default. */
const SEED: { name: string; slug: string; kind: EnvironmentKind; isDefault: boolean }[] =
  [
    { name: "Development", slug: "development", kind: "development", isDefault: false },
    { name: "Preview", slug: "preview", kind: "preview", isDefault: false },
    { name: "Production", slug: "production", kind: "production", isDefault: true },
  ];

/** The default environment rows for a freshly-created Project (pure builder). */
export function defaultEnvironmentRows(
  projectId: string,
  now: string = nowIso(),
): (typeof environmentsTable.$inferInsert)[] {
  return SEED.map((e, position) => ({
    id: newId("environ"),
    projectId,
    name: e.name,
    slug: e.slug,
    kind: e.kind,
    gitBranch: "",
    isDefault: e.isDefault,
    position,
    createdAt: now,
    updatedAt: now,
  }));
}

function assembleEnvironment(r: typeof environmentsTable.$inferSelect): Environment {
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    slug: r.slug,
    kind: r.kind as EnvironmentKind,
    gitBranch: r.gitBranch,
    isDefault: r.isDefault,
    position: r.position,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Environment name is required.");
  if (trimmed.length > MAX_NAME)
    throw new Error(`Environment name must be ${MAX_NAME} characters or fewer.`);
  return trimmed;
}

/** Verify a container belongs to the active team; returns its team id. */
async function requireOwnedProject(projectId: string): Promise<string> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({ teamId: projectsTable.teamId })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId))
    .limit(1);
  if (rows[0]?.teamId !== teamId) throw new Error("Project not found");
  return teamId;
}

/** The environments of a Project container, in display order. */
export async function listEnvironmentsForProject(
  projectId: string,
): Promise<Environment[]> {
  await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(environmentsTable)
    .where(eq(environmentsTable.projectId, projectId))
    .orderBy(asc(environmentsTable.position));
  return rows.map(assembleEnvironment);
}

/** An environment labelled with its owning Project (for shared-var scope pickers). */
export interface TeamEnvironment {
  id: string;
  name: string;
  slug: string;
  kind: EnvironmentKind;
  projectId: string;
  projectName: string;
}

/**
 * Every environment across the active team's projects, ordered by project then
 * position — the source for the "share to environments" multi-select on the
 * unified Shared-variables tab. No env values are read, so the view floor
 * (`requireActiveTeamId`) suffices, matching `listProjects`.
 */
export async function listAllEnvironmentsForTeam(): Promise<TeamEnvironment[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({
      id: environmentsTable.id,
      name: environmentsTable.name,
      slug: environmentsTable.slug,
      kind: environmentsTable.kind,
      projectId: environmentsTable.projectId,
      projectName: projectsTable.name,
    })
    .from(environmentsTable)
    .innerJoin(projectsTable, eq(environmentsTable.projectId, projectsTable.id))
    .where(eq(projectsTable.teamId, teamId))
    .orderBy(asc(projectsTable.name), asc(environmentsTable.position));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    kind: r.kind as EnvironmentKind,
    projectId: r.projectId,
    projectName: r.projectName,
  }));
}

/** A URL-safe slug from a name, unique within the project. */
async function uniqueEnvSlug(projectId: string, name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `env-${newId("").slice(1, 6)}`;
  const taken = new Set(
    (
      await getDb()
        .select({ slug: environmentsTable.slug })
        .from(environmentsTable)
        .where(eq(environmentsTable.projectId, projectId))
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Add a `custom` environment to a container (appended last). */
export async function createEnvironment(
  projectId: string,
  name: string,
): Promise<Environment> {
  await requireCapability("deploy");
  await requireOwnedProject(projectId);
  const clean = cleanName(name);
  const slug = await uniqueEnvSlug(projectId, clean);
  const existing = await getDb()
    .select({ position: environmentsTable.position })
    .from(environmentsTable)
    .where(eq(environmentsTable.projectId, projectId));
  const position = existing.reduce((m, r) => Math.max(m, r.position + 1), 0);
  const now = nowIso();
  const env: typeof environmentsTable.$inferInsert = {
    id: newId("environ"),
    projectId,
    name: clean,
    slug,
    kind: "custom",
    gitBranch: "",
    isDefault: false,
    position,
    createdAt: now,
    updatedAt: now,
  };
  await getDb().insert(environmentsTable).values(env);
  return assembleEnvironment(env as typeof environmentsTable.$inferSelect);
}

export async function renameEnvironment(id: string, name: string): Promise<void> {
  await requireCapability("deploy");
  const clean = cleanName(name);
  const env = (
    await getDb().select().from(environmentsTable).where(eq(environmentsTable.id, id)).limit(1)
  )[0];
  if (!env) throw new Error("Environment not found");
  await requireOwnedProject(env.projectId);
  await getDb()
    .update(environmentsTable)
    .set({ name: clean, updatedAt: nowIso() })
    .where(eq(environmentsTable.id, id));
}

/** Set the git branch this environment builds from ("" ⇒ the app default). */
export async function setEnvironmentBranch(id: string, branch: string): Promise<void> {
  await requireCapability("deploy");
  const env = (
    await getDb().select().from(environmentsTable).where(eq(environmentsTable.id, id)).limit(1)
  )[0];
  if (!env) throw new Error("Environment not found");
  await requireOwnedProject(env.projectId);
  await getDb()
    .update(environmentsTable)
    .set({ gitBranch: branch.trim(), updatedAt: nowIso() })
    .where(eq(environmentsTable.id, id));
}

/** Make `id` the project's default environment (unsets the previous default). */
export async function setDefaultEnvironment(id: string): Promise<void> {
  await requireCapability("deploy");
  const env = (
    await getDb().select().from(environmentsTable).where(eq(environmentsTable.id, id)).limit(1)
  )[0];
  if (!env) throw new Error("Environment not found");
  await requireOwnedProject(env.projectId);
  if (env.isDefault) return;
  await getDb().transaction(async (tx) => {
    await tx
      .update(environmentsTable)
      .set({ isDefault: false, updatedAt: nowIso() })
      .where(
        and(
          eq(environmentsTable.projectId, env.projectId),
          ne(environmentsTable.id, id),
        ),
      );
    await tx
      .update(environmentsTable)
      .set({ isDefault: true, updatedAt: nowIso() })
      .where(eq(environmentsTable.id, id));
  });
}

/**
 * Delete a non-default environment; never the default or the last one. The
 * environment's apps are NOT deleted: they re-parent to the project's
 * default environment (ADR-0009 — an environment is a sub-folder of apps,
 * so removing the sub-folder keeps its contents in the project).
 */
export async function deleteEnvironment(id: string): Promise<void> {
  await requireCapability("deploy");
  const env = (
    await getDb().select().from(environmentsTable).where(eq(environmentsTable.id, id)).limit(1)
  )[0];
  if (!env) throw new Error("Environment not found");
  await requireOwnedProject(env.projectId);
  if (env.isDefault)
    throw new Error("Can't delete the default environment — pick another default first.");
  const siblings = await getDb()
    .select({ id: environmentsTable.id, isDefault: environmentsTable.isDefault })
    .from(environmentsTable)
    .where(eq(environmentsTable.projectId, env.projectId));
  if (siblings.length <= 1)
    throw new Error("A project must keep at least one environment.");
  const fallback = siblings.find((e) => e.isDefault && e.id !== id) ?? null;
  await getDb().transaction(async (tx) => {
    await tx
      .update(appsTable)
      .set({ environmentId: fallback?.id ?? null, updatedAt: nowIso() })
      .where(eq(appsTable.environmentId, id));
    await tx.delete(environmentsTable).where(eq(environmentsTable.id, id));
  });
}
