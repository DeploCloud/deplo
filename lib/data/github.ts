import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  githubApps as githubAppsTable,
  githubInstallation as githubInstallationTable,
} from "../db/schema/control-plane";
import {
  assembleGithubApp,
  assembleGithubInstallation,
  githubAppToRow,
  githubInstallationToRow,
} from "./infra-rows";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { encryptSecret } from "../crypto";
import { recordActivity } from "./activity";
import type { GithubApp, GithubInstallation } from "../types";
import type { ManifestConversion } from "../github/manifest";

/**
 * `github_apps` + `github_installation` are RELATIONAL as of cut-set (e)
 * (relational-store PLAN Step 6). Installations are scoped to a team THROUGH their
 * parent app (`github_installation` has no `team_id`), so team-filtered queries
 * join through `github_apps.team_id`.
 */

/** Client-safe view of a connected App and its installations (no secrets). */
export interface GithubInstallationDTO {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  avatarUrl: string;
}

export interface GithubAppDTO {
  id: string;
  appId: number;
  slug: string;
  name: string;
  htmlUrl: string;
  createdAt: string;
  installations: GithubInstallationDTO[];
}

function toInstallationDTO(i: GithubInstallation): GithubInstallationDTO {
  return {
    id: i.id,
    installationId: i.installationId,
    accountLogin: i.accountLogin,
    accountType: i.accountType,
    avatarUrl: i.avatarUrl,
  };
}

function toAppDTO(app: GithubApp, installs: GithubInstallation[]): GithubAppDTO {
  return {
    id: app.id,
    appId: app.appId,
    slug: app.slug,
    name: app.name,
    htmlUrl: app.htmlUrl,
    createdAt: app.createdAt,
    installations: installs
      .filter((i) => i.appId === app.id)
      .map(toInstallationDTO),
  };
}

export async function listGithubApps(): Promise<GithubAppDTO[]> {
  const teamId = await requireActiveTeamId();
  const db = getDb();
  const appRows = await db
    .select()
    .from(githubAppsTable)
    .where(eq(githubAppsTable.teamId, teamId));
  const apps = appRows.map(assembleGithubApp);
  if (apps.length === 0) return [];
  // One query for every installation of the team's apps (no N+1).
  const installRows = await db
    .select()
    .from(githubInstallationTable)
    .where(
      inArray(
        githubInstallationTable.appId,
        apps.map((a) => a.id),
      ),
    );
  const installs = installRows.map(assembleGithubInstallation);
  return apps.map((a) => toAppDTO(a, installs));
}

/** Installations of the active team's connected Apps (for repo source pickers). */
export async function listGithubInstallations(): Promise<GithubInstallationDTO[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({ install: githubInstallationTable })
    .from(githubInstallationTable)
    .innerJoin(
      githubAppsTable,
      eq(githubAppsTable.id, githubInstallationTable.appId),
    )
    .where(eq(githubAppsTable.teamId, teamId));
  return rows.map((r) => toInstallationDTO(assembleGithubInstallation(r.install)));
}

/** Persist a newly-created App from its manifest conversion. Secrets encrypted. */
export async function createGithubApp(
  conversion: ManifestConversion,
): Promise<GithubApp> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const app: GithubApp = {
    id: newId("gha"),
    teamId: membership.teamId,
    appId: conversion.id,
    slug: conversion.slug,
    name: conversion.name,
    clientId: conversion.client_id,
    clientSecretEnc: encryptSecret(conversion.client_secret),
    webhookSecretEnc: encryptSecret(conversion.webhook_secret ?? ""),
    privateKeyEnc: encryptSecret(conversion.pem),
    htmlUrl: conversion.html_url,
    createdAt: nowIso(),
  };
  await getDb().insert(githubAppsTable).values(githubAppToRow(app));
  await recordActivity("member", `Connected GitHub App ${app.name}`, user.name, null, membership.teamId);
  return app;
}

/** True once the active team has at least one App connected. */
export async function hasGithubApp(): Promise<boolean> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({ id: githubAppsTable.id })
    .from(githubAppsTable)
    .where(eq(githubAppsTable.teamId, teamId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Record (or refresh) an installation of a connected App. Called from the
 * post-install setup redirect. Idempotent on the numeric installation id (the
 * `github_installation.installation_id` UNIQUE backs the ON CONFLICT upsert; the
 * existing `created_at` is left untouched on conflict, per PLAN §2).
 */
export async function upsertInstallation(input: {
  appDbId: string;
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  avatarUrl: string;
}): Promise<GithubInstallation> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const db = getDb();
  // The App this installation attaches to must belong to the caller's active
  // team — otherwise a member of team B could refresh/repoint an installation
  // of team A's GitHub App (cross-tenant write).
  const app = await db
    .select({ id: githubAppsTable.id })
    .from(githubAppsTable)
    .where(
      and(
        eq(githubAppsTable.id, input.appDbId),
        eq(githubAppsTable.teamId, membership.teamId),
      ),
    )
    .limit(1);
  if (app.length === 0) throw new Error("GitHub App not found");

  const created: GithubInstallation = {
    id: newId("ghi"),
    appId: input.appDbId,
    installationId: input.installationId,
    accountLogin: input.accountLogin,
    accountType: input.accountType,
    avatarUrl: input.avatarUrl,
    createdAt: nowIso(),
  };
  const [row] = await db
    .insert(githubInstallationTable)
    .values(githubInstallationToRow(created))
    .onConflictDoUpdate({
      target: githubInstallationTable.installationId,
      // Refresh the attaching app + account fields; never touch created_at.
      set: {
        appId: input.appDbId,
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        avatarUrl: input.avatarUrl,
      },
    })
    .returning();
  await recordActivity(
    "member",
    `Installed GitHub App on ${input.accountLogin}`,
    user.name,
    null,
    membership.teamId,
  );
  return assembleGithubInstallation(row);
}

/** Most-recently-created connected App owned by the active team. */
export async function latestGithubApp(): Promise<GithubApp | null> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(githubAppsTable)
    .where(eq(githubAppsTable.teamId, teamId));
  // Most-recently-created: max createdAt, ties broken by id (deterministic).
  const apps = rows.map(assembleGithubApp).sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
  );
  return apps[apps.length - 1] ?? null;
}

export async function removeGithubApp(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const db = getDb();
  const app = await db
    .select({ id: githubAppsTable.id, name: githubAppsTable.name })
    .from(githubAppsTable)
    .where(
      and(
        eq(githubAppsTable.id, id),
        eq(githubAppsTable.teamId, membership.teamId),
      ),
    )
    .limit(1);
  if (app.length === 0) throw new Error("GitHub App not found");
  // Deleting the app cascades its installations (github_installation.app_id FK is
  // ON DELETE CASCADE) — one DELETE replaces the old two-collection JSONB filter.
  await db.delete(githubAppsTable).where(eq(githubAppsTable.id, id));
  await recordActivity("member", `Removed GitHub App ${app[0]!.name}`, user.name, null, membership.teamId);
}
