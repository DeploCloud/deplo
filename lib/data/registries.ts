import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getCurrentUser } from "../auth/current-user";
import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { registries as registriesTable } from "../db/schema/control-plane/integrations";
import { newId, nowIso } from "../ids";
import {
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../membership";
import { recordActivity } from "./activity";
import { decryptSecretOrThrow, encryptSecret } from "../crypto";
import { checkRegistryCredential } from "../registry/client";
import { REGISTRY_SECRET_LABEL, type RegistryType } from "../types/integration";

export interface RegistryDTO {
  id: string;
  name: string;
  type: RegistryType;
  registryUrl: string;
  username: string;
  createdAt: string;
}

export const REGISTRY_HOSTS: Record<RegistryType, string> = {
  ghcr: "ghcr.io",
  dockerhub: "docker.io",
  gitlab: "registry.gitlab.com",
  generic: "",
};

const DOCKER_HUB_AUTH_KEY = "https://index.docker.io/v1/";
const DOCKER_HUB_ALIASES = new Set([
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io",
]);

export function dockerConfigKey(registryUrl: string): string {
  const host = registryUrl
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return DOCKER_HUB_ALIASES.has(host.toLowerCase())
    ? DOCKER_HUB_AUTH_KEY
    : host;
}

export interface RegistryAuthEntry {
  host: string;
  username: string;
  password: string;
}

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
    password: decryptSecretOrThrow(
      r.passwordEnc,
      `The credential for registry ${r.name}`,
    ),
  }));
}

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
  const user = (await getCurrentUser())!;
  const name = input.name.trim();
  if (!name) throw new Error("Enter a name");
  const registryUrl = (
    input.registryUrl?.trim() || REGISTRY_HOSTS[input.type]
  ).trim();
  if (!registryUrl) throw new Error("Enter the registry host");
  if (!input.username.trim()) throw new Error("Enter a username");
  if (!input.password) {
    throw new Error(
      `Enter the ${REGISTRY_SECRET_LABEL[input.type].toLowerCase()}`,
    );
  }

  const check = await checkRegistryCredential(
    registryUrl,
    input.username.trim(),
    input.password,
  );
  if (check === "rejected") {
    throw new Error(
      `${registryUrl} rejected this username and ${REGISTRY_SECRET_LABEL[
        input.type
      ].toLowerCase()}`,
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
