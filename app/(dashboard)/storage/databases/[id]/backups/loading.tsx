import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-5" role="status" aria-busy aria-label="Loading backups">
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}
