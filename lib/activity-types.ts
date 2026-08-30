import {
  Activity as ActivityIcon,
  Archive,
  Bot,
  Box,
  Boxes,
  Brush,
  Database,
  Gauge,
  Globe,
  HardDrive,
  KeyRound,
  Plug,
  Rocket,
  Server,
  Settings,
  ShieldCheck,
  Timer,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { ActivityType } from "./types";

/**
 * Every kind of event the trail records, in the order the Activity page's event
 * filter lists them. The one place a type gets a name and a face.
 */
export const ACTIVITY_TYPES: {
  value: ActivityType;
  label: string;
  /** Heading in the event filter. */
  group: string;
  /** Also the filter's search keywords - it matches label and hint together. */
  hint?: string;
  icon: LucideIcon;
}[] = [
  { value: "deployment", label: "Deployments", group: "Apps", icon: Rocket },
  { value: "app", label: "Apps", group: "Apps", icon: Box },
  { value: "project", label: "Projects", group: "Apps", icon: Boxes },
  { value: "domain", label: "Domains", group: "Apps", icon: Globe },
  {
    value: "env",
    label: "Variables",
    group: "Apps",
    hint: "env",
    icon: KeyRound,
  },
  { value: "database", label: "Databases", group: "Data", icon: Database },
  { value: "backup", label: "Backups", group: "Data", icon: Archive },
  {
    value: "s3",
    label: "Backup destinations",
    group: "Data",
    hint: "S3",
    icon: HardDrive,
  },
  { value: "cron", label: "Cron jobs", group: "Data", icon: Timer },
  { value: "member", label: "Members & roles", group: "Team", icon: Users },
  {
    value: "security",
    label: "Tokens & 2FA",
    group: "Team",
    hint: "passkeys",
    icon: ShieldCheck,
  },
  { value: "server", label: "Servers", group: "Platform", icon: Server },
  {
    value: "integration",
    label: "Integrations",
    group: "Platform",
    hint: "git registries",
    icon: Plug,
  },
  {
    value: "instance",
    label: "Instance settings",
    group: "Platform",
    icon: Settings,
  },
  { value: "cleanup", label: "Docker cleanup", group: "Platform", icon: Brush },
  { value: "monitoring", label: "Monitoring", group: "Platform", icon: Gauge },
  { value: "mcp", label: "MCP access", group: "Platform", icon: Bot },
];

/** A type's glyph. A record, not a lookup call: the value IS rendered as a
 *  component, and React must see it read rather than produced. */
export const ACTIVITY_ICON: Record<string, LucideIcon> = Object.fromEntries(
  ACTIVITY_TYPES.map((t) => [t.value, t.icon]),
);

/** The glyph for a value an older build wrote and this one has no name for. */
export const UNKNOWN_ACTIVITY_ICON = ActivityIcon;
