import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import { encryptSecret } from "../crypto";
import { recordActivity } from "./activity";
import type { GithubApp, GithubInstallation } from "../types";
import type { ManifestConversion } from "../github/manifest";

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
  await assertUser();
  const d = read();
  return (d.githubApps ?? []).map((a) =>
    toAppDTO(a, d.githubInstallations ?? []),
  );
}

/** All installations across all connected Apps (for repo source pickers). */
export async function listGithubInstallations(): Promise<GithubInstallationDTO[]> {
  await assertUser();
  return (read().githubInstallations ?? []).map(toInstallationDTO);
}

/** Persist a newly-created App from its manifest conversion. Secrets encrypted. */
export async function createGithubApp(
  conversion: ManifestConversion,
): Promise<GithubApp> {
  const user = await assertUser();
  const app: GithubApp = {
    id: newId("gha"),
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
  recordActivity("member", `Connected GitHub App ${app.name}`, user.name, null);
  return app;
}

/** True once at least one App is connected; used to gate the GitHub source. */
export async function hasGithubApp(): Promise<boolean> {
  await assertUser();
  return (read().githubApps ?? []).length > 0;
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
  const user = await assertUser();
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
  recordActivity(
    "member",
    `Installed GitHub App on ${input.accountLogin}`,
    user.name,
    null,
  );
  return result!;
}

/** Most-recently-created connected App (the one a fresh install just made). */
export async function latestGithubApp(): Promise<GithubApp | null> {
  await assertUser();
  const apps = read().githubApps ?? [];
  return apps[apps.length - 1] ?? null;
}

export async function removeGithubApp(id: string): Promise<void> {
  const user = await assertUser();
  const app = (read().githubApps ?? []).find((a) => a.id === id);
  if (!app) throw new Error("GitHub App not found");
  mutate((d) => {
    d.githubApps = (d.githubApps ?? []).filter((a) => a.id !== id);
    d.githubInstallations = (d.githubInstallations ?? []).filter(
      (i) => i.appId !== id,
    );
  });
  recordActivity("member", `Removed GitHub App ${app.name}`, user.name, null);
}
