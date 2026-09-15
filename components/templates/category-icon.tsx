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
