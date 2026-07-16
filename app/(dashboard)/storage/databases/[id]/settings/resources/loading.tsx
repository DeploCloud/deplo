import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export default function Loading() {
  return (
    <section className="space-y-4" role="status" aria-busy aria-label="Loading settings">
      <Skeleton className="h-5 w-24" />
      <Card>
        <CardContent className="space-y-4 p-6">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
        </CardContent>
      </Card>
    </section>
  );
}
