import type { ElementType } from "react";
import { Archive, DownloadCloud, Hammer, ServerCog } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ServerRole } from "./server-role-options";

/** What a server is used for. `import` is not a choice - it is what a host
 *  borrowed for a migration is. */
export type ServerUse = ServerRole | "import";

/**
 * The one place a use is named and coloured, read by the card badge and by the
 * list's filter - so the chip and the dropdown can never say two things.
 */
export const SERVER_USES: Record<
  ServerUse,
  { label: string; icon: ElementType; className: string; title: string }
> = {
  everything: {
    label: "Everything",
    icon: ServerCog,
    className: "bg-info/15 text-info",
    title: "Runs your deployments and builds them.",
  },
  build: {
    label: "Build only",
    icon: Hammer,
    className: "bg-warning/15 text-warning",
    title:
      "This server only builds images, for apps that run on your other servers. Nothing is deployed here and it has no proxy.",
  },
  storage: {
    label: "Backups only",
    icon: Archive,
    className: "bg-violet/15 text-violet",
    title:
      "This server only holds backup files. It has no Docker and nothing is deployed here.",
  },
  import: {
    label: "Migration source",
    icon: DownloadCloud,
    className: "bg-chart-3/15 text-chart-3",
    title:
      "Another platform's host. Deplo installed its agent there to read the data being imported, and removes it when the migration is done.",
  },
};

export const SERVER_USE_IDS = Object.keys(SERVER_USES) as ServerUse[];

/** A borrowed host is only ever that, whatever else its row says. */
export function serverUse(server: {
  buildOnly: boolean;
  storageOnly: boolean;
  importOnly: boolean;
}): ServerUse {
  if (server.importOnly) return "import";
  if (server.buildOnly) return "build";
  if (server.storageOnly) return "storage";
  return "everything";
}

export function ServerUseBadge({ use }: { use: ServerUse }) {
  const { label, icon: Icon, className, title } = SERVER_USES[use];
  return (
    <Badge
      variant="muted"
      className={cn("shrink-0 gap-1 border-transparent", className)}
      title={title}
    >
      <Icon className="size-3" />
      {label}
    </Badge>
  );
}
