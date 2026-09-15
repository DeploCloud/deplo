import type { ID, VarAuthor } from "./identity";

export type EnvTarget = "production" | "preview";

export const ALL_ENV_TARGETS: EnvTarget[] = ["production", "preview"];

export function sanitizeTargets(targets: EnvTarget[]): EnvTarget[] {
  const kept = ALL_ENV_TARGETS.filter((t) => targets.includes(t));
  return kept.length ? kept : [...ALL_ENV_TARGETS];
}

export const secretImmutable = (key: string) =>
  `${key} is a secret and cannot be edited. Delete it and add it again.`;

export interface EnvVar {
  id: ID;
  appId: ID;
  key: string;
  valueEnc: string;
  targets: EnvTarget[];
  type: "plain" | "secret";
  createdByUserId: ID | null;
  updatedByUserId: ID | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvVarDTO {
  id: ID;
  key: string;
  value: string;
  masked: boolean;
  targets: EnvTarget[];
  type: "plain" | "secret";
  createdBy: VarAuthor | null;
  updatedBy: VarAuthor | null;
  createdAt: string;
  updatedAt: string;
}

export interface SharedVar {
  id: ID;
  teamId: ID | null;
  key: string;
  valueEnc: string;
  type: "plain" | "secret";
  teamIds: ID[];
  autoInject: boolean;
  environmentIds: ID[];
  projectIds: ID[];
  appIds: ID[];
  targets: EnvTarget[];
  createdByUserId: ID | null;
  updatedByUserId: ID | null;
  createdAt: string;
  updatedAt: string;
}
