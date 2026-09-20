import type { ElementType } from "react";
import { Archive, DownloadCloud, Hammer, ServerCog } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { ServerRole } from "./server-role-options";

export type ServerUse = ServerRole | "import";

export const SERVER_USES: Record<
  ServerUse,
  { label: string; icon: ElementType; title: string }
> = {
  everything: {
    label: "Everything",
    icon: ServerCog,
    title: "Runs your deployments and builds them.",
  },
  build: {
    label: "Build only",
    icon: Hammer,
    title:
      "This server only builds images, for apps that run on your other servers. Nothing is deployed here and it has no proxy.",
  },
  storage: {
    label: "Backups only",
    icon: Archive,
    title:
      "This server only holds backup files. It has no Docker and nothing is deployed here.",
  },
  import: {
    label: "Migration source",
    icon: DownloadCloud,
    title:
      "Another platform's host. Deplo installed its agent there to read the data being imported, and removes it when the migration is done.",
  },
};

export const SERVER_USE_IDS = Object.keys(SERVER_USES) as ServerUse[];

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
  const { label, icon: Icon, title } = SERVER_USES[use];
  return (
    <Badge variant="muted" className="shrink-0 gap-1" title={title}>
      <Icon className="size-3" />
      {label}
    </Badge>
  );
}
