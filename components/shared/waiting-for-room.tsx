import { Hourglass } from "lucide-react";

import { DocsLink } from "@/components/ui/docs-link";

/** "Waiting for room in eu": an App its cluster could not move anywhere yet. */
export function WaitingForRoom({ note }: { note: string }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-sm text-warning">
      <Hourglass className="size-3.5 shrink-0" />
      {note}
      <DocsLink topic="clusters.failover" />
    </span>
  );
}
