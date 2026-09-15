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

export const BUILTIN_ROLE_KEYS: Role[] = ["owner", "member", "viewer"];

export function boundedBy(
  caps: Capability[],
  bound: Capability[],
): Capability[] {
  const allowed = new Set(bound);
  const wanted = new Set(caps);
  return ALL_CAPABILITIES.filter((c) => wanted.has(c) && allowed.has(c));
}

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

export const NODE_GRANTABLE_CAPABILITIES: Capability[] =
  ALL_CAPABILITIES.filter(
    (c) =>
      PROJECT_SCOPED_CAPABILITIES.includes(c) ||
      c === "move_apps" ||
      c === "organize_folders" ||
      c === "delete_folders",
  );

// ponytail: compares TICKED node ids, not their subtrees. Compare expanded reach
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

export function sameCapabilities(a: Capability[], b: Capability[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((c) => right.has(c));
}

export function capabilitiesForRole(role: Role): Capability[] {
  return [...CAPABILITY_PRESETS[role]];
}

export function cleanCapabilities(
  caps: Capability[] | undefined,
  role: Role,
): Capability[] {
  const base = caps?.length ? caps : capabilitiesForRole(role);
  const set = new Set(expandLegacyCapabilities(base as string[]));
  set.add("view");
  return ALL_CAPABILITIES.filter((c) => set.has(c));
}

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
