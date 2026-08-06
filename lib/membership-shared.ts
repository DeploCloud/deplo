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

/**
 * Intersect `caps` with `bound`, in canonical {@link ALL_CAPABILITIES} order and
 * de-duplicated. The one way a capability set is ever narrowed by another: a
 * folder grant clamped to the grantee's live team caps, and an API token's own
 * set clamped to what its creator can still do. Pure.
 *
 * Lives here rather than beside either caller because both need it and
 * `lib/membership.ts` cannot import `lib/data/folder-access.ts` (which imports
 * `lib/membership.ts`).
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
 * The capabilities that can mean anything INSIDE a single Project.
 *
 * An API token limited to a set of Projects is intersected with this on top of
 * its own set, so the twenty-two team-wide ones fall away with no extra gate:
 * there is no per-project version of "manage members", "manage roles",
 * "manage the team's registries" or "delete the team", and `databases` carries
 * no `project_id` at all, so no database capability can be scoped either.
 *
 * `move_apps` is deliberately absent even though it is app-shaped: its own
 * description is "move an app into a folder, project or another team", which is
 * a token editing its own boundary. Dropping it closes moveAppToFolder,
 * moveAppToProject, moveAppToEnvironment and transferAppToTeam at once.
 *
 * Folder capabilities are absent for a simpler reason: a Folder never lives
 * inside a Project, so a project-scoped token has no folder story.
 */
export const PROJECT_SCOPED_CAPABILITIES: Capability[] = [
  "view",
  "create_apps",
  "deploy_apps",
  "control_apps",
  "configure_apps",
  "delete_apps",
  "open_app_console",
  "manage_domains",
  "manage_basic_auth",
  "manage_env",
  "reveal_secrets",
  "read_app_files",
  "write_app_files",
  "manage_backups",
  "restore_backups",
  "view_logs",
  "view_metrics",
  "view_activity",
];

/**
 * The capabilities that may be handed out ON A SINGLE NODE — an App, a Folder or
 * a Project container (ADR-0016). A node grant REPLACES the team role's set
 * inside that node and may exceed it, so this list is what stops one from ever
 * becoming a route back to team administration: `manage_members`, `manage_roles`,
 * `manage_team`, `delete_team`, `manage_tokens`, `manage_registries`,
 * `manage_git`, `manage_s3`, `manage_notifications`, `manage_environments`, the
 * folder/project CRUD verbs and every database capability are all absent, so a
 * grant can never satisfy the last-admin check, mint a credential, or re-share.
 *
 * It is {@link PROJECT_SCOPED_CAPABILITIES} plus three, and the difference is
 * deliberate rather than an oversight:
 *  - `move_apps` — dropped for a TOKEN because moving an app is a token editing
 *    its own boundary. A person is not their own boundary, and `folders.ts`
 *    already gates the move per folder for humans.
 *  - `organize_folders` / `delete_folders` — a folder-shaped verb has no meaning
 *    for a project-scoped token (a folder never lives in a project), but it is
 *    the whole point of handing someone one corner of the fleet.
 */
export const NODE_GRANTABLE_CAPABILITIES: Capability[] = ALL_CAPABILITIES.filter(
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
 * It is the sentence the member roster and the member page both need — "why does
 * this person differ from everyone else with the same role" — and it is one
 * function so the tile, the header chip and the live preview while an admin
 * edits can never disagree.
 *
 * Narrower wins over wider when both are true: someone who lost `delete_apps`
 * and gained a folder is more usefully flagged by what was taken away.
 *
 * ponytail: compares TICKED node ids, not their subtrees — ticking a folder
 * inside a project the role names reads as narrower (which it is) rather than as
 * both. Compare expanded reach if that ever needs to be exact.
 */
export function accessDelta(input: {
  /** The member's effective capability set. */
  capabilities: Capability[];
  /** The role's effective set — what they would hold by following it. */
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
    // A node their role doesn't name — an admin ticked it here, or somebody
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
