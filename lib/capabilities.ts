import type { Capability } from "./types";
import { ALL_CAPABILITIES } from "./types";

/**
 * The capability catalog — one entry per thing a member can be allowed to do,
 * plus the categories the role editor browses them by.
 *
 * Deliberately FINE-GRAINED. A permission here names a single action ("delete
 * apps", "create databases", "restore a backup"), never a bundle: role design is
 * an advanced surface, and an admin who wants a role that deploys but cannot
 * delete, or reads files but cannot write them, must be able to say exactly that.
 * The categories below are for FINDING a permission (with the search box), not for
 * granting one — there is no category-level grant.
 *
 * No server-only or request-context imports: the role editor is a client
 * component and reads this catalog directly. The authorization helpers live in
 * `lib/membership.ts`.
 */

/** How a permission is shown in the role editor. */
export interface CapabilityMeta {
  label: string;
  /** One line, in the terms the dashboard uses. */
  description: string;
  /** Extra weight in search: words a user might type that aren't in the label. */
  keywords?: string;
  /** Handing this out can cost data or hand over access — flagged in the UI. */
  sensitive?: boolean;
}

export const CAPABILITY_META: Record<Capability, CapabilityMeta> = {
  view: {
    label: "View the team",
    description:
      "Read-only access to apps, databases, deployments and settings.",
    keywords: "read access dashboard",
  },

  /* ---- Apps ---- */
  create_apps: {
    label: "Create apps",
    description: "Add a new app from a repository, image, template or upload.",
    keywords: "new app add deploy source template",
  },
  deploy_apps: {
    label: "Deploy apps",
    description: "Deploy, redeploy and cancel a running deploy.",
    keywords: "redeploy build release ship",
  },
  rollback_apps: {
    label: "Roll back apps",
    description: "Put an app back on a previous deployment, with no rebuild.",
    keywords: "rollback revert previous version undo restore",
  },
  control_apps: {
    label: "Start & stop apps",
    description: "Start, stop, restart and reload a running app.",
    keywords: "restart reload power lifecycle",
  },
  configure_apps: {
    label: "Configure apps",
    description:
      "Change an app's name, logo, deploy source, build settings, volumes, resource limits and auto-deploy.",
    keywords: "settings build rename resources volumes limits auto deploy",
  },
  delete_apps: {
    label: "Delete apps",
    description: "Permanently delete apps and their deployment history.",
    keywords: "remove destroy",
    sensitive: true,
  },
  move_apps: {
    label: "Move & reorder apps",
    description: "Move an app into a folder, project or another team.",
    keywords: "organize transfer drag",
  },
  open_app_console: {
    label: "Open an app's console",
    description:
      "Run a shell inside a running app's container and attach to its process.",
    keywords: "terminal shell exec attach ssh",
    sensitive: true,
  },
  manage_previews: {
    label: "Manage pull request previews",
    description:
      "Turn pull request previews on, change their settings, and deploy, redeploy or destroy one.",
    keywords: "preview pull request pr branch ephemeral fork approve",
  },
  manage_crons: {
    label: "Manage cron jobs",
    description:
      "Create, edit and run scheduled commands inside an app or database container.",
    keywords: "cron schedule scheduled task job timer recurring command",
    // Same class as the console: a cron job is an arbitrary command inside the
    // container, as the container's user, with no sandbox. That it runs on a
    // timer rather than at a keystroke makes it more dangerous, not less.
    sensitive: true,
  },

  /* ---- App configuration ---- */
  manage_domains: {
    label: "Manage domains",
    description:
      "Add, verify, route and remove custom domains, and pick their certificates.",
    keywords: "dns url https tls certificate routing",
  },
  manage_basic_auth: {
    label: "Manage HTTP basic auth",
    description: "Put an app behind a username and password at the edge.",
    keywords: "password protect access login gate",
  },
  manage_env: {
    label: "Manage environment variables",
    description:
      "Add, edit, import and delete an app's variables and the team's shared ones.",
    keywords: "env vars secrets configuration shared",
  },
  reveal_secrets: {
    label: "Reveal secret values",
    description:
      "Read back the value of a masked variable, connection string or password.",
    keywords: "show unmask decrypt password connection",
    sensitive: true,
  },
  read_app_files: {
    label: "Browse app files",
    description: "Open and download the files in an app's storage directory.",
    keywords: "download view directory storage",
  },
  write_app_files: {
    label: "Edit app files",
    description: "Create, edit, upload, rename and delete an app's files.",
    keywords: "upload write delete rename directory",
  },

  /* ---- Organization ---- */
  create_folders: {
    label: "Create folders",
    description: "Add folders to group apps on the overview.",
    keywords: "new folder group",
  },
  organize_folders: {
    label: "Organize folders",
    description: "Rename folders, nest them and share them with members.",
    keywords: "rename move nest share",
  },
  delete_folders: {
    label: "Delete folders",
    description: "Remove a folder (its apps move back out, they aren't deleted).",
    keywords: "remove",
  },
  create_projects: {
    label: "Create projects",
    description: "Add a project — a folder with environments of its own.",
    keywords: "new project container group",
  },
  organize_projects: {
    label: "Organize projects",
    description: "Rename projects and change their colour.",
    keywords: "rename colour color",
  },
  delete_projects: {
    label: "Delete projects",
    description: "Remove a project and everything scoped to its environments.",
    keywords: "remove destroy",
    sensitive: true,
  },
  manage_environments: {
    label: "Manage environments",
    description:
      "Add, rename, reorder and remove a project's environments (production, preview, …).",
    keywords: "environment branch preview production staging",
  },

  /* ---- Databases ---- */
  create_databases: {
    label: "Create databases",
    description: "Provision a new managed database on one of the servers.",
    keywords: "new postgres mysql redis mongo provision",
  },
  configure_databases: {
    label: "Configure databases",
    description:
      "Change a database's name, logo, image, exposure, resource limits and password.",
    keywords: "settings rename image resources password rotate port",
  },
  control_databases: {
    label: "Start & stop databases",
    description: "Start, stop, restart, redeploy and rebuild a database.",
    keywords: "restart redeploy rebuild lifecycle",
  },
  delete_databases: {
    label: "Delete databases",
    description: "Permanently delete a database and its data volume.",
    keywords: "remove destroy drop",
    sensitive: true,
  },
  open_database_console: {
    label: "Open a database console",
    description: "Run a database shell (psql, mysql, redis-cli) on the server.",
    keywords: "terminal shell psql mysql query exec",
    sensitive: true,
  },

  /* ---- Backups & storage ---- */
  manage_backups: {
    label: "Manage backups",
    description: "Create, edit, disable and run backup schedules on demand.",
    keywords: "schedule dump snapshot cron run",
  },
  restore_backups: {
    label: "Restore backups",
    description:
      "Restore a backup over a live app or database, replacing its current data.",
    keywords: "recover rollback import overwrite",
    sensitive: true,
  },
  delete_backups: {
    label: "Delete backups",
    description:
      "Permanently delete a single backup, removing the file it was restored from.",
    keywords: "remove artifact purge prune erase restore point",
    // The only verb here that destroys data with no way back and no warning
    // further down: the artifact is the last copy of what an app or database
    // looked like at that moment, and deleting it can silently leave a target
    // with no restore point at all.
    sensitive: true,
  },
  manage_backup_destinations: {
    label: "Manage backup destinations",
    description:
      "Connect, test and remove the places backups are stored, and download the key that decrypts them.",
    keywords: "bucket s3 server disk storage remote credentials minio garage path recovery key",
    // Sensitive, and not because connecting a bucket is dangerous: this is the
    // capability that hands over the recovery key, which decrypts EVERY artifact
    // at a destination - including backups of apps the holder has no grant on.
    // That is strictly more reach than `restore_backups`, which is marked, and
    // it was reading as a settings chore.
    sensitive: true,
  },

  /* ---- Integrations ---- */
  manage_registries: {
    label: "Manage container registries",
    description: "Connect and remove private image registries.",
    keywords: "docker ghcr image credentials pull",
  },
  manage_git: {
    label: "Manage Git connections",
    description: "Connect and disconnect the team's GitHub apps.",
    keywords: "github repository connect oauth",
  },
  manage_tokens: {
    label: "Manage API tokens",
    description:
      "Mint and revoke the bearer tokens that drive deplo's API from outside the dashboard.",
    keywords: "api access token bearer cli automation",
    sensitive: true,
  },
  manage_notifications: {
    label: "Manage notifications",
    description: "Choose which events are announced and where they are sent.",
    keywords: "alerts email webhook discord slack",
  },

  /* ---- Observability ---- */
  view_logs: {
    label: "View logs",
    description: "Read runtime and build logs for apps and databases.",
    keywords: "output stdout stderr build runtime tail",
  },
  view_metrics: {
    label: "View monitoring",
    description: "See live and historical CPU, memory, disk and network usage.",
    keywords: "monitoring cpu memory disk charts stats",
  },
  manage_monitoring: {
    label: "Change monitoring settings",
    description: "Turn metrics history on or off for servers, apps and databases.",
    keywords: "history retention save metrics settings",
  },
  view_activity: {
    label: "View the activity log",
    description: "Read the audit trail of what everyone in the team has done.",
    keywords: "audit history events trail",
  },

  /* ---- Team ---- */
  manage_members: {
    label: "Manage members",
    description: "Add and remove members, and assign each of them a role.",
    keywords: "invite people users team add remove",
  },
  manage_roles: {
    label: "Manage roles",
    description:
      "Create, edit, reset and delete the roles on this page — including what they grant.",
    keywords: "permissions roles access control",
    sensitive: true,
  },
  manage_team: {
    label: "Manage team settings",
    description: "Rename the team, change its settings and order the overview.",
    keywords: "settings rename workspace general reorder arrange sort order",
  },
  delete_team: {
    label: "Delete the team",
    description: "Permanently delete the whole team and everything in it.",
    keywords: "remove destroy",
    sensitive: true,
  },
};

