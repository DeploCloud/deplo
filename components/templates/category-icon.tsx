// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import {
  Activity,
  ChartLine,
  Clapperboard,
  Code,
  Database,
  HardDrive,
  LayoutTemplate,
  ListTodo,
  Mail,
  MessageCircle,
  Network,
  Package,
  Shield,
  Sparkles,
  Wallet,
  Workflow,
} from "lucide-react";

/**
 * Category icons, named by the catalog as lucide ids. Explicit imports rather
 * than `lucide-react/dynamic`, which reaches for the whole set at runtime. An
 * unknown category falls back to `Package` instead of rendering nothing.
 */
const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  activity: Activity,
  "chart-line": ChartLine,
  clapperboard: Clapperboard,
  code: Code,
  database: Database,
  "hard-drive": HardDrive,
  "layout-template": LayoutTemplate,
  "list-todo": ListTodo,
  mail: Mail,
  "message-circle": MessageCircle,
  network: Network,
  package: Package,
  shield: Shield,
  sparkles: Sparkles,
  wallet: Wallet,
  workflow: Workflow,
};

export function CategoryIcon({
  icon,
  className,
}: {
  icon: string;
  className?: string;
}) {
  const Icon = ICONS[icon] ?? Package;
  return <Icon className={className} />;
}
