import type { Capability, Role } from "./types";
import { ALL_CAPABILITIES } from "./types";

/**
 * Pure capability/role helpers with no server-only or request-context deps, so
 * they are safe to import from the store hydration path (migrations) and from
 * client components (the capability picker UI) alike. The request-aware
 * authorization helpers live in `lib/membership.ts`.
 */

/** Capability sets the three named roles grant by default. */
export const CAPABILITY_PRESETS: Record<Role, Capability[]> = {
  owner: [...ALL_CAPABILITIES],
  member: ["view", "deploy", "manage_domains", "manage_env", "manage_files"],
  viewer: ["view"],
};

/** Human labels + descriptions for the capability picker UI. */
export const CAPABILITY_META: Record<
  Capability,
  { label: string; description: string }
> = {
  view: {
    label: "View",
    description: "Read-only access to apps, deployments and settings.",
  },
  deploy: {
    label: "Deploy",
    description: "Create, redeploy, stop/start apps and dev environments.",
  },
  manage_domains: {
    label: "Manage domains",
    description: "Add, verify, route and remove custom domains.",
  },
  manage_env: {
    label: "Manage env vars",
    description: "Edit project and shared environment variables.",
  },
  manage_files: {
    label: "Manage files",
    description: "Browse, edit, upload and delete a project's files.",
  },
  manage_infra: {
    label: "Manage infrastructure",
    description: "Databases, S3, registries, backups and GitHub apps.",
  },
  manage_members: {
    label: "Manage members",
    description: "Invite, create and remove members; change their roles.",
  },
  manage_team: {
    label: "Manage team",
    description: "Rename the team, edit team settings, delete the team.",
  },
};

/**
 * The SIMPLE tier of the role editor: every optional capability grouped into the
 * three areas a team actually reasons about. Flipping a group grants or revokes
 * all of its capabilities at once — the "one switch, many permissions" view — and
 * the advanced tier then ticks the individual rows underneath. Both tiers write
 * the same capability set; there is no second permission model behind this.
 *
 * `view` is deliberately absent: it is the always-on floor, never a toggle.
 */
export const CAPABILITY_GROUPS: {
  key: "apps" | "infrastructure" | "team";
  label: string;
  description: string;
  caps: Capability[];
}[] = [
  {
    key: "apps",
    label: "Apps & configuration",
    description:
      "Deploy apps and manage their domains, variables and files.",
    caps: ["deploy", "manage_domains", "manage_env", "manage_files"],
  },
  {
    key: "infrastructure",
    label: "Infrastructure",
    description: "Databases, S3 destinations, backups, registries and Git.",
    caps: ["manage_infra"],
  },
  {
    key: "team",
    label: "Team administration",
    description: "Members, roles and the team's own settings.",
    caps: ["manage_members", "manage_team"],
  },
];

/**
 * Name + description each built-in role is born with (and reverts to). Kept
 * beside {@link CAPABILITY_PRESETS} so "reset to default" restores the whole row,
 * not only its capabilities.
 */
export const ROLE_DEFAULTS: Record<
  Role,
  { name: string; description: string }
> = {
  owner: {
    name: "Owner",
    description: "Full control of the team and everything in it.",
  },
  member: {
    name: "Member",
    description: "Deploy and manage apps, domains, variables and files.",
  },
  viewer: {
    name: "Viewer",
    description: "Read-only access across the whole team.",
  },
};

/** The three built-in roles, in the order they are shown. */
export const BUILTIN_ROLE_KEYS: Role[] = ["owner", "member", "viewer"];

/** True if two capability sets grant exactly the same thing (order-blind). */
export function sameCapabilities(a: Capability[], b: Capability[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((c) => right.has(c));
}

/** Effective capabilities for a role preset (used when seeding a membership). */
export function capabilitiesForRole(role: Role): Capability[] {
  return [...CAPABILITY_PRESETS[role]];
}

/**
 * Sanitize an arbitrary capability list to known values, always implying `view`.
 * An empty/absent list falls back to the role's preset. Shared by the
 * add-member, invite and registration-link flows so every membership is seeded
 * with a coherent, validated capability set.
 */
export function cleanCapabilities(
  caps: Capability[] | undefined,
  role: Role,
): Capability[] {
  const base = caps?.length ? caps : capabilitiesForRole(role);
  const set = new Set(base.filter((c) => ALL_CAPABILITIES.includes(c)));
  set.add("view");
  return ALL_CAPABILITIES.filter((c) => set.has(c));
}

/** The role whose preset exactly matches a capability set, else "custom". */
export function roleLabelForCapabilities(caps: Capability[]): Role | "custom" {
  const set = new Set(caps);
  for (const role of ["owner", "member", "viewer"] as Role[]) {
    const preset = CAPABILITY_PRESETS[role];
    if (preset.length === set.size && preset.every((c) => set.has(c))) {
      return role;
    }
  }
  return "custom";
}
