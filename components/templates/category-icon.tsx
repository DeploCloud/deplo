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
 * The catalog names each category's icon as a lucide id (`chart-line`,
 * `layout-template`, …). Sixteen explicit imports rather than
 * `lucide-react/dynamic`: the dynamic entrypoint reaches for the whole icon set
 * at runtime, and this list is short, static and tree-shakeable.
 *
 * A category the catalogue adds tomorrow falls back to `Package` — the same
 * glyph its own "Other" category uses — instead of rendering nothing.
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
