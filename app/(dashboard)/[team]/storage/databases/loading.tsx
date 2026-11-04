import { DatabaseFrameSkeleton } from "@/components/storage/database-header";
import { DatabaseTabSkeleton } from "@/components/storage/database-tab-skeleton";

// The database layout awaits its row, so this draws its frame until it can.
export default function Loading() {
  return (
    <DatabaseFrameSkeleton>
      <DatabaseTabSkeleton />
    </DatabaseFrameSkeleton>
  );
}
