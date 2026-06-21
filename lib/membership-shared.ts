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
    description: "Read-only access to projects, deployments and settings.",
  },
  deploy: {
    label: "Deploy",
    description: "Create, redeploy, stop/start projects and dev environments.",
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

/** Effective capabilities for a role preset (used when seeding a membership). */
export function capabilitiesForRole(role: Role): Capability[] {
  return [...CAPABILITY_PRESETS[role]];
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
