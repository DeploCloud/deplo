import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardFooter, CardHeader } from "@/components/ui/card";

/** Danger zone (delete service) — self-describing red card, no section label. */
export default function Loading() {
  return (
    <div role="status" aria-busy aria-label="Loading danger zone">
      <Card className="border-destructive/40">
        <CardHeader>
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-80" />
        </CardHeader>
        <CardFooter className="justify-end">
          <Skeleton className="h-8 w-36 rounded-md" />
        </CardFooter>
      </Card>
    </div>
  );
}
