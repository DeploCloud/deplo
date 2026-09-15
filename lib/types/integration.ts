import type { ID } from "./identity";

export type RegistryType = "ghcr" | "dockerhub" | "gitlab" | "generic";

export const REGISTRY_SECRET_LABEL: Record<RegistryType, string> = {
  ghcr: "Token",
  dockerhub: "Token",
  gitlab: "Token",
  generic: "Password or access token",
};

export interface Registry {
  id: ID;
  teamId: ID;
  name: string;
  type: RegistryType;
  registryUrl: string;
  username: string;
  passwordEnc: string;
  createdAt: string;
}

export interface InstalledPlugin {
  id: ID;
  teamId: ID;
  catalogId: string;
  slug: string;
  version: string;
  createdAt: string;
}
