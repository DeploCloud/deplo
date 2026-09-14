import type { ID } from "./identity";

export type RegistryType = "ghcr" | "dockerhub" | "gitlab" | "generic";

// REGISTRY_SECRET_LABEL - what the credential field actually holds. Only a
// self-hosted registry really takes a password; the rest issue a token.
export const REGISTRY_SECRET_LABEL: Record<RegistryType, string> = {
  ghcr: "Token",
  dockerhub: "Token",
  gitlab: "Token",
  generic: "Password or access token",
};

// Registry - a container image registry used to pull/push images for deployments.
export interface Registry {
  id: ID;
  teamId: ID;
  name: string;
  type: RegistryType;
  // registry host, e.g. ghcr.io, docker.io, registry.gitlab.com
  registryUrl: string;
  username: string;
  // encrypted at rest (password or access token)
  passwordEnc: string;
  createdAt: string;
}

// InstalledPlugin - a plugin a team installed from a plugin repository (ADR-0005).
export interface InstalledPlugin {
  id: ID;
  teamId: ID;
  // The catalog plugin id, e.g. "relay".
  catalogId: string;
  // Frozen physical identity (container/project/stack-file/router), computed at
  // install from `pluginSlug(catalogId, teamSlug)`; never re-derived after.
  slug: string;
  // The installed manifest version, e.g. "1.0.0".
  version: string;
  createdAt: string;
}
