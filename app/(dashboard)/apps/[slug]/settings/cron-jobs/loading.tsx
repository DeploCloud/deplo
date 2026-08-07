import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { SectionLabel } from "@/components/apps/settings/settings-skeletons";

/** Cron job settings: one switch card, mirroring the real layout. */
export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading cron job settings"
    >
      <SectionLabel width="w-24" />
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
