import {
  GitPullRequest,
  Timer,
  LayoutGrid,
  LayoutDashboard,
  Rocket,
  ScrollText,
  Database,
  LayoutTemplate,
  Server,
  Settings,
  Activity,
  LineChart,
  Braces,
  Users,
  ArrowLeft,
  Building2,
  User,
  Package,
  GitBranch,
  Globe,
  SquareTerminal,
  FolderTree,
  Archive,
  Bell,
  KeyRound,
  Settings2,
  Network,
  HardDrive,
  ShieldCheck,
  Fingerprint,
  SlidersHorizontal,
  Cpu,
  Bot,
  Cable,
} from "lucide-react";
import type { ComponentType } from "react";

import { DeploMark } from "@/components/logo";
import type { DatabaseType } from "@/lib/types";

export interface NavItem {
  label: string;
  href: string;
  /** Any glyph that takes a className - lucide's icons and Deplo's own mark. */
  icon: ComponentType<{ className?: string }>;
  tooltip: string;
  /** exact match for active state (default: startsWith) */
  exact?: boolean;
  /**
   * A picture that stands in for {@link icon}: the app's or database's own logo on
   * its Overview entry, so the sub-menu opens with the thing you are inside rather
   * than a generic dashboard glyph.
   */
  mark?:
    | { kind: "app"; logo: string | null }
    | { kind: "database"; logo: string | null; type: DatabaseType };
  /**
   * A "back" escape hatch (top of a sub-menu). The sidebar routes a plain click
   * through the browser's back so you return to wherever you came from; `href`
   * is the fallback used when there's no in-app page to go back to.
   */
  back?: boolean;
  /**
   * Per-team capability required to SEE this item. Absent ⇒ always visible.
   * The sidebar filters items the current member lacks (the destination page
   * also guards server-side). Matches the Capability strings in lib/types.ts.
   */
  requires?: string;
  /**
   * Visible when the member holds ANY ONE of these.
   */
  requiresAny?: string[];
  /** Visible only to instance admins (orthogonal to team capabilities). */
  requiresAdmin?: boolean;
  /**
   * Render the entry but do NOT link it, with this sentence as its tooltip.
   * Distinct from `requires`, which is about the VIEWER's permission and hides: a
   * permission can be granted, this cannot.
   */
  disabledReason?: string;
}

/**
 * May this viewer see the item at all? The one rule, shared by the sidebar and
 * the command palette so the two can never disagree about what is reachable.
 */
export function canSee(
  item: Pick<NavItem, "requires" | "requiresAny" | "requiresAdmin">,
  caps: ReadonlySet<string>,
  isAdmin: boolean,
): boolean {
  return (
    (!item.requires || caps.has(item.requires)) &&
    (!item.requiresAny || item.requiresAny.some((c) => caps.has(c))) &&
    (!item.requiresAdmin || isAdmin)
  );
}

export interface NavSection {
  title?: string;
  items: NavItem[];
  /**
   * Render this section's entries as plain text, no icons.
   */
  iconless?: boolean;
}

