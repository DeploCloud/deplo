import {
  Server,
  Users,
  Building2,
  User,
  Package,
  GitBranch,
  Bell,
  KeyRound,
  ShieldCheck,
  Fingerprint,
  Bot,
  Cable,
} from "lucide-react";

import { DeploMark } from "@/components/logo";

import { backSection, type NavSection } from "./nav-item";

// SETTINGS_NAV - the settings navigation; the first item is a "back to dashboard"
// escape hatch.
export const SETTINGS_NAV: NavSection[] = [
  backSection("Back to dashboard", "/", "Return to the dashboard", true),
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
        tooltip: "Connect your AI agents to this team over MCP",
        // Connecting your own agent, or flipping the team's switch: either is
        // work to do here.
        requiresAny: ["manage_mcp", "manage_team"],
      },
    ],
  },
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
        tooltip: "Your personal bearer tokens, and what each one may do",
      },
    ],
  },
  {
    title: "System",
    items: [
      {
        label: "Deplo",
        href: "/settings/deplo",
        icon: DeploMark,
        tooltip: "This instance: its address, certificates and version",
        requiresAdmin: true,
      },
      {
        label: "Migrations",
        href: "/settings/migrations",
        icon: Cable,
        tooltip: "Bring another panel's teams over, each into a team here",
        // One panel is several teams, each landing in a team of the operator's
        // choosing: an instance-wide act, not one team's.
        requiresAdmin: true,
      },
      {
        label: "Servers",
        href: "/settings/servers",
        icon: Server,
        tooltip: "Connected servers & Docker hosts",
        // The management view lists EVERY server across teams, so this is gated
        // to instance admins rather than a per-team capability.
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
