import type { ID, VarAuthor } from "./identity";

export type EnvTarget = "production" | "preview";

// ALL_ENV_TARGETS - canonical ordered list. (`development` died with dev mode -
// migration 0041 stripped its junction rows.)
export const ALL_ENV_TARGETS: EnvTarget[] = ["production", "preview"];

// sanitizeTargets - keep only valid targets, deduped and in canonical order;
// fall back to every target if none survive.
export function sanitizeTargets(targets: EnvTarget[]): EnvTarget[] {
  const kept = ALL_ENV_TARGETS.filter((t) => targets.includes(t));
  return kept.length ? kept : [...ALL_ENV_TARGETS];
}

// secretImmutable - the refusal every env layer raises when a write would touch a
// SECRET row. Immutability is what closes it: create it, delete it, never edit it.
// Promotion `plain` -> `secret` stays open, because hardening is never gated.
export const secretImmutable = (key: string) =>
  `${key} is a secret and cannot be edited. Delete it and add it again.`;

export interface EnvVar {
  id: ID;
  appId: ID;
  key: string;
  // encrypted at rest
  valueEnc: string;
  targets: EnvTarget[];
  type: "plain" | "secret";
  createdByUserId: ID | null;
  updatedByUserId: ID | null;
  createdAt: string;
  updatedAt: string;
}

// EnvVarDTO - sent to the client: secret values are masked.
export interface EnvVarDTO {
  id: ID;
  key: string;
  value: string; // masked for secrets unless explicitly revealed
  masked: boolean;
  targets: EnvTarget[];
  type: "plain" | "secret";
  createdBy: VarAuthor | null;
  updatedBy: VarAuthor | null;
  createdAt: string;
  updatedAt: string;
}

// SharedVar - a unified shared variable (ADR-0010, multi-team per ADR-0027):
// ONE variable, replacing the shared-env group and the env/team/instance models.
export interface SharedVar {
  id: ID;
  // The OWNER. `null` = instance-owned, editable only by an instance admin.
  teamId: ID | null;
  key: string;
  // encrypted at rest
  valueEnc: string;
  type: "plain" | "secret";
  // Every team the variable reaches (ADR-0027). One team ⇒ it only suggests.
  teamIds: ID[];
  // Reaches >1 team (or is instance-owned): injects with no link, lowest slot.
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