export const NAV: NavSection[] = [
  {
    items: [
      {
        label: "Overview",
        href: "/",
        icon: LayoutGrid,
        tooltip: "Projects, folders & apps overview",
        exact: true,
      },
      {
        label: "Deployments",
        href: "/deployments",
        icon: Rocket,
        tooltip: "All deployments across apps",
      },
      {
        label: "Logs",
        href: "/logs",
        icon: ScrollText,
        tooltip: "Runtime and build logs",
        requires: "view_logs",
      },
    ],
  },
  {
    title: "Infrastructure",
    items: [
      {
        label: "Storage",
        href: "/storage",
        icon: Database,
        tooltip: "Databases, backup destinations & backups",
      },
      {
        label: "Variables",
        href: "/variables",
        icon: Braces,
        tooltip: "App, shared & global environment variables",
        requires: "manage_env",
      },
      {
        label: "Templates",
        href: "/templates",
        icon: LayoutTemplate,
        tooltip: "One-click deploy templates",
        // No capability: the catalogue is a catalogue, and anyone on the team
        // may read it. Deploying is the gated action - the Deploy button on a
        // template's page needs `create_apps`, and `createApp` enforces it.
      },
      // Plugins deliberately have NO nav entry: the feature is deferred and its
      // UI/API are withdrawn (ADR-0013). The `/plugins/<slug>` path stays
      // reserved for a plugin's own routes, so nothing here may claim it.
    ],
  },
  {
    title: "Workspace",
    items: [
      // Members lives under Settings → Team, beside the Roles page that defines
      // what a member can do - one decision, one place.
      {
        label: "Activity",
        href: "/activity",
        icon: Activity,
        tooltip: "Audit log of workspace events",
        requires: "view_activity",
      },
      {
        label: "Monitoring",
        href: "/monitoring",
        icon: LineChart,
        tooltip: "Real-time server metrics",
        requires: "view_metrics",
      },
      // Settings is NOT here: it sits in the sidebar's own footer, under
      // Documentation, because it is a way OUT of the workspace rather than a
      // place in it.
    ],
  },
];

/** The gear icons, so the nav can give them the turn-on-hover class the rest of
 *  the product's gears wear. Identity, not a name: these ARE the components. */
const GEARS: readonly unknown[] = [Settings, Settings2];

export function isGearIcon(icon: unknown): boolean {
  return GEARS.includes(icon);
}

/** Which of the four navigations the sidebar shows, and the ids it needs to
 *  build it. One derivation, read by the nav AND by the sidebar's footer - which
 *  hides itself in every drill-in, where the way back is the nav's own first row. */
export function sidebarMenuFor(pathname: string): {
  appSlug: string | null;
  dbId: string | null;
  inAppSettings: boolean;
  inDbSettings: boolean;
  inSettings: boolean;
  menu: "main" | "service" | "service-settings" | "settings";
} {
  const appSlug = pathname.match(/^\/apps\/([^/]+)/)?.[1] ?? null;
  const dbId = pathname.match(/^\/storage\/databases\/([^/]+)/)?.[1] ?? null;
  const inAppSettings =
    appSlug != null && /^\/apps\/[^/]+\/settings(?:\/|$)/.test(pathname);
  const inDbSettings =
    dbId != null &&
    /^\/storage\/databases\/[^/]+\/settings(?:\/|$)/.test(pathname);
  const inSettings = pathname.startsWith("/settings");
  return {
    appSlug,
    dbId,
    inAppSettings,
    inDbSettings,
    inSettings,
    menu:
      appSlug || dbId
        ? inAppSettings || inDbSettings
          ? "service-settings"
          : "service"
        : inSettings
          ? "settings"
          : "main",
  };
}

/**
 * Settings navigation. The first item is a "back to dashboard" escape hatch.
 */
