import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading cron job settings"
    >
      <Skeleton className="h-4 w-24" />
      <Card>
        <CardContent className="flex items-center justify-between gap-4 pt-6">
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-4 w-full max-w-md" />
          </div>
          <Skeleton className="h-5 w-9 rounded-full" />
        </CardContent>
      </Card>
    </section>
  );
}
