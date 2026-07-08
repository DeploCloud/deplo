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
        tooltip: "Projects, folders & services overview",
        exact: true,
      },
      {
        label: "Deployments",
        href: "/deployments",
        icon: Rocket,
        tooltip: "All deployments across services",
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
        tooltip: "Service, shared & global environment variables",
        requires: "manage_env",
      },
      {
        label: "Templates",
        href: "/templates",
        icon: LayoutTemplate,
        tooltip: "One-click deploy templates",
      },
      {
        label: "Apps",
        href: "/apps",
        icon: Blocks,
        tooltip: "Install apps to extend Deplo",
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
        label: "Users",
        href: "/settings/users",
        icon: Users,
        tooltip: "Instance-wide user administration",
        requiresAdmin: true,
      },
    ],
  },
];

/** Per-service facts the sidebar can't derive itself (the URL gives the slug and
 *  the viewer's capabilities gate Environment/Backups, but whether the container
 *  is running and whether the service is dev-eligible / has a files dir are known
 *  only to the service layout, which publishes them via the service-nav store). */
export interface ServiceNavFlags {
  /** Full current pathname — lets a section stay listed while it's the open page
   *  even before the store has confirmed its flag (avoids a missing active item
   *  on a hard load of e.g. /services/x/console). */
  pathname: string;
  canManageEnv: boolean;
  canBackup: boolean;
  running: boolean;
  devEligible: boolean;
  showFiles: boolean;
}

/**
 * A service's navigation. When the viewer is anywhere under `/services/<slug>`
 * the sidebar swaps {@link NAV} for this set — the same sidebar UI, a different
 * left-hand nav — so each service section (Overview, Deployments, Domains, …) is
 * its own icon-led entry instead of a horizontal tab. Mirrors {@link SETTINGS_NAV}:
 * a "back" escape hatch on top, then the sections. The conditional entries match
 * the visibility rules the old horizontal tabs used.
 */
export function serviceNav(slug: string, f: ServiceNavFlags): NavSection[] {
  const base = `/services/${slug}`;
  // True while the given sub-route is the page currently open.
  const on = (seg: string) =>
    f.pathname === base + seg || f.pathname.startsWith(base + seg + "/");

  const items: NavItem[] = [
    {
      label: "Overview",
      href: base,
      icon: LayoutDashboard,
      tooltip: "Service overview",
      // Every service route starts with `base`, so Overview must match exactly
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
    // Console/Logs stream from a live container, so they show only while the
    // service is running (or when that page is itself the one open).
    ...(f.running || on("/console")
      ? [
          {
            label: "Console",
            href: `${base}/console`,
            icon: SquareTerminal,
            tooltip: "Container console",
          } as NavItem,
        ]
      : []),
    ...(f.running || on("/logs")
      ? [
          {
            label: "Logs",
            href: `${base}/logs`,
            icon: ScrollText,
            tooltip: "Runtime logs",
          } as NavItem,
        ]
      : []),
    // Dev Mode — source-bearing services only.
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
            tooltip: "Service files",
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
      tooltip: "Service settings",
    },
  ];

  return [
    {
      items: [
        {
          label: "Back to services",
          href: "/",
          icon: ArrowLeft,
          tooltip: "Return to all services",
          exact: true,
        },
      ],
    },
    { items },
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
];

/** True when the path is a personal/system settings route (team header hidden). */
export function isNonTeamSettings(pathname: string): boolean {
  return NON_TEAM_SETTINGS_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}