export const SETTINGS_NAV: NavSection[] = [
  {
    items: [
      {
        label: "Back to dashboard",
        href: "/",
        icon: ArrowLeft,
        tooltip: "Return to the dashboard",
        exact: true,
        back: true,
      },
    ],
  },
  // Team - settings scoped to the active team (the team header stays shown here).
  {
    title: "Team",
    items: [
      {
        label: "General",
        href: "/settings",
        icon: Building2,
        tooltip: "Team details & appearance",
        exact: true,
      },
      {
        label: "Members",
        href: "/settings/members",
        icon: Users,
        tooltip: "People in this team",
      },
      {
        label: "Roles",
        href: "/settings/roles",
        icon: ShieldCheck,
        tooltip: "What a member can do in this team",
      },
      {
        label: "Notifications",
        href: "/settings/notifications",
        icon: Bell,
        tooltip: "Alerts & delivery channels",
        // Without it the page is a dead end: every switch, every Test button and
        // Save are refused server-side (same reasoning as Registries below).
        requires: "manage_notifications",
      },
      {
        label: "Registries",
        href: "/settings/registries",
        icon: Package,
        tooltip: "Container image registries",
        requires: "manage_registries",
      },
      {
        label: "Git",
        href: "/settings/git",
        icon: GitBranch,
        tooltip: "Connected git providers",
      },
      {
        label: "MCP Server",
        href: "/settings/mcp",
        icon: Bot,
        tooltip: "Let AI agents drive this team over MCP",
        // TWO capabilities open a real half of this page, so naming one hid it from people
        // with work to do there.
        requiresAny: ["manage_mcp", "manage_tokens"],
      },
      {
        label: "Migrations",
        href: "/settings/migrations",
        icon: Cable,
        tooltip: "Bring projects over from Dokploy or Coolify",
        // The smallest capability that can produce what an import produces.
        requires: "create_projects",
      },
    ],
  },
  // Account - the signed-in user's own settings (no team context).
  {
    title: "Account",
    items: [
      {
        label: "Account",
        href: "/settings/account",
        icon: User,
        tooltip: "Your personal account",
      },
      {
        label: "Security",
        href: "/settings/security",
        icon: Fingerprint,
        tooltip: "Two-factor authentication",
      },
      {
        label: "API tokens",
        href: "/settings/tokens",
        icon: KeyRound,
        tooltip: "Bearer tokens, and what each one may do",
      },
    ],
  },
  // System - instance-wide administration (admins) + posture.
  {
    title: "System",
    items: [
      // First, and wearing the mark: this is the instance the other two live in,
      // and `SlidersHorizontal` is the Advanced glyph everywhere else.
      {
        label: "Deplo",
        href: "/settings/deplo",
        icon: DeploMark,
        tooltip: "This instance: its address, certificates and version",
        // Instance admins, like its neighbours: everything on it is one setting
        // for the whole instance, and applying it touches every host.
        requiresAdmin: true,
      },
      {
        label: "Servers",
        href: "/settings/servers",
        icon: Server,
        tooltip: "Connected servers & Docker hosts",
        // Server administration is an instance-wide concern (the management view lists
        // EVERY server across teams), so it is gated to instance admins, not the per-team
        // manage_infra capability.
        requiresAdmin: true,
      },
      {
        label: "Users",
        href: "/settings/users",
        icon: Users,
        tooltip: "Instance-wide user administration",
        requiresAdmin: true,
      },
    ],
  },
];

/**
 * Per-app facts the sidebar can't derive itself (the URL gives the slug and the
 * viewer's capabilities gate Environment/Backups, but whether the container is
 * running and whether the app has a files dir are known only to the app layout,
 * which publishes them via the app-nav store).
 */
export interface AppNavFlags {
  /** Full current pathname - lets a section stay listed while it's the open page
   *  even before the store has confirmed its flag (avoids a missing active item
   *  on a hard load of e.g. /apps/x/console). */
  pathname: string;
  canManageEnv: boolean;
  canBackup: boolean;
  running: boolean;
  showFiles: boolean;
  /**
   * The app deploys from GitHub.
   */
  isGithubApp: boolean;
  /** Pull request previews are switched on for this app. */
  previewsEnabled: boolean;
  /** Cron jobs are switched on for this app. */
  cronsEnabled: boolean;
  /**
   * The app's own logo, for the Overview entry's mark.
   */
  logo?: string | null;
  /** The container console is switched on for this app (Advanced settings). */
  consoleEnabled: boolean;
}

/**
 * An app's navigation.
 */
