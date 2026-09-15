import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { readAppAccess } from "../github/app";
import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  githubApps as githubAppsTable,
  githubInstallation as githubInstallationTable,
} from "../db/schema/control-plane/integrations";
import {
  assembleGithubApp,
  assembleGithubInstallation,
  githubAppToRow,
  githubInstallationToRow,
} from "./infra-rows";
import { getCurrentUser } from "../auth/current-user";
import { newId, nowIso } from "../ids";
import {
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../membership";
import { encryptSecret } from "../crypto";
import { recordActivity } from "./activity";
import type { GithubApp, GithubInstallation } from "../types/git";
import type { ManifestConversion } from "../github/manifest";
import type { AccessRequirement } from "../git/provider-access";

export interface GithubInstallationDTO {
  id: string;
  installationId: number;
  appName: string;
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

function toInstallationDTO(
  i: GithubInstallation,
  appName: string,
): GithubInstallationDTO {
  return {
    id: i.id,
    installationId: i.installationId,
    appName,
    accountLogin: i.accountLogin,
    accountType: i.accountType,
    avatarUrl: i.avatarUrl,
  };
}

function toAppDTO(
  app: GithubApp,
  installs: GithubInstallation[],
): GithubAppDTO {
  return {
    id: app.id,
    appId: app.appId,
    slug: app.slug,
    name: app.name,
    htmlUrl: app.htmlUrl,
    createdAt: app.createdAt,
    installations: installs
      .filter((i) => i.appId === app.id)
      .map((i) => toInstallationDTO(i, app.name)),
  };
}

export async function listGithubApps(): Promise<GithubAppDTO[]> {
  await requireTeamWide("Git connections");
  const teamId = await requireActiveTeamId();
  const db = getDb();
  const appRows = await db
    .select()
    .from(githubAppsTable)
    .where(eq(githubAppsTable.teamId, teamId));
  const apps = appRows.map(assembleGithubApp);
  if (apps.length === 0) return [];
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

export async function listGithubInstallations(): Promise<
  GithubInstallationDTO[]
> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({ install: githubInstallationTable, appName: githubAppsTable.name })
    .from(githubInstallationTable)
    .innerJoin(
      githubAppsTable,
      eq(githubAppsTable.id, githubInstallationTable.appId),
    )
    .where(eq(githubAppsTable.teamId, teamId));
  return rows.map((r) =>
    toInstallationDTO(assembleGithubInstallation(r.install), r.appName),
  );
}

export async function createGithubApp(
  conversion: ManifestConversion,
): Promise<GithubApp> {
  const { membership } = await requireCapability("manage_git");
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
  await recordActivity(
    "integration",
    `Connected GitHub App ${app.name}`,
    user.name,
    null,
    membership.teamId,
  );
  return app;
}

export interface GithubAppAccessDTO {
  missing: AccessRequirement[];
  settingsUrl: string;
}

export async function githubAppsAccess(
  opts: { previews?: boolean } = {},
): Promise<Record<string, GithubAppAccessDTO>> {
  const apps = await listGithubApps();
  const out: Record<string, GithubAppAccessDTO> = {};
  await Promise.all(
    apps.map(async (a) => {
      const access = await readAppAccess(a.id);
      if (!access) return;
      out[a.id] = {
        missing: [
          ...access.missingCore,
          ...(opts.previews ? access.missingPreviews : []),
        ],
        settingsUrl: access.settingsUrl,
      };
    }),
  );
  return out;
}

export async function installationAccess(
  installationId: string,
  opts: { previews?: boolean } = {},
): Promise<GithubAppAccessDTO | null> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({ appId: githubInstallationTable.appId })
    .from(githubInstallationTable)
    .innerJoin(
      githubAppsTable,
      eq(githubAppsTable.id, githubInstallationTable.appId),
    )
    .where(
      and(
        eq(githubInstallationTable.id, installationId),
        eq(githubAppsTable.teamId, teamId),
      ),
    )
    .limit(1);
  const appDbId = rows[0]?.appId;
  if (!appDbId) return null;
  const access = await readAppAccess(appDbId);
  if (!access) return null;
  return {
    missing: [
      ...access.missingCore,
      ...(opts.previews ? access.missingPreviews : []),
    ],
    settingsUrl: access.settingsUrl,
  };
}

export async function teamUsesPreviews(): Promise<boolean> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(
      and(eq(appsTable.teamId, teamId), eq(appsTable.previewEnabled, true)),
    )
    .limit(1);
  return rows.length > 0;
}

export async function upsertInstallation(input: {
  appDbId: string;
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  avatarUrl: string;
}): Promise<GithubInstallation> {
  const { membership } = await requireCapability("manage_git");
  const user = (await getCurrentUser())!;
  const db = getDb();
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
      set: {
        appId: input.appDbId,
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        avatarUrl: input.avatarUrl,
      },
    })
    .returning();
  await recordActivity(
    "integration",
    `Installed GitHub App on ${input.accountLogin}`,
    user.name,
    null,
    membership.teamId,
  );
  return assembleGithubInstallation(row);
}

export async function removeGithubApp(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_git");
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
  await db.delete(githubAppsTable).where(eq(githubAppsTable.id, id));
  await recordActivity(
    "integration",
    `Removed GitHub App ${app[0]!.name}`,
    user.name,
    null,
    membership.teamId,
  );
}
