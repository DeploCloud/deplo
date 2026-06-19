import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret } from "../crypto";
import type { Registry, RegistryType } from "../types";

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

function registries(): Registry[] {
  return read().registries ?? [];
}

function toDTO(r: Registry): RegistryDTO {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    registryUrl: r.registryUrl,
    username: r.username,
    createdAt: r.createdAt,
  };
}

export async function listRegistries(): Promise<RegistryDTO[]> {
  const teamId = await requireActiveTeamId();
  return registries()
    .filter((r) => r.teamId === teamId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(toDTO);
}

export async function addRegistry(input: {
  name: string;
  type: RegistryType;
  registryUrl?: string;
  username: string;
  password: string;
}): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const name = input.name.trim();
  if (!name) throw new Error("Enter a name");
  const registryUrl = (input.registryUrl?.trim() || REGISTRY_HOSTS[input.type]).trim();
  if (!registryUrl) throw new Error("Enter the registry host");
  if (!input.username.trim()) throw new Error("Enter a username");
  if (!input.password) throw new Error("Enter a password or access token");

  const registry: Registry = {
    id: newId("reg"),
    teamId: membership.teamId,
    name,
    type: input.type,
    registryUrl,
    username: input.username.trim(),
    passwordEnc: encryptSecret(input.password),
    createdAt: nowIso(),
  };
  mutate((d) => {
    d.registries ??= [];
    d.registries.push(registry);
  });
  recordActivity("member", `Added registry ${name}`, user.name, null, membership.teamId);
}

export async function deleteRegistry(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const user = read().users.find((u) => u.id === membership.userId)!;
  const r = registries().find((x) => x.id === id && x.teamId === membership.teamId);
  if (!r) throw new Error("Registry not found");
  mutate((d) => {
    d.registries = (d.registries ?? []).filter((x) => x.id !== id);
  });
  recordActivity("member", `Removed registry ${r.name}`, user.name, null, membership.teamId);
}
