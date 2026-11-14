import { ServersGridSkeleton } from "@/components/servers/servers-toolbar";
import { ServerCardSkeleton } from "./server-card";
import { ServersHeader, ServersHeaderActionsSkeleton } from "./servers-shell";

export default function Loading() {
  return (
    <div className="space-y-5" aria-busy>
      <ServersHeader actions={<ServersHeaderActionsSkeleton />} />
      <ServersGridSkeleton>
        <ServerCardSkeleton />
        <ServerCardSkeleton />
        <ServerCardSkeleton />
      </ServersGridSkeleton>
    </div>
  );
}
