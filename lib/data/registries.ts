import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getCurrentUser } from "../auth";
import { getDb } from "../db/client";
import { registries as registriesTable } from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret } from "../crypto";
import type { RegistryType } from "../types";

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

/** The non-secret projection — never selects `password_enc`. */
const DTO_COLUMNS = {
  id: registriesTable.id,
  name: registriesTable.name,
  type: registriesTable.type,
  registryUrl: registriesTable.registryUrl,
  username: registriesTable.username,
  createdAt: registriesTable.createdAt,
} as const;

export async function listRegistries(): Promise<RegistryDTO[]> {
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
  const { membership } = await requireCapability("manage_infra");
  // The actor's display name for the activity log lives in the JSONB users
  // collection (cut-set b — still authoritative this step).
  const user = (await getCurrentUser())!;
  const name = input.name.trim();
  if (!name) throw new Error("Enter a name");
  const registryUrl = (input.registryUrl?.trim() || REGISTRY_HOSTS[input.type]).trim();
  if (!registryUrl) throw new Error("Enter the registry host");
  if (!input.username.trim()) throw new Error("Enter a username");
  if (!input.password) throw new Error("Enter a password or access token");

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
  await recordActivity("member", `Added registry ${name}`, user.name, null, membership.teamId);
}

export async function deleteRegistry(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const rows = await getDb()
    .select({ name: registriesTable.name })
    .from(registriesTable)
    .where(and(eq(registriesTable.id, id), eq(registriesTable.teamId, membership.teamId)))
    .limit(1);
  const r = rows[0];
  if (!r) throw new Error("Registry not found");
  await getDb()
    .delete(registriesTable)
    .where(and(eq(registriesTable.id, id), eq(registriesTable.teamId, membership.teamId)));
  await recordActivity("member", `Removed registry ${r.name}`, user.name, null, membership.teamId);
}
