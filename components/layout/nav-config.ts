import {
  LayoutGrid,
  LayoutDashboard,
  Rocket,
  ScrollText,
  Database,
  LayoutTemplate,
  Server,
  Settings,
  Brush,
  Activity,
  LineChart,
  Braces,
  Blocks,
  Users,
  ArrowLeft,
  Building2,
  User,
  Package,
  GitBranch,
  Globe,
  SquareTerminal,
  Code2,
  FolderTree,
  Archive,
  Bell,
  KeyRound,
  Settings2,
  HardDrive,
  ShieldCheck,
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
   */
  requires?: string;
  /** Visible only to instance admins (orthogonal to team capabilities). */
  requiresAdmin?: boolean;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
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
      },
      {
        label: "Plugins",
        href: "/plugins",
        icon: Blocks,
        tooltip: "Install plugins to extend Deplo",
        requires: "manage_infra",
      },
    ],
  },
  {
    title: "Workspace",
    items: [
      {
        label: "Members",
        href: "/members",
        icon: Users,
        tooltip: "People in this team",
      },
      {
        label: "Activity",
        href: "/activity",
        icon: Activity,
        tooltip: "Audit log of workspace events",
      },
      {
        label: "Monitoring",
        href: "/monitoring",
        icon: LineChart,
        tooltip: "Real-time server metrics",
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
        label: "Registries",
        href: "/settings/registries",
        icon: Package,
        tooltip: "Container image registries",
        requires: "manage_infra",
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
        label: "Notifications",
        href: "/settings/notifications",
        icon: Bell,
        tooltip: "Alerts & delivery channels",
      },
      {
        label: "API Tokens",
        href: "/settings/tokens",
        icon: KeyRound,
        tooltip: "Personal access tokens",
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
        label: "Docker cleanup",
        href: "/settings/cleanup",
        icon: Brush,
        tooltip: "Reclaim Docker disk on your servers",
        // NOT `requiresAdmin`, unlike its neighbours: reclaiming build cache is
        // operational hygiene, and the people who run out of disk at 3am are the
        // manage_infra holders — the same capability the page and
        // lib/data/docker-cleanup gate on.
        requires: "manage_infra",
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
 *  is running and whether the app is dev-eligible / has a files dir are known
 *  only to the app layout, which publishes them via the app-nav store). */
export interface AppNavFlags {
  /** Full current pathname — lets a section stay listed while it's the open page
   *  even before the store has confirmed its flag (avoids a missing active item
   *  on a hard load of e.g. /apps/x/console). */
  pathname: string;
  canManageEnv: boolean;
  canBackup: boolean;
  running: boolean;
  devEligible: boolean;
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
    },
    // Dev Mode — source-bearing apps only.
    ...(f.devEligible || on("/dev")
      ? [
          {
            label: "Dev Mode",
            href: `${base}/dev`,
            icon: Code2,
            tooltip: "Live dev container & SSH",
          } as NavItem,
        ]
      : []),
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
          // Basic auth is a domains concern — its data loader requires
          // manage_domains (and throws without it), so only surface the entry to
          // holders. Mirrors how Environment/Backups are capability-gated.
          requires: "manage_domains",
        },
        {
          label: "Advanced",
          href: `${base}/advanced`,
          icon: SlidersHorizontal,
          tooltip: "Console access & danger zone",
        },
      ],
    },
  ];
}

/**
 * A database's navigation. When the viewer is under `/storage/databases/<id>`
 * the sidebar swaps {@link NAV} for this set — the DB twin of {@link appNav}.
 * Deliberately flag-less (no nav store / sync component): Logs works while
 * stopped, and the Console/Backups pages guard themselves, so nothing here
 * depends on live per-database state. Console + Backups are manage_infra-only.
 */
export function databaseNav(id: string): NavSection[] {
  const base = `/storage/databases/${id}`;
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
          label: "Console",
          href: `${base}/console`,
          icon: SquareTerminal,
          tooltip: "Container console",
          requires: "manage_infra",
        },
        {
          label: "Backups",
          href: `${base}/backups`,
          icon: Archive,
          tooltip: "Backups & restore",
          requires: "manage_infra",
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
      items: [
        {
          label: "General",
          href: base,
          icon: Settings2,
          tooltip: "Network, server & password",
          exact: true,
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
  "/settings/notifications",
  "/settings/tokens",
  "/settings/users",
  "/settings/servers",
  // The cleanup policy is instance-wide and its runs belong to hosts, not teams —
  // servers are the one shared cross-team resource, so there is no team to act in.
  "/settings/cleanup",
];

/** True when the path is a personal/system settings route (team header hidden). */
export function isNonTeamSettings(pathname: string): boolean {
  return NON_TEAM_SETTINGS_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}
