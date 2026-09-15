import "server-only";

import { and, asc, eq, ne } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import {
  environments as environmentsTable,
  projects as projectsTable,
} from "../db/schema/control-plane/projects";
import { PREVIEW_SUFFIX_RE } from "../deploy/deploy-key";
import { newId, nowIso } from "../ids";
import { reapplyNetworkAfterMove } from "../deploy/build/reroute";
import { nameClashesOnMove } from "./name-clash";
import { recordActivity } from "./activity";
import { reapplyDatabaseNetwork } from "./databases/environment-move";
import {
  currentMemberScope,
  requireActiveTeamId,
  requireCapability,
} from "../membership";
import { inProjectScope } from "../auth/request-context";
import { projectInScope } from "./node-scope";
import { assertContainerNotMigrating } from "./migration-guard";
import type { Environment, EnvironmentKind } from "../types/team";

const MAX_NAME = 40;

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

async function requireOwnedProject(projectId: string): Promise<string> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({ teamId: projectsTable.teamId })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId))
    .limit(1);
  if (
    rows[0]?.teamId !== teamId ||
    !inProjectScope(projectId) ||
    !projectInScope(await currentMemberScope(), projectId)
  )
    throw new Error("Project not found");
  return teamId;
}

export async function environmentInTeam(
  environmentId: string,
  teamId: string,
): Promise<{ id: string; projectId: string } | null> {
  const env = (
    await getDb()
      .select({
        id: environmentsTable.id,
        projectId: environmentsTable.projectId,
        teamId: projectsTable.teamId,
      })
      .from(environmentsTable)
      .innerJoin(
        projectsTable,
        eq(environmentsTable.projectId, projectsTable.id),
      )
      .where(eq(environmentsTable.id, environmentId))
      .limit(1)
  )[0];
  if (!env || env.teamId !== teamId) return null;
  return { id: env.id, projectId: env.projectId };
}

export async function listEnvironmentsForProject(
  projectId: string,
): Promise<Environment[]> {
  const teamId = await requireActiveTeamId();
  if (!inProjectScope(projectId)) return [];
  if (!projectInScope(await currentMemberScope(), projectId)) return [];
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

export interface TeamEnvironment {
  id: string;
  name: string;
  slug: string;
  kind: EnvironmentKind;
  projectId: string;
  projectName: string;
}

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
  if (!taken.has(base) && !PREVIEW_SUFFIX_RE.test(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const MAX_ENVIRONMENTS_PER_PROJECT = 10;

export async function createEnvironment(
  projectId: string,
  name: string,
): Promise<Environment> {
  await requireCapability("manage_environments");
  await requireOwnedProject(projectId);
  await assertContainerNotMigrating("project", projectId);
  const clean = cleanName(name);
  const slug = await uniqueEnvSlug(projectId, clean);
  const existing = await getDb()
    .select({ position: environmentsTable.position })
    .from(environmentsTable)
    .where(eq(environmentsTable.projectId, projectId));
  if (existing.length >= MAX_ENVIRONMENTS_PER_PROJECT)
    throw new Error(
      `A project can have at most ${MAX_ENVIRONMENTS_PER_PROJECT} environments.`,
    );
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

export async function deleteEnvironment(id: string): Promise<void> {
  const { teamId } = await requireCapability("manage_environments");
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
  const others = siblings.filter((e) => e.id !== id);
  const fallback = others.find((e) => e.isDefault) ?? others[0];
  const moved = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(eq(appsTable.environmentId, id));
  const movedDbs = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(eq(databasesTable.environmentId, id));
  await getDb().transaction(async (tx) => {
    await tx
      .update(appsTable)
      .set({ environmentId: fallback.id, updatedAt: nowIso() })
      .where(eq(appsTable.environmentId, id));
    await tx
      .update(databasesTable)
      .set({ environmentId: fallback.id })
      .where(eq(databasesTable.environmentId, id));
    await tx.delete(environmentsTable).where(eq(environmentsTable.id, id));
  });
  for (const clash of await nameClashesOnMove(
    moved.map((a) => a.id),
    { teamId, environmentId: fallback.id },
  ))
    await recordActivity(
      "app",
      `After the delete: ${clash}`,
      "Deplo",
      null,
      teamId,
    );
  await reapplyNetworkAfterMove(moved.map((a) => a.id));
  await reapplyDatabaseNetwork(movedDbs.map((d) => d.id));
}