export function appNav(slug: string, f: AppNavFlags): NavSection[] {
  const base = `/apps/${slug}`;
  // True while the given sub-route is the page currently open.
  const on = (seg: string) =>
    f.pathname === base + seg || f.pathname.startsWith(base + seg + "/");

  const items: NavItem[] = [
    {
      label: "Overview",
      href: base,
      icon: LayoutDashboard,
      // The app's own logo when the layout has published it: inside an app, the
      // first entry should look like that app.
      ...(f.logo !== undefined
        ? { mark: { kind: "app" as const, logo: f.logo } }
        : {}),
      tooltip: "App overview",
      // Every app route starts with `base`, so Overview must match exactly
      // or it would light up on every sub-page.
      exact: true,
    },
    {
      label: "Deployments",
      href: `${base}/deployments`,
      icon: Rocket,
      tooltip: "Deployment history",
    },
    // Pull request previews - the OPERATIONAL page, offered only once the feature is
    // actually on. Never for a non-GitHub app at all: a docker image, an upload, a
    // compose paste or a raw git URL never receives a `pull_request` delivery.
    ...((f.isGithubApp && f.previewsEnabled) || on("/pull-requests")
      ? [
          {
            label: "Pull requests",
            href: `${base}/pull-requests`,
            icon: GitPullRequest,
            tooltip: "Preview deploys for open pull requests",
            // The page's own read is `manage_previews`-gated and would throw for
            // anyone else, so an ungated entry would be a link to an error.
            requires: "manage_previews",
          } as NavItem,
        ]
      : []),
    // Cron jobs - the OPERATIONAL page, offered only once the feature is on, exactly
    // like Pull requests above and for the same reason: with the switch off there is
    // nothing to list, and the setting that turns it back on lives under Settings where
    // you would look for it.
    ...(f.cronsEnabled || on("/cron-jobs")
      ? [
          {
            label: "Cron jobs",
            href: `${base}/cron-jobs`,
            icon: Timer,
            tooltip: "Scheduled commands and their run history",
            // The page's own read is `manage_crons`-gated and would throw for
            // anyone else, so an ungated entry would be a link to an error.
            requires: "manage_crons",
          } as NavItem,
        ]
      : []),
    {
      label: "Domains",
      href: `${base}/domains`,
      icon: Globe,
      tooltip: "Custom domains & routing",
    },
    // Environment holds sensitive values - only for manage_env holders.
    ...(f.canManageEnv
      ? [
          {
            label: "Environment",
            href: `${base}/environment`,
            icon: Braces,
            tooltip: "Environment variables",
          } as NavItem,
        ]
      : []),
    // Console is an ADVANCED surface - a live shell into the container, reached from
    // Advanced settings.
    ...(f.consoleEnabled && (f.running || on("/console"))
      ? [
          {
            label: "Console",
            href: `${base}/console`,
            icon: SquareTerminal,
            tooltip: "Container console",
            requires: "open_app_console",
          } as NavItem,
        ]
      : []),
    // Logs stays visible even when the app is stopped: it falls back to the
    // most recent build's logs (flagged as not live) rather than a dead end.
    {
      label: "Logs",
      href: `${base}/logs`,
      icon: ScrollText,
      tooltip: "Runtime & build logs",
      requires: "view_logs",
    },
    // Monitoring is always visible (like Logs): live per-container resource
    // usage while running, an "update the agent" / "not running" state otherwise.
    {
      label: "Monitoring",
      href: `${base}/monitoring`,
      icon: LineChart,
      tooltip: "Live resource usage",
      requires: "view_metrics",
    },
    // Files - only when an on-disk files dir exists and the viewer can manage it.
    ...(f.showFiles || on("/files")
      ? [
          {
            label: "Files",
            href: `${base}/files`,
            icon: FolderTree,
            tooltip: "App files",
          } as NavItem,
        ]
      : []),
    // Backups are infra ops - manage_infra only.
    ...(f.canBackup || on("/backups")
      ? [
          {
            label: "Backups",
            href: `${base}/backups`,
            icon: Archive,
            tooltip: "Backups & restore",
          } as NavItem,
        ]
      : []),
    {
      label: "Settings",
      href: `${base}/settings`,
      icon: Settings,
      tooltip: "App settings",
    },
  ];

  return [
    {
      items: [
        {
          label: "Back to apps",
          href: "/",
          icon: ArrowLeft,
          tooltip: "Return to all apps",
          exact: true,
          back: true,
        },
      ],
    },
    { items },
  ];
}

