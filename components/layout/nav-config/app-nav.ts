import {
  GitPullRequest,
  Timer,
  LayoutDashboard,
  Rocket,
  ScrollText,
  Settings,
  Activity,
  LineChart,
  Braces,
  Globe,
  SquareTerminal,
  Archive,
  Settings2,
  HardDrive,
  ShieldCheck,
  SlidersHorizontal,
  Cpu,
} from "lucide-react";

import { onSubRoute } from "./active-route";
import { backSection, itemIf, type NavItem, type NavSection } from "./nav-item";

// AppNavFlags - per-app facts the sidebar can't derive itself, published by the app
// layout through the app-nav store.
export interface AppNavFlags {
  // Full current pathname - lets a section stay listed while it's the open page even
  // before the store has confirmed its flag (e.g. a hard load of /apps/x/console).
  pathname: string;
  canManageEnv: boolean;
  canBackup: boolean;
  running: boolean;
  isGithubApp: boolean;
  previewsEnabled: boolean;
  cronsEnabled: boolean;
  // Absent (not null) until the app layout has published it.
  logo?: string | null;
  consoleEnabled: boolean;
}

// appNav - an app's navigation.
export function appNav(slug: string, f: AppNavFlags): NavSection[] {
  const base = `/apps/${slug}`;
  const on = (seg: string) => onSubRoute(f.pathname, base, seg);

  const items: NavItem[] = [
    {
      label: "Overview",
      href: base,
      icon: LayoutDashboard,
      ...(f.logo !== undefined
        ? { mark: { kind: "app" as const, logo: f.logo } }
        : {}),
      tooltip: "App overview",
      // Every app route starts with `base`, so Overview must match exactly or it
      // would light up on every sub-page.
      exact: true,
    },
    {
      label: "Deployments",
      href: `${base}/deployments`,
      icon: Rocket,
      tooltip: "Deployment history",
    },
    // Never for a non-GitHub app: a docker image, an upload, a compose paste or a
    // raw git URL never receives a `pull_request` delivery.
    ...itemIf((f.isGithubApp && f.previewsEnabled) || on("/pull-requests"), {
      label: "Pull requests",
      href: `${base}/pull-requests`,
      icon: GitPullRequest,
      tooltip: "Preview deploys for open pull requests",
      // The page's own read is gated, so an ungated entry would link to an error.
      requires: "manage_previews",
    }),
    // With the switch off there is nothing to list, and the setting that turns it
    // back on lives under Settings where you would look for it.
    ...itemIf(f.cronsEnabled || on("/cron-jobs"), {
      label: "Cron jobs",
      href: `${base}/cron-jobs`,
      icon: Timer,
      tooltip: "Scheduled commands and their run history",
      requires: "manage_crons",
    }),
    {
      label: "Domains",
      href: `${base}/domains`,
      icon: Globe,
      tooltip: "Custom domains & routing",
    },
    ...itemIf(f.canManageEnv, {
      label: "Environment",
      href: `${base}/environment`,
      icon: Braces,
      tooltip: "Environment variables",
    }),
    // An ADVANCED surface - a live shell into the container, switched on from
    // Advanced settings, and kept listed while its page is open.
    ...itemIf(f.consoleEnabled && (f.running || on("/console")), {
      label: "Console",
      href: `${base}/console`,
      icon: SquareTerminal,
      tooltip: "Container console",
      requires: "open_app_console",
    }),
    // Stays visible even when the app is stopped: it falls back to the most recent
    // build's logs (flagged as not live) rather than a dead end.
    {
      label: "Logs",
      href: `${base}/logs`,
      icon: ScrollText,
      tooltip: "Runtime & build logs",
      requires: "view_logs",
    },
    {
      label: "Monitoring",
      href: `${base}/monitoring`,
      icon: LineChart,
      tooltip: "Live resource usage",
      requires: "view_metrics",
    },
    ...itemIf(f.canBackup || on("/backups"), {
      label: "Backups",
      href: `${base}/backups`,
      icon: Archive,
      tooltip: "Backups & restore",
    }),
    {
      label: "Activity",
      href: `${base}/activity`,
      icon: Activity,
      tooltip: "Who changed what, and when",
      requires: "view_activity",
    },
    {
      label: "Settings",
      href: `${base}/settings`,
      icon: Settings,
      tooltip: "App settings",
    },
  ];

  return [
    backSection("Back to apps", "/", "Return to all apps", true),
    { items },
  ];
}

// appSettingsNav - an app's SETTINGS sub-menu, one level deeper than appNav.
export function appSettingsNav(slug: string, isGithubApp = true): NavSection[] {
  const base = `/apps/${slug}/settings`;
  return [
    backSection("Back to app", `/apps/${slug}`, "Return to the app overview"),
    {
      title: "Settings",
      iconless: true,
      items: [
        {
          label: "General",
          href: base,
          icon: Settings2,
          tooltip: "Name & logo",
          // Every settings route starts with `base`, so General must match exactly
          // or it would light up on every sub-page.
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
          // SHOWN, not hidden, when the app cannot use it: an operator looking for
          // the feature deserves to find out that it exists and what it needs.
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
          // Basic auth has its own permission, holdable on this app alone
          // (ADR-0016), so the entry follows the page's own loader.
          requires: "manage_basic_auth",
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
