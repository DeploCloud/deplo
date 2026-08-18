import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { SectionLabel } from "@/components/apps/settings/settings-skeletons";

/** Advanced settings: the two feature rows, rebuild, and the danger zone. */
export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading advanced settings"
    >
      <SectionLabel width="w-20" />

      {/* Advanced features: console + cron jobs, one row each */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-full max-w-md" />
        </CardHeader>
        <CardContent className="space-y-3">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-3 rounded-lg border p-4"
            >
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-full max-w-sm" />
              </div>
              <Skeleton className="h-8 w-28 rounded-md" />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Rebuild card */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-full max-w-md" />
        </CardHeader>
        <CardFooter className="justify-end">
          <Skeleton className="h-8 w-32 rounded-md" />
        </CardFooter>
      </Card>

      {/* Danger zone card */}
      <Card className="border-destructive/40">
        <CardHeader>
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-80" />
        </CardHeader>
        <CardFooter className="justify-end">
          <Skeleton className="h-8 w-36 rounded-md" />
        </CardFooter>
      </Card>
    </section>
  );
}