/**
 * The role editor's browse order. Every optional capability appears in exactly
 * one category; `view` is the always-on floor and is in none of them.
 *
 * A category is a place to LOOK, not a thing to grant — there is no
 * category-level switch, because a permission that can only be handed out as
 * part of a bundle isn't a permission, it's a bundle.
 */
export const CAPABILITY_CATEGORIES: {
  key: string;
  label: string;
  description: string;
  caps: Capability[];
}[] = [
  {
    key: "apps",
    label: "Apps",
    description: "Creating, shipping and running the team's apps.",
    caps: [
      "create_apps",
      "deploy_apps",
      "rollback_apps",
      "control_apps",
      "configure_apps",
      "delete_apps",
      "move_apps",
      "open_app_console",
      "manage_previews",
      "manage_crons",
    ],
  },
  {
    key: "app-config",
    label: "App configuration",
    description: "What an app is reachable at, configured with and made of.",
    caps: [
      "manage_domains",
      "manage_basic_auth",
      "manage_env",
      "reveal_secrets",
      "read_app_files",
      "write_app_files",
    ],
  },
  {
    key: "organization",
    label: "Folders & projects",
    description: "How the overview is organised.",
    caps: [
      "create_folders",
      "organize_folders",
      "delete_folders",
      "create_projects",
      "organize_projects",
      "delete_projects",
      "manage_environments",
    ],
  },
  {
    key: "databases",
    label: "Databases",
    description: "Managed databases on the team's servers.",
    caps: [
      "create_databases",
      "configure_databases",
      "control_databases",
      "delete_databases",
      "open_database_console",
    ],
  },
  {
    key: "backups",
    label: "Backups & storage",
    description: "Backup schedules and where they are stored.",
    caps: [
      "manage_backups",
      "restore_backups",
      "delete_backups",
      "manage_backup_destinations",
    ],
  },
  {
    key: "integrations",
    label: "Integrations & API",
    description: "Everything deplo talks to on the team's behalf.",
    caps: [
      "manage_registries",
      "manage_git",
      "manage_tokens",
      "manage_notifications",
    ],
  },
  {
    key: "observability",
    label: "Logs & monitoring",
    description: "Seeing what the team's workloads are doing.",
    caps: ["view_logs", "view_metrics", "manage_monitoring", "view_activity"],
  },
  {
    key: "team",
    label: "Team administration",
    description: "The team itself, its people and their access.",
    caps: ["manage_members", "manage_roles", "manage_team", "delete_team"],
  },
];

