import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-5" role="status" aria-busy aria-label="Loading">
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-80 w-full rounded-xl" />
    </div>
  );
}
