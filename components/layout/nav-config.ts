import {
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
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  tooltip: string;
  /** exact match for active state (default: startsWith) */
  exact?: boolean;
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
   *
   * A LIST means any one of them is enough — for a page that collects several
   * unrelated actions (Advanced: console, rebuild, transfer, delete), where
   * naming a single capability would hide it from someone who holds one of the
   * others.
   */
  requires?: string | string[];
  /** Visible only to instance admins (orthogonal to team capabilities). */
  requiresAdmin?: boolean;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
  /**
   * Render this section's entries as plain text — no icons. Used by the app /
   * database settings sub-menus, where the list is short, already titled, and an
   * icon per row is decoration rather than a wayfinding aid. Ignored while the
   * sidebar is collapsed, since there the icon IS the entry.
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
        tooltip: "Databases, S3 destinations & backups",
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
        // Every card in the catalogue deploys a NEW app, so without that
        // permission the whole section is a dead end (the page says so too).
        requires: "create_apps",
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
      // what a member can do — one decision, one place.
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
      {
        label: "Settings",
        href: "/settings",
        icon: Settings,
        tooltip: "Account, servers, registries & tokens",
      },
    ],
  },
];

/**
 * Settings navigation. When the viewer is anywhere under `/settings`, the
 * sidebar swaps {@link NAV} for this set — the same sidebar UI, just a different
 * left-hand nav — so each settings section is its own route/link (including the
 * relocated Servers page). The first item is a "back to dashboard" escape hatch.
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
  // Team — settings scoped to the active team (the team header stays shown here).
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
        tooltip: "Connected GitHub apps",
      },
    ],
  },
  // Account — the signed-in user's own settings (no team context).
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
        label: "Notifications",
        href: "/settings/notifications",
        icon: Bell,
        tooltip: "Alerts & delivery channels",
      },
      {
        label: "API tokens",
        href: "/settings/tokens",
        icon: KeyRound,
        tooltip: "Bearer tokens, and what each one may do",
      },
    ],
  },
  // System — instance-wide administration (admins) + posture.
  {
    title: "System",
    items: [
      {
        label: "Servers",
        href: "/settings/servers",
        icon: Server,
        tooltip: "Connected servers & Docker hosts",
        // Server administration is an instance-wide concern (the management view
        // lists EVERY server across teams), so it is gated to instance admins —
        // not the per-team manage_infra capability. Members reach servers only
        // through the team-scoped deploy pickers, never this page.
        requiresAdmin: true,
      },
      {
        label: "Deplo",
        href: "/settings/deplo",
        icon: SlidersHorizontal,
        tooltip: "How this Deplo instance addresses itself & issues certificates",
        // Instance admins, like its neighbours: everything on it is one setting
        // for the whole instance, and applying it touches every host.
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

/** Per-app facts the sidebar can't derive itself (the URL gives the slug and
 *  the viewer's capabilities gate Environment/Backups, but whether the container
 *  is running and whether the app has a files dir are known
 *  only to the app layout, which publishes them via the app-nav store). */
export interface AppNavFlags {
  /** Full current pathname — lets a section stay listed while it's the open page
   *  even before the store has confirmed its flag (avoids a missing active item
   *  on a hard load of e.g. /apps/x/console). */
  pathname: string;
  canManageEnv: boolean;
  canBackup: boolean;
  running: boolean;
  showFiles: boolean;
  /** The console is an advanced surface: its chip appears only once the user has
   *  confirmed the one-time "I understand" warning (persisted in localStorage). */
  consoleAcknowledged: boolean;
}

/**
 * An app's navigation. When the viewer is anywhere under `/apps/<slug>`
 * the sidebar swaps {@link NAV} for this set — the same sidebar UI, a different
 * left-hand nav — so each app section (Overview, Deployments, Domains, …) is
 * its own icon-led entry instead of a horizontal tab. Mirrors {@link SETTINGS_NAV}:
 * a "back" escape hatch on top, then the sections. The conditional entries match
 * the visibility rules the old horizontal tabs used.
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
    // Environment holds sensitive values — only for manage_env holders.
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
    {
      label: "Domains",
      href: `${base}/domains`,
      icon: Globe,
      tooltip: "Custom domains & routing",
    },
    // Console is an ADVANCED surface — a live shell into the container, reached
    // from Advanced settings. Its chip stays hidden until the user confirms the
    // one-time warning (consoleAcknowledged), and then only while there's a live
    // container to reach (running, or the console page is itself open).
    ...(f.consoleAcknowledged && (f.running || on("/console"))
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
    // Files — only when an on-disk files dir exists and the viewer can manage it.
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
    // Backups are infra ops — manage_infra only.
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
 * An app's SETTINGS sub-menu — one level deeper than {@link appNav}. When
 * the viewer is under `/apps/<slug>/settings` the sidebar swaps the app
 * nav for this set, so each settings section (General, Deployments, Storage,
 * Access, Advanced) is its own dedicated page. The "back" escape hatch here goes UP
 * one level to the app overview — unlike {@link appNav}'s "Back to
 * apps", which leaves the app entirely — so it is a plain link (not a
 * history `back`, which would exit the whole `/apps/<slug>` section).
 */
export function appSettingsNav(slug: string): NavSection[] {
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
          label: "Advanced",
          href: `${base}/advanced`,
          icon: SlidersHorizontal,
          tooltip: "Console access & danger zone",
          // Unlike its siblings, this page has nothing to READ: it is four
          // actions (console, rebuild, transfer, delete) and nothing else, so a
          // member holding none of them gets an entry where every control is
          // dead. One of the four is enough to earn it.
          requires: ["open_app_console", "deploy_apps", "move_apps", "delete_apps"],
        },
      ],
    },
  ];
}

/**
 * A database's navigation. When the viewer is under `/storage/databases/<id>`
 * the sidebar swaps {@link NAV} for this set — the DB twin of {@link appNav}.
 * Deliberately almost flag-less (no nav store / sync component): Logs works
 * while stopped, and the Backups page guards itself, so nothing here depends on
 * live per-database state. Console + Backups are manage_infra-only.
 *
 * The one flag is the console acknowledgement, for the same reason apps have it:
 * the console is an ADVANCED surface reached from Advanced settings, and its
 * chip stays hidden until the user has confirmed the one-time warning.
 */
export function databaseNav(
  id: string,
  f: { pathname: string; consoleAcknowledged: boolean },
): NavSection[] {
  const base = `/storage/databases/${id}`;
  const onConsole =
    f.pathname === `${base}/console` ||
    f.pathname.startsWith(`${base}/console/`);
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
        // Console is an ADVANCED surface — a live shell into the container,
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
 * A database's SETTINGS sub-menu — one level deeper than {@link databaseNav},
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
          label: "Advanced",
          href: `${base}/advanced`,
          icon: SlidersHorizontal,
          tooltip: "Image, command & danger zone",
        },
      ],
    },
  ];
}

/**
 * The settings routes that are NOT team-scoped — the user's own account and the
 * instance/system pages. On these the topbar hides the team switcher (there is
 * no team context to act in). Everything else under /settings is team-scoped.
 */
export const NON_TEAM_SETTINGS_PREFIXES = [
  "/settings/account",
  // Two-factor enrolment belongs to the ACCOUNT, not to a team — and it must stay
  // reachable when a team's 2FA policy has locked the member out of that team.
  "/settings/security",
  "/settings/notifications",
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