/**
 * What each capability of the ORIGINAL eight expands to. The coarse eight were
 * bundles; every one of them is now several named permissions, and this is the
 * one place that says which. Used by
 *
 *  - migration 0056, to expand the stored rows of every membership, role, folder
 *    grant and registration link without changing what anybody can do, and
 *  - {@link expandLegacyCapabilities}, so an API client (or a saved script) that
 *    still sends `deploy` keeps meaning exactly what it used to mean.
 *
 * `view` maps to the read-only permissions that used to ride along with it.
 */
export const LEGACY_CAPABILITY_EXPANSION: Record<string, Capability[]> = {
  view: ["view", "view_logs", "view_metrics", "view_activity"],
  deploy: [
    "create_apps",
    "deploy_apps",
    // Anyone the coarse `deploy` covered could already ship any commit they liked,
    // reverting one included - so going back to a build that already shipped is
    // strictly less power than they had. Withholding it here would take something
    // away from an API client that has been sending `deploy` for a year.
    "rollback_apps",
    "control_apps",
    "configure_apps",
    "delete_apps",
    "move_apps",
    "open_app_console",
    "manage_previews",
    // Under `deploy` and not `manage_infra` because that is where
    // `open_app_console` already sits, and a cron job is the same power on a
    // timer. An API client still sending the retired coarse name gets exactly
    // what it always implied.
    "manage_crons",
    "create_folders",
    "organize_folders",
    "delete_folders",
    "create_projects",
    "organize_projects",
    "delete_projects",
    "manage_environments",
  ],
  manage_domains: ["manage_domains", "manage_basic_auth"],
  manage_env: ["manage_env", "reveal_secrets"],
  manage_files: ["read_app_files", "write_app_files"],
  manage_infra: [
    "create_databases",
    "configure_databases",
    "control_databases",
    "delete_databases",
    "open_database_console",
    "manage_backups",
    "restore_backups",
    // Under `manage_infra` because `delete_databases` already is, and that is
    // the verb the backfill seeds this one from: deleting a database ALREADY
    // sweeps every artifact it has. An API client still sending the retired
    // coarse name gets exactly what it always implied.
    "delete_backups",
    "manage_backup_destinations",
    "manage_registries",
    "manage_git",
    "manage_tokens",
    "manage_notifications",
    "manage_monitoring",
  ],
  manage_members: ["manage_members", "manage_roles"],
  manage_team: ["manage_team", "delete_team"],
  // `manage_s3` was renamed to `manage_backup_destinations` when a destination
  // stopped necessarily being S3 (migration 0083). Same single power, so this is
  // a 1:1 alias rather than an expansion — it keeps an API token minted before
  // the rename working, exactly like the coarse names above.
  manage_s3: ["manage_backup_destinations"],
};

