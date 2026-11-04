import { ServersListSkeleton } from "@/components/servers/servers-list";
import {
  ServerCardSkeleton,
  ServersHeader,
  ServersHeaderActionsSkeleton,
} from "./servers-shell";

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy>
      <ServersHeader actions={<ServersHeaderActionsSkeleton />} />
      <ServersListSkeleton>
        <ServerCardSkeleton />
        <ServerCardSkeleton />
      </ServersListSkeleton>
    </div>
  );
}
