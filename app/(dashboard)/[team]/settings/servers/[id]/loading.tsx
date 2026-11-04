import { ServerDetailHeaderSkeleton } from "./server-detail-header";
import { ServerDetailTabsSkeleton } from "./server-detail-tabs";

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6" aria-busy>
      <ServerDetailHeaderSkeleton />
      <ServerDetailTabsSkeleton />
    </div>
  );
}
