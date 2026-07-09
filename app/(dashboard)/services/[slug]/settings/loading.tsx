import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { SectionLabel } from "@/components/services/settings/settings-skeletons";

/** General settings (name + logo) — the settings index page skeleton. */
export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading general settings"
    >
      <SectionLabel width="w-16" />
      <Card>
        <CardContent className="space-y-6 pt-6">
          <div className="space-y-3">
            <div className="space-y-1">
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 w-full max-w-md" />
            </div>
            <div className="flex items-center gap-4">
              <Skeleton className="size-12 rounded-md" />
              <Skeleton className="h-8 w-36 rounded-md" />
            </div>
            <Skeleton className="h-3 w-80" />
          </div>
          <div className="max-w-md space-y-2 border-t border-border pt-6">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
        </CardContent>
        <CardFooter className="justify-end border-t border-border pt-4">
          <Skeleton className="h-8 w-24 rounded-md" />
        </CardFooter>
      </Card>
    </section>
  );
}
