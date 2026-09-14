import type { Capability, Role } from "./types/identity";
import { ALL_CAPABILITIES } from "./types/identity";
import {
  LEGACY_CAPABILITY_EXPANSION,
  expandLegacyCapabilities,
} from "./capabilities";

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

// CAPABILITY_PRESETS - the capability sets the three built-in roles are born with.
export const CAPABILITY_PRESETS: Record<Role, Capability[]> = {
  owner: [...ALL_CAPABILITIES],
  member: presetOf("view", "deploy", "manage_domains", "manage_env"),
  viewer: presetOf("view"),
};

// Built from the coarse names through the MIGRATION's own mapping, so an untouched role still reads as unmodified.
function presetOf(...legacy: string[]): Capability[] {
  const set = new Set(
    legacy.flatMap((n) => LEGACY_CAPABILITY_EXPANSION[n] ?? []),
  );
  set.add("view");
  return ALL_CAPABILITIES.filter((c) => set.has(c));
}

// ROLE_DEFAULTS - the name and description each built-in role is born with, and reverts to.
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

// BUILTIN_ROLE_KEYS - the three built-in roles, in the order they are shown.
export const BUILTIN_ROLE_KEYS: Role[] = ["owner", "member", "viewer"];

// boundedBy - intersect `caps` with `bound`, in canonical `ALL_CAPABILITIES` order and de-duplicated.
export function boundedBy(
  caps: Capability[],
  bound: Capability[],
): Capability[] {
  const allowed = new Set(bound);
  const wanted = new Set(caps);
  return ALL_CAPABILITIES.filter((c) => wanted.has(c) && allowed.has(c));
}

// PROJECT_SCOPED_CAPABILITIES - the capabilities that can mean anything INSIDE a single Project.
export const PROJECT_SCOPED_CAPABILITIES: Capability[] = [
  "view",
  "create_apps",
  "deploy_apps",
  "rollback_apps",
  "control_apps",
  "configure_apps",
  "delete_apps",
  "open_app_console",
  "manage_crons",
  "manage_domains",
  "manage_basic_auth",
  "manage_env",
  "reveal_secrets",
  "manage_backups",
  "restore_backups",
  "delete_backups",
  "view_logs",
  "view_metrics",
  "view_activity",
];

// NODE_GRANTABLE_CAPABILITIES - what may be handed out ON A SINGLE NODE: an App, a Folder or a Project (ADR-0016).
export const NODE_GRANTABLE_CAPABILITIES: Capability[] =
  ALL_CAPABILITIES.filter(
    (c) =>
      PROJECT_SCOPED_CAPABILITIES.includes(c) ||
      c === "move_apps" ||
      c === "organize_folders" ||
      c === "delete_folders",
  );

// accessDelta - how a member's access compares with the role they hold, `null` when they are exactly it.
// ponytail: compares TICKED node ids, not their subtrees. Compare expanded reach
// if that ever needs to be exact.
export function accessDelta(input: {
  capabilities: Capability[];
  roleCapabilities: Capability[];
  granular: boolean;
  nodeIds: string[];
  roleNodeIds: string[] | null;
}): "less" | "more" | null {
  const caps = new Set(input.capabilities);
  const roleCaps = new Set(input.roleCapabilities);
  const nodes = new Set(input.nodeIds);
  const narrower =
    [...roleCaps].some((c) => !caps.has(c)) ||
    (input.granular &&
      (input.roleNodeIds === null ||
        input.roleNodeIds.some((id) => !nodes.has(id))));
  if (narrower) return "less";
  const roleNodes = input.roleNodeIds;
  const wider =
    [...caps].some((c) => !roleCaps.has(c)) ||
    (roleNodes !== null && input.nodeIds.some((id) => !roleNodes.includes(id)));
  return wider ? "more" : null;
}

// sameCapabilities - true if two capability sets grant exactly the same thing, order-blind.
export function sameCapabilities(a: Capability[], b: Capability[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((c) => right.has(c));
}

// capabilitiesForRole - the effective capabilities for a role preset.
export function capabilitiesForRole(role: Role): Capability[] {
  return [...CAPABILITY_PRESETS[role]];
}

// cleanCapabilities - sanitize an arbitrary capability list to known values, always implying `view`.
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

// roleLabelForCapabilities - the role whose preset exactly matches a capability set, else "custom".
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
