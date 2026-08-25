import "server-only";

import { and, asc, eq, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  environments as environmentsTable,
  projects as projectsTable,
  apps as appsTable,
} from "../db/schema/control-plane";
import { PREVIEW_SUFFIX_RE } from "../deploy/deploy-key";
import { newId, nowIso } from "../ids";
import {
  currentMemberScope,
  requireActiveTeamId,
  requireCapability,
} from "../membership";
import { inProjectScope } from "../auth/request-context";
import { projectInScope } from "./node-scope";
import { assertContainerNotMigrating } from "./migration-guard";
import type { Environment, EnvironmentKind } from "../types";

/**
 * Environment CRUD (ADR-0008 Phase 3). Environments are owned by a Project
 * container and gate on the container's team (`deploy`) - there are no
 * per-environment grants.
 */

const MAX_NAME = 40;

/** The seeded three, in display order. Production is the default. */
const SEED: {
  name: string;
  slug: string;
  kind: EnvironmentKind;
  isDefault: boolean;
}[] = [
  {
    name: "Development",
    slug: "development",
    kind: "development",
    isDefault: false,
  },
  { name: "Preview", slug: "preview", kind: "preview", isDefault: false },
  {
    name: "Production",
    slug: "production",
    kind: "production",
    isDefault: true,
  },
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

function assembleEnvironment(
  r: typeof environmentsTable.$inferSelect,
): Environment {
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
    throw new Error(
      `Environment name must be ${MAX_NAME} characters or fewer.`,
    );
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
  // A container outside an API token's project scope reads exactly like one that
  // doesn't exist - same message, no existence oracle.
  if (
    rows[0]?.teamId !== teamId ||
    !inProjectScope(projectId) ||
    !projectInScope(await currentMemberScope(), projectId)
  )
    throw new Error("Project not found");
  return teamId;
}

/** The environments of a Project container, in display order. */
export async function listEnvironmentsForProject(
  projectId: string,
): Promise<Environment[]> {
  const teamId = await requireActiveTeamId();
  // Both reaches: an environment belongs to a project, so a caller who cannot
  // reach the project cannot enumerate what is inside it.
  if (!inProjectScope(projectId)) return [];
  if (!projectInScope(await currentMemberScope(), projectId)) return [];
  // Team-scope through the owning Project (as listAllEnvironmentsForTeam does):
  // a foreign or unknown project id yields nothing, never another team's rows.
  const rows = await getDb()
    .select({ environment: environmentsTable })
    .from(environmentsTable)
    .innerJoin(projectsTable, eq(environmentsTable.projectId, projectsTable.id))
    .where(
      and(
        eq(environmentsTable.projectId, projectId),
        eq(projectsTable.teamId, teamId),
      ),
    )
    .orderBy(asc(environmentsTable.position));
  return rows.map((r) => assembleEnvironment(r.environment));
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
 * position - the source for the "share to environments" multi-select on the
 * unified Shared-variables tab.
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
  // One resolution for the whole list, never one per row.
  const roleScope = await currentMemberScope();
  return rows
    .filter(
      (r) =>
        inProjectScope(r.projectId) && projectInScope(roleScope, r.projectId),
    )
    .map((r) => ({
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
  // `pr-<n>` is reserved: an environment slugged that way would produce the EXACT
  // deploy key a pull request preview of the same app owns (`<slug>__pr-42`), i.e.
  // two different things fighting over one container.
  if (!taken.has(base) && !PREVIEW_SUFFIX_RE.test(base)) return base;
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
  await requireCapability("manage_environments");
  await requireOwnedProject(projectId);
  // Adding to a project a migration is still building: the run decides what
  // environments that project has until it is done.
  await assertContainerNotMigrating("project", projectId);
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

export async function renameEnvironment(
  id: string,
  name: string,
): Promise<void> {
  await requireCapability("manage_environments");
  await assertContainerNotMigrating("environment", id);
  const clean = cleanName(name);
  const env = (
    await getDb()
      .select()
      .from(environmentsTable)
      .where(eq(environmentsTable.id, id))
      .limit(1)
  )[0];
  if (!env) throw new Error("Environment not found");
  await requireOwnedProject(env.projectId);
  await getDb()
    .update(environmentsTable)
    .set({ name: clean, updatedAt: nowIso() })
    .where(eq(environmentsTable.id, id));
}

/** Set the git branch this environment builds from ("" ⇒ the app default). */
export async function setEnvironmentBranch(
  id: string,
  branch: string,
): Promise<void> {
  await requireCapability("manage_environments");
  await assertContainerNotMigrating("environment", id);
  const env = (
    await getDb()
      .select()
      .from(environmentsTable)
      .where(eq(environmentsTable.id, id))
      .limit(1)
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
  await requireCapability("manage_environments");
  await assertContainerNotMigrating("environment", id);
  const env = (
    await getDb()
      .select()
      .from(environmentsTable)
      .where(eq(environmentsTable.id, id))
      .limit(1)
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
 * Delete a non-default environment; never the default or the last one.
 */
export async function deleteEnvironment(id: string): Promise<void> {
  await requireCapability("manage_environments");
  // Takes the apps in it with it, and a run may still be creating them.
  await assertContainerNotMigrating("environment", id);
  const env = (
    await getDb()
      .select()
      .from(environmentsTable)
      .where(eq(environmentsTable.id, id))
      .limit(1)
  )[0];
  if (!env) throw new Error("Environment not found");
  await requireOwnedProject(env.projectId);
  if (env.isDefault)
    throw new Error(
      "Can't delete the default environment - pick another default first.",
    );
  const siblings = await getDb()
    .select({
      id: environmentsTable.id,
      isDefault: environmentsTable.isDefault,
    })
    .from(environmentsTable)
    .where(eq(environmentsTable.projectId, env.projectId))
    .orderBy(asc(environmentsTable.position));
  if (siblings.length <= 1)
    throw new Error("A project must keep at least one environment.");
  // The project's default, else its FIRST remaining environment, never null.
  const others = siblings.filter((e) => e.id !== id);
  const fallback = others.find((e) => e.isDefault) ?? others[0];
  await getDb().transaction(async (tx) => {
    await tx
      .update(appsTable)
      .set({ environmentId: fallback.id, updatedAt: nowIso() })
      .where(eq(appsTable.environmentId, id));
    await tx.delete(environmentsTable).where(eq(environmentsTable.id, id));
  });
}
