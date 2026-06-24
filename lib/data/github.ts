import "server-only";

import { read, mutate } from "../store";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { encryptSecret } from "../crypto";
import { recordActivity } from "./activity";
import type { GithubApp, GithubInstallation } from "../types";
import type { ManifestConversion } from "../github/manifest";

/** Ids of GitHub apps owned by the active team (for installation scoping). */
function teamAppIds(teamId: string): Set<string> {
  return new Set(
    (read().githubApps ?? [])
      .filter((a) => a.teamId === teamId)
      .map((a) => a.id),
  );
}

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
  const d = read();
  return (d.githubApps ?? [])
    .filter((a) => a.teamId === teamId)
    .map((a) => toAppDTO(a, d.githubInstallations ?? []));
}

/** Installations of the active team's connected Apps (for repo source pickers). */
export async function listGithubInstallations(): Promise<GithubInstallationDTO[]> {
  const teamId = await requireActiveTeamId();
  const appIds = teamAppIds(teamId);
  return (read().githubInstallations ?? [])
    .filter((i) => appIds.has(i.appId))
    .map(toInstallationDTO);
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
  mutate((d) => {
    (d.githubApps ??= []).push(app);
  });
  await recordActivity("member", `Connected GitHub App ${app.name}`, user.name, null, membership.teamId);
  return app;
}

/** True once the active team has at least one App connected. */
export async function hasGithubApp(): Promise<boolean> {
  const teamId = await requireActiveTeamId();
  return (read().githubApps ?? []).some((a) => a.teamId === teamId);
}

/**
 * Record (or refresh) an installation of a connected App. Called from the
 * post-install setup redirect. Idempotent on the numeric installation id.
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
  // The App this installation attaches to must belong to the caller's active
  // team — otherwise a member of team B could refresh/repoint an installation
  // of team A's GitHub App (cross-tenant write).
  const app = (read().githubApps ?? []).find(
    (a) => a.id === input.appDbId && a.teamId === membership.teamId,
  );
  if (!app) throw new Error("GitHub App not found");
  let result: GithubInstallation | null = null;
  mutate((d) => {
    d.githubInstallations ??= [];
    const existing = d.githubInstallations.find(
      (i) => i.installationId === input.installationId,
    );
    if (existing) {
      existing.appId = input.appDbId;
      existing.accountLogin = input.accountLogin;
      existing.accountType = input.accountType;
      existing.avatarUrl = input.avatarUrl;
      result = existing;
      return;
    }
    const created: GithubInstallation = {
      id: newId("ghi"),
      appId: input.appDbId,
      installationId: input.installationId,
      accountLogin: input.accountLogin,
      accountType: input.accountType,
      avatarUrl: input.avatarUrl,
      createdAt: nowIso(),
    };
    d.githubInstallations.push(created);
    result = created;
  });
  await recordActivity(
    "member",
    `Installed GitHub App on ${input.accountLogin}`,
    user.name,
    null,
    membership.teamId,
  );
  return result!;
}

/** Most-recently-created connected App owned by the active team. */
export async function latestGithubApp(): Promise<GithubApp | null> {
  const teamId = await requireActiveTeamId();
  const apps = (read().githubApps ?? []).filter((a) => a.teamId === teamId);
  return apps[apps.length - 1] ?? null;
}

export async function removeGithubApp(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const app = (read().githubApps ?? []).find(
    (a) => a.id === id && a.teamId === membership.teamId,
  );
  if (!app) throw new Error("GitHub App not found");
  mutate((d) => {
    d.githubApps = (d.githubApps ?? []).filter((a) => a.id !== id);
    d.githubInstallations = (d.githubInstallations ?? []).filter(
      (i) => i.appId !== id,
    );
  });
  await recordActivity("member", `Removed GitHub App ${app.name}`, user.name, null, membership.teamId);
}