/** Every retired spelling that still expands as input: the eight the split
 *  started from, plus `manage_s3` (renamed, not split). */
export const LEGACY_CAPABILITY_NAMES = Object.keys(LEGACY_CAPABILITY_EXPANSION);

/** The ones that no longer exist as capabilities in their own right: the three
 *  the split retired, plus `manage_s3`, which was renamed rather than split when
 *  a destination stopped necessarily being a bucket. */
export const RETIRED_CAPABILITY_NAMES = LEGACY_CAPABILITY_NAMES.filter(
  (n) => !(ALL_CAPABILITIES as string[]).includes(n),
);

/**
 * Normalise a capability list that may still use one of the RETIRED names
 * (`deploy`, `manage_files`, `manage_infra`), dropping anything unrecognised.
 *
 * A name that is still a capability today means EXACTLY itself — `manage_env` is
 * `manage_env`, not `manage_env` + `reveal_secrets`, and `view` is the floor and
 * nothing more. Only names with no current meaning are expanded, which is what
 * keeps this safe on the hot path: the role editor sends `view` with every save,
 * and a helper that quietly inflated it would grant permissions nobody ticked.
 *
 * (The MIGRATION's mapping is the richer {@link LEGACY_CAPABILITY_EXPANSION} —
 * there the question is "what did this stored row already imply", so `view` does
 * carry the read-only permissions it used to include. Different question,
 * deliberately different answer.)
 */
export function expandLegacyCapabilities(caps: string[]): Capability[] {
  const out = new Set<Capability>();
  for (const c of caps) {
    if ((ALL_CAPABILITIES as string[]).includes(c)) {
      out.add(c as Capability);
      continue;
    }
    for (const e of LEGACY_CAPABILITY_EXPANSION[c] ?? []) out.add(e);
  }
  return ALL_CAPABILITIES.filter((c) => out.has(c));
}

/** Lower-cased haystack for the role editor's search box. */
export function capabilitySearchText(cap: Capability): string {
  const meta = CAPABILITY_META[cap];
  return `${cap} ${meta.label} ${meta.description} ${meta.keywords ?? ""}`
    .toLowerCase()
    .replace(/_/g, " ");
}

/** Capabilities matching a free-text query, in catalog order (empty ⇒ all). */
export function searchCapabilities(query: string): Capability[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...ALL_CAPABILITIES];
  return ALL_CAPABILITIES.filter((c) => {
    const text = capabilitySearchText(c);
    return terms.every((t) => text.includes(t));
  });
}