/**
 * An app's SETTINGS sub-menu - one level deeper than {@link appNav}.
 */
export function appSettingsNav(
  slug: string,
  /** The app deploys from GitHub - see the Pull requests entry below. */
  isGithubApp = true,
): NavSection[] {
  const base = `/apps/${slug}/settings`;
  return [
    {
      items: [
        {
          label: "Back to app",
          href: `/apps/${slug}`,
          icon: ArrowLeft,
          tooltip: "Return to the app overview",
          exact: true,
        },
      ],
    },
    {
      title: "Settings",
      iconless: true,
      items: [
        {
          label: "General",
          href: base,
          icon: Settings2,
          tooltip: "Name & logo",
          // Every settings route starts with `base`, so General must match
          // exactly or it would light up on every sub-page.
          exact: true,
        },
        {
          label: "Deployments",
          href: `${base}/deployments`,
          icon: Rocket,
          tooltip: "Deploy source, build & auto-deploy",
        },
        {
          label: "Pull requests",
          href: `${base}/pull-requests`,
          icon: GitPullRequest,
          tooltip: "Preview deploys, and everything that shapes them",
          requires: "manage_previews",
          // SHOWN, not hidden, when the app cannot use it. Only a GitHub app ever receives a
          // `pull_request` delivery, but an operator looking for the feature deserves to find
          // out that it exists and what it needs - a missing row would leave them hunting.
          ...(isGithubApp
            ? {}
            : {
                disabledReason:
                  "Pull request previews need an app that deploys from GitHub. Change the deploy source under Deployments.",
              }),
        },
        {
          label: "Storage",
          href: `${base}/storage`,
          icon: HardDrive,
          tooltip: "Persistent volumes",
        },
        {
          label: "Resources",
          href: `${base}/resources`,
          icon: Cpu,
          tooltip: "RAM, CPU & other limits",
        },
        {
          label: "Access",
          href: `${base}/access`,
          icon: ShieldCheck,
          tooltip: "HTTP basic auth",
          // Basic auth has its own permission, and it can be held on this app
          // alone (ADR-0016) - so the entry follows what the page's own loader
          // asks for. Mirrors how Environment/Backups are capability-gated.
          requires: "manage_basic_auth",
        },
        {
          label: "Activity",
          href: `${base}/activity`,
          icon: Activity,
          tooltip: "Who changed what, and when",
          requires: "view_activity",
        },
        {
          label: "Advanced",
          href: `${base}/advanced`,
          icon: SlidersHorizontal,
          tooltip: "Console, cron jobs & danger zone",
        },
      ],
    },
  ];
}

/**
 * A database's navigation.
 */
