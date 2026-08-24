import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { SectionLabel } from "@/components/apps/settings/settings-skeletons";

/** Pull request preview settings: the switch card, then the fields card. */
export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading pull request settings"
    >
      <SectionLabel width="w-28" />
      <Card>
        <CardContent className="flex items-center justify-between gap-4 pt-6">
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-full max-w-md" />
          </div>
          <Skeleton className="h-5 w-9 rounded-full" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-44" />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
          <div className="grid gap-4 sm:grid-cols-2">
            {["w-24", "w-16"].map((w, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className={`h-3 ${w}`} />
                <Skeleton className="h-9 w-full rounded-md" />
              </div>
            ))}
          </div>
        </CardContent>
        <CardFooter className="justify-end border-t border-border pt-4">
          <Skeleton className="h-8 w-20 rounded-md" />
        </CardFooter>
      </Card>
    </section>
  );
}
