// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getCurrentUser } from "../auth";
import { getDb } from "../db/client";
import {
  apps as appsTable,
  registries as registriesTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import {
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../membership";
import { recordActivity } from "./activity";
import { decryptSecretOrThrow, encryptSecret } from "../crypto";
import { REGISTRY_SECRET_LABEL, type RegistryType } from "../types";

export interface RegistryDTO {
  id: string;
  name: string;
  type: RegistryType;
  registryUrl: string;
  username: string;
  createdAt: string;
}

/** Default host per registry type; "generic" must supply its own. */
export const REGISTRY_HOSTS: Record<RegistryType, string> = {
  ghcr: "ghcr.io",
  dockerhub: "docker.io",
  gitlab: "registry.gitlab.com",
  generic: "",
};

/** What the docker CLI calls the Hub in a config.json, which is not its host. */
const DOCKER_HUB_AUTH_KEY = "https://index.docker.io/v1/";
const DOCKER_HUB_ALIASES = new Set([
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io",
]);

/** The key the docker CLI matches an image's registry against. */
export function dockerConfigKey(registryUrl: string): string {
  const host = registryUrl
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return DOCKER_HUB_ALIASES.has(host.toLowerCase())
    ? DOCKER_HUB_AUTH_KEY
    : host;
}

/** One decrypted credential on its way to the agent (never a DTO, never a query). */
export interface RegistryAuthEntry {
  host: string;
  username: string;
  password: string;
}

/**
 * The team's registry credentials, decrypted for the deploy edge. NOT filtered by
 * the images this deploy names: a Dockerfile's `FROM` is invisible here, so a
 * host-match would silently fail exactly the case people hit first.
 */
export async function loadRegistryAuthsForApp(
  appId: string,
): Promise<RegistryAuthEntry[]> {
  const db = getDb();
  const app = (
    await db
      .select({ teamId: appsTable.teamId })
      .from(appsTable)
      .where(eq(appsTable.id, appId))
      .limit(1)
  )[0];
  if (!app) return [];

  const rows = await db
    .select({
      name: registriesTable.name,
      registryUrl: registriesTable.registryUrl,
      username: registriesTable.username,
      passwordEnc: registriesTable.passwordEnc,
    })
    .from(registriesTable)
    .where(eq(registriesTable.teamId, app.teamId));

  return rows.map((r) => ({
    host: dockerConfigKey(r.registryUrl),
    username: r.username,
    // STRICT at the deploy edge, like every other secret: "" would deploy an app
    // that then fails its pull with an unauthorized nobody can explain.
    password: decryptSecretOrThrow(
      r.passwordEnc,
      `The credential for registry ${r.name}`,
    ),
  }));
}

/** The non-secret projection, never selects `password_enc`. */
const DTO_COLUMNS = {
  id: registriesTable.id,
  name: registriesTable.name,
  type: registriesTable.type,
  registryUrl: registriesTable.registryUrl,
  username: registriesTable.username,
  createdAt: registriesTable.createdAt,
} as const;

export async function listRegistries(): Promise<RegistryDTO[]> {
  await requireTeamWide("container registries");
  const teamId = await requireActiveTeamId();
  // Newest-first sort pushed into SQL (matches registries_team_created_idx).
  return getDb()
    .select(DTO_COLUMNS)
    .from(registriesTable)
    .where(eq(registriesTable.teamId, teamId))
    .orderBy(desc(registriesTable.createdAt)) as Promise<RegistryDTO[]>;
}

export async function addRegistry(input: {
  name: string;
  type: RegistryType;
  registryUrl?: string;
  username: string;
  password: string;
}): Promise<void> {
  const { membership } = await requireCapability("manage_registries");
  // The actor's display name for the activity log lives in the JSONB users
  // collection (cut-set b, still authoritative this step).
  const user = (await getCurrentUser())!;
  const name = input.name.trim();
  if (!name) throw new Error("Enter a name");
  const registryUrl = (
    input.registryUrl?.trim() || REGISTRY_HOSTS[input.type]
  ).trim();
  if (!registryUrl) throw new Error("Enter the registry host");
  if (!input.username.trim()) throw new Error("Enter a username");
  if (!input.password) {
    // Matches the form's own label, which is type-aware: "Token" for a provider
    // that issues one, "Password or access token" only for a generic registry.
    throw new Error(
      `Enter the ${REGISTRY_SECRET_LABEL[input.type].toLowerCase()}`,
    );
  }

  await getDb()
    .insert(registriesTable)
    .values({
      id: newId("reg"),
      teamId: membership.teamId,
      name,
      type: input.type,
      registryUrl,
      username: input.username.trim(),
      passwordEnc: encryptSecret(input.password),
      createdAt: nowIso(),
    });
  await recordActivity(
    "integration",
    `Added registry ${name}`,
    user.name,
    null,
    membership.teamId,
  );
}

export async function deleteRegistry(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_registries");
  const user = (await getCurrentUser())!;
  const rows = await getDb()
    .select({ name: registriesTable.name })
    .from(registriesTable)
    .where(
      and(
        eq(registriesTable.id, id),
        eq(registriesTable.teamId, membership.teamId),
      ),
    )
    .limit(1);
  const r = rows[0];
  if (!r) throw new Error("Registry not found");
  await getDb()
    .delete(registriesTable)
    .where(
      and(
        eq(registriesTable.id, id),
        eq(registriesTable.teamId, membership.teamId),
      ),
    );
  await recordActivity(
    "integration",
    `Removed registry ${r.name}`,
    user.name,
    null,
    membership.teamId,
  );
}
