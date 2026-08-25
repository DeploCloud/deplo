import type { Capability, Role } from "./types";
import { ALL_CAPABILITIES } from "./types";
import {
  LEGACY_CAPABILITY_EXPANSION,
  expandLegacyCapabilities,
} from "./capabilities";

/**
 * Pure capability/role helpers with no server-only or request-context deps, so
 * they are safe to import from the store hydration path (migrations) and from
 * client components (the role editor) alike.
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
 */
export const CAPABILITY_PRESETS: Record<Role, Capability[]> = {
  owner: [...ALL_CAPABILITIES],
  member: presetOf(
    "view",
    "deploy",
    "manage_domains",
    "manage_env",
    "manage_files",
  ),
  viewer: presetOf("view"),
};

/**
 * Build a preset from the coarse names it used to be, through the MIGRATION's
 * mapping, so a team that never touched its Member or Viewer role comes out of
 * the split matching its preset exactly, and reads as unmodified.
 */
function presetOf(...legacy: string[]): Capability[] {
  const set = new Set(
    legacy.flatMap((n) => LEGACY_CAPABILITY_EXPANSION[n] ?? []),
  );
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

/**
 * Intersect `caps` with `bound`, in canonical {@link ALL_CAPABILITIES} order and
 * de-duplicated.
 */
export function boundedBy(
  caps: Capability[],
  bound: Capability[],
): Capability[] {
  const allowed = new Set(bound);
  const wanted = new Set(caps);
  return ALL_CAPABILITIES.filter((c) => wanted.has(c) && allowed.has(c));
}

/**
 * The capabilities that can mean anything INSIDE a single Project. Folder
 * capabilities are absent for a simpler reason: a Folder never lives inside a
 * Project, so a project-scoped token has no folder story.
 */
export const PROJECT_SCOPED_CAPABILITIES: Capability[] = [
  "view",
  "create_apps",
  "deploy_apps",
  // A rollback targets ONE app's own deployment history, so it means something
  // inside a Project exactly as much as deploying does.
  "rollback_apps",
  "control_apps",
  "configure_apps",
  "delete_apps",
  "open_app_console",
  // A cron job hangs off ONE app, so it is meaningful inside a Project - and it sits
  // next to `open_app_console` for the same reason it does everywhere else: both are
  // "run a command in this container", one at a keystroke and one on a timer.
  "manage_crons",
  "manage_domains",
  "manage_basic_auth",
  "manage_env",
  "reveal_secrets",
  "read_app_files",
  "write_app_files",
  "manage_backups",
  "restore_backups",
  // A backup belongs to ONE app, so deleting one means something inside a
  // Project - and a per-app grant is exactly how "you look after this app, its
  // backups included" is expressed.
  "delete_backups",
  "view_logs",
  "view_metrics",
  "view_activity",
];

/**
 * The capabilities that may be handed out ON A SINGLE NODE - an App, a Folder or a
 * Project container (ADR-0016).
 */
export const NODE_GRANTABLE_CAPABILITIES: Capability[] =
  ALL_CAPABILITIES.filter(
    (c) =>
      PROJECT_SCOPED_CAPABILITIES.includes(c) ||
      c === "move_apps" ||
      c === "organize_folders" ||
      c === "delete_folders",
  );

/**
 * How one member's access compares with the role they hold: `null` when they are
 * exactly their role, which is almost everybody.
 *
 * It is the sentence the member roster and the member page both need - "why does
 * this person differ from everyone else with the same role", and it is one
 * function so the tile, the header chip and the live preview while an admin
 * edits can never disagree.
 *
 * Narrower wins over wider when both are true: someone who lost `delete_apps`
 * and gained a folder is more usefully flagged by what was taken away.
 *
 * ponytail: compares TICKED node ids, not their subtrees - ticking a folder
 * inside a project the role names reads as narrower (which it is) rather than as
 * both. Compare expanded reach if that ever needs to be exact.
 */
export function accessDelta(input: {
  /** The member's effective capability set. */
  capabilities: Capability[];
  /** The role's effective set - what they would hold by following it. */
  roleCapabilities: Capability[];
  /** Their reach is the nodes they name, not the role's. */
  granular: boolean;
  /** Every node they hold: their reach when `granular`, their shares otherwise. */
  nodeIds: string[];
  /** The nodes the role names, or null when it reaches the whole team. */
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
    // A node their role doesn't name - an admin ticked it here, or somebody
    // shared it with them. An unrestricted role names everything, so nothing can
    // be beyond it.
    (roleNodes !== null && input.nodeIds.some((id) => !roleNodes.includes(id)));
  return wider ? "more" : null;
}

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
