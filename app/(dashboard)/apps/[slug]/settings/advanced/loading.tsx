import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardFooter, CardHeader } from "@/components/ui/card";
import { SectionLabel } from "@/components/apps/settings/settings-skeletons";

/** Advanced settings: console access + danger zone. */
export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading advanced settings"
    >
      <SectionLabel width="w-20" />

      {/* Console access card */}
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
