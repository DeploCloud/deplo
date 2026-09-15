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
        requiresAdmin: true,
      },
      {
        label: "Servers",
        href: "/settings/servers",
        icon: Server,
        tooltip: "Connected servers & Docker hosts",
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
