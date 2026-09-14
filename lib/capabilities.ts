// https://deplo.build/docs/reference/capabilities

import type { Capability } from "./types/identity";
import { ALL_CAPABILITIES } from "./types/identity";

// CapabilityMeta - how a permission is shown in the role editor.
export interface CapabilityMeta {
  label: string;
  description: string;
  keywords?: string;
  sensitive?: boolean;
}

export const CAPABILITY_META: Record<Capability, CapabilityMeta> = {
  view: {
    label: "View the team",
    description:
      "Read-only access to apps, databases, deployments and settings.",
    keywords: "read access dashboard",
  },

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
      "Change an app's name, logo, deploy source, build settings, volumes and the config files they mount, resource limits and auto-deploy.",
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
    // Same class as the console: an arbitrary command inside the container, as its user, with no sandbox.
    sensitive: true,
  },

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
    description:
      "Remove a folder (its apps move back out, they aren't deleted).",
    keywords: "remove",
  },
  create_projects: {
    label: "Create projects",
    description: "Add a project - a folder with environments of its own.",
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
    description: "Start, stop, restart and redeploy a database.",
    keywords: "restart redeploy lifecycle",
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
    // The only verb here that destroys data with no way back: the artifact can be a target's last restore point.
    sensitive: true,
  },
  manage_backup_destinations: {
    label: "Manage backup destinations",
    description:
      "Connect, test and remove the places backups are stored, and download the key that decrypts them.",
    keywords:
      "bucket s3 server disk storage remote credentials minio garage path recovery key",
    // It hands over the recovery key, which decrypts EVERY artifact at a destination, grant or no grant.
    sensitive: true,
  },

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
    label: "Use API tokens",
    // Tokens are personal: this is the team's say over whether a member's tokens reach it at all.
    description:
      "Let their own API tokens act in this team, from scripts, CI and other clients.",
    keywords: "api access token bearer cli automation",
    sensitive: true,
  },
  manage_mcp: {
    label: "Connect AI agents",
    description:
      "Let their own AI agents drive this team over MCP. Turning MCP off for the whole team is a team setting.",
    keywords: "mcp ai agent assistant llm claude cursor copilot chatgpt gemini",
    sensitive: true,
  },
  manage_notifications: {
    label: "Manage notifications",
    description: "Choose which events are announced and where they are sent.",
    keywords: "alerts email webhook discord slack",
  },

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
    description:
      "Turn metrics history on or off for servers, apps and databases.",
    keywords: "history retention save metrics settings",
  },
  view_activity: {
    label: "View the activity log",
    description: "Read the audit trail of what everyone in the team has done.",
    keywords: "audit history events trail",
  },

  manage_members: {
    label: "Manage members",
    description: "Add and remove members, and assign each of them a role.",
    keywords: "invite people users team add remove",
  },
  manage_roles: {
    label: "Manage roles",
    description:
      "Create, edit, reset and delete the roles on this page - including what they grant.",
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

// CAPABILITY_CATEGORIES - the role editor's browse order; a category is a place to LOOK, not a thing to grant.
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
    description: "Everything Deplo talks to on the team's behalf.",
    caps: [
      "manage_registries",
      "manage_git",
      "manage_tokens",
      "manage_mcp",
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

// LEGACY_CAPABILITY_EXPANSION - what each capability of the ORIGINAL eight expands to.
export const LEGACY_CAPABILITY_EXPANSION: Record<string, Capability[]> = {
  view: ["view", "view_logs", "view_metrics", "view_activity"],
  deploy: [
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
  manage_infra: [
    "create_databases",
    "configure_databases",
    "control_databases",
    "delete_databases",
    "open_database_console",
    "manage_backups",
    "restore_backups",
    "delete_backups",
    "manage_backup_destinations",
    "manage_registries",
    "manage_git",
    "manage_tokens",
    "manage_mcp",
    "manage_notifications",
    "manage_monitoring",
  ],
  manage_members: ["manage_members", "manage_roles"],
  manage_team: ["manage_team", "delete_team"],
  // `manage_s3` was renamed to `manage_backup_destinations` (migration 0083).
  manage_s3: ["manage_backup_destinations"],
};

// LEGACY_CAPABILITY_NAMES - every retired spelling that still expands as input.
export const LEGACY_CAPABILITY_NAMES = Object.keys(LEGACY_CAPABILITY_EXPANSION);

// RETIRED_CAPABILITY_NAMES - the names that no longer exist as capabilities in their own right.
export const RETIRED_CAPABILITY_NAMES = LEGACY_CAPABILITY_NAMES.filter(
  (n) => !(ALL_CAPABILITIES as string[]).includes(n),
);

// expandLegacyCapabilities - normalise a list that may still use a RETIRED name, dropping anything unrecognised.
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

// capabilitySearchText - the lower-cased haystack for the role editor's search box.
export function capabilitySearchText(cap: Capability): string {
  const meta = CAPABILITY_META[cap];
  return `${cap} ${meta.label} ${meta.description} ${meta.keywords ?? ""}`
    .toLowerCase()
    .replace(/_/g, " ");
}

// searchCapabilities - the capabilities matching a free-text query, in catalog order.
export function searchCapabilities(query: string): Capability[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...ALL_CAPABILITIES];
  return ALL_CAPABILITIES.filter((c) => {
    const text = capabilitySearchText(c);
    return terms.every((t) => text.includes(t));
  });
}