export function databaseNav(
  id: string,
  f: {
    pathname: string;
    consoleAcknowledged: boolean;
    cronsEnabled: boolean;
    /** The database's own logo, and its engine - the Overview entry's mark. Both
     *  absent until the layout has published them (see {@link AppNavFlags.logo}). */
    logo?: string | null;
    type?: DatabaseType;
  },
): NavSection[] {
  const base = `/storage/databases/${id}`;
  const on = (seg: string) =>
    f.pathname === base + seg || f.pathname.startsWith(base + seg + "/");
  const onConsole = on("/console");
  return [
    {
      items: [
        {
          label: "Back to storage",
          href: "/storage",
          icon: ArrowLeft,
          tooltip: "Return to storage",
          exact: true,
          back: true,
        },
      ],
    },
    {
      items: [
        {
          label: "Overview",
          href: base,
          icon: LayoutDashboard,
          // The database's own logo, or its engine's brand mark - the same
          // picture Storage lists it under.
          ...(f.type
            ? {
                mark: {
                  kind: "database" as const,
                  logo: f.logo ?? null,
                  type: f.type,
                },
              }
            : {}),
          tooltip: "Database overview",
          // Every DB route starts with `base`, so Overview must match exactly.
          exact: true,
        },
        {
          label: "Logs",
          href: `${base}/logs`,
          icon: ScrollText,
          tooltip: "Runtime logs",
        },
        {
          label: "Monitoring",
          href: `${base}/monitoring`,
          icon: LineChart,
          tooltip: "Live resource usage",
        },
        // Console is an ADVANCED surface - a live shell into the container,
        // reached from Advanced settings. Its chip stays hidden until the user
        // confirms the one-time warning (and stays put while the page is open).
        ...(f.consoleAcknowledged || onConsole
          ? [
              {
                label: "Console",
                href: `${base}/console`,
                icon: SquareTerminal,
                tooltip: "Container console",
                requires: "open_database_console",
              } as NavItem,
            ]
          : []),
        // Cron jobs, offered only once the switch is on - the app twin, and the
        // one flag this deliberately flag-less nav does take besides the console
        // acknowledgement.
        ...(f.cronsEnabled || on("/cron-jobs")
          ? [
              {
                label: "Cron jobs",
                href: `${base}/cron-jobs`,
                icon: Timer,
                tooltip: "Scheduled commands and their run history",
                requires: "manage_crons",
              } as NavItem,
            ]
          : []),
        {
          label: "Backups",
          href: `${base}/backups`,
          icon: Archive,
          tooltip: "Backups & restore",
          requires: "manage_backups",
        },
        {
          label: "Settings",
          href: `${base}/settings`,
          icon: Settings,
          tooltip: "Database settings",
        },
      ],
    },
  ];
}

/**
 * A database's SETTINGS sub-menu - one level deeper than {@link databaseNav},
 * the DB twin of {@link appSettingsNav}. "Back to database" goes UP one level to
 * the overview (a plain link, not a history back, which would exit the section).
 */
export function databaseSettingsNav(id: string): NavSection[] {
  const base = `/storage/databases/${id}/settings`;
  return [
    {
      items: [
        {
          label: "Back to database",
          href: `/storage/databases/${id}`,
          icon: ArrowLeft,
          tooltip: "Return to the database overview",
          exact: true,
        },
      ],
    },
    {
      title: "Settings",
      iconless: true,
      items: [
        {
          label: "General",
          href: base,
          icon: Settings2,
          tooltip: "Name & logo",
          exact: true,
        },
        {
          label: "Connection",
          href: `${base}/connection`,
          icon: Network,
          tooltip: "Exposure, server & password",
        },
        {
          label: "Resources",
          href: `${base}/resources`,
          icon: Cpu,
          tooltip: "RAM, CPU & other limits",
        },
        {
          label: "Activity",
          href: `${base}/activity`,
          icon: Activity,
          tooltip: "Who changed what, and when",
          requires: "view_activity",
        },
        {
          label: "Advanced",
          href: `${base}/advanced`,
          icon: SlidersHorizontal,
          tooltip: "Console, cron jobs, image & danger zone",
        },
      ],
    },
  ];
}

/**
 * The settings routes that are NOT team-scoped - the user's own account and the
 * instance/system pages. On these the topbar hides the team switcher (there is
 * no team context to act in). Everything else under /settings is team-scoped.
 */
export const NON_TEAM_SETTINGS_PREFIXES = [
  "/settings/account",
  // Two-factor enrolment belongs to the ACCOUNT, not to a team, and it must stay
  // reachable when a team's 2FA policy has locked the member out of that team.
  "/settings/security",
  "/settings/tokens",
  "/settings/users",
  "/settings/servers",
  // Instance-wide: the panel's own address and the certificate account are facts
  // about this Deplo, not about whichever team you happen to be looking at.
  "/settings/deplo",
];

/** True when the path is a personal/system settings route (team header hidden). */
export function isNonTeamSettings(pathname: string): boolean {
  return NON_TEAM_SETTINGS_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}
