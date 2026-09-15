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

export interface AppNavFlags {
  pathname: string;
  canManageEnv: boolean;
  canBackup: boolean;
  running: boolean;
  isGithubApp: boolean;
  previewsEnabled: boolean;
  cronsEnabled: boolean;
  logo?: string | null;
  consoleEnabled: boolean;
}

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
      exact: true,
    },
    {
      label: "Deployments",
      href: `${base}/deployments`,
      icon: Rocket,
      tooltip: "Deployment history",
    },
    ...itemIf((f.isGithubApp && f.previewsEnabled) || on("/pull-requests"), {
      label: "Pull requests",
      href: `${base}/pull-requests`,
      icon: GitPullRequest,
      tooltip: "Preview deploys for open pull requests",
      requires: "manage_previews",
    }),
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
    ...itemIf(f.consoleEnabled && (f.running || on("/console")), {
      label: "Console",
      href: `${base}/console`,
      icon: SquareTerminal,
      tooltip: "Container console",
      requires: "open_app_console",
    }),
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
          // Basic auth has its own Capability, holdable on this app alone (ADR-0016).
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
