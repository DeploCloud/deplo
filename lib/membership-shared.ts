import type { Capability, Role } from "./types";
import { ALL_CAPABILITIES } from "./types";
import {
  LEGACY_CAPABILITY_EXPANSION,
  expandLegacyCapabilities,
} from "./capabilities";

/**
 * Pure capability/role helpers with no server-only or request-context deps, so
 * they are safe to import from the store hydration path (migrations) and from
 * client components (the role editor) alike. The request-aware authorization
 * helpers live in `lib/membership.ts`; the capability catalog (labels,
 * descriptions, categories, search) lives in `lib/capabilities.ts`.
 */

export {
  CAPABILITY_META,
  CAPABILITY_CATEGORIES,
  LEGACY_CAPABILITY_EXPANSION,
  LEGACY_CAPABILITY_NAMES,
  RETIRED_CAPABILITY_NAMES,
  expandLegacyCapabilities,
  searchCapabilities,
  capabilitySearchText,
  type CapabilityMeta,
} from "./capabilities";

/**
 * Capability sets the three built-in roles are born with.
 *
 * Member and Viewer are written as the expansion of what they granted when
 * capabilities were coarse, so the split changed nobody's access: Member is
 * exactly the old `deploy` + `manage_domains` + `manage_env` + `manage_files`,
 * spelled out. An admin who wants a tighter Member edits it — that is the point
 * of the roles page.
 */
export const CAPABILITY_PRESETS: Record<Role, Capability[]> = {
  owner: [...ALL_CAPABILITIES],
  member: presetOf("view", "deploy", "manage_domains", "manage_env", "manage_files"),
  viewer: presetOf("view"),
};

/**
 * Build a preset from the coarse names it used to be, through the MIGRATION's
 * mapping — so a team that never touched its Member or Viewer role comes out of
 * the split matching its preset exactly, and reads as unmodified.
 *
 * Deliberately not {@link expandLegacyCapabilities}, which answers the other
 * question ("what does this name mean as INPUT today", where `view` is just the
 * floor). Here the question is "what did this role already grant".
 */
function presetOf(...legacy: string[]): Capability[] {
  const set = new Set(legacy.flatMap((n) => LEGACY_CAPABILITY_EXPANSION[n] ?? []));
  set.add("view");
  return ALL_CAPABILITIES.filter((c) => set.has(c));
}

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
 *
 * A list still using one of the original eight coarse names (an API client, a
 * saved script) is expanded to the permissions that name used to imply, so it
 * keeps meaning exactly what it meant before the split.
 */
export function cleanCapabilities(
  caps: Capability[] | undefined,
  role: Role,
): Capability[] {
  const base = caps?.length ? caps : capabilitiesForRole(role);
  // Current names pass through as themselves; only a retired one expands.
  const set = new Set(expandLegacyCapabilities(base as string[]));
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
