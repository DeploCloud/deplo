import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Mirrors the tokens list. The New token menu lives in the PAGE header, not
 * the card's, so the action skeleton sits beside the title.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading API tokens"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>

      <Card>
        <CardContent className="space-y-2 pt-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton
                key={i}
                shimmer
                style={{ ["--shimmer-delay" as string]: `-${(i * 0.09).toFixed(2)}s` }}
                className="h-14 w-full rounded-lg"
              />
            ))}
        </CardContent>
      </Card>
    </div>
  );
}
