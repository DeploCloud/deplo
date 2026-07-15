import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { SectionLabel } from "@/components/apps/settings/settings-skeletons";

/** Resources settings (per-app RAM/CPU/disk caps). */
export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading resources settings"
    >
      <SectionLabel width="w-24" />
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <div className="space-y-1">
            <Skeleton className="h-4 w-full max-w-md" />
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap gap-2">
            {["w-20", "w-24", "w-20", "w-24", "w-20"].map((w, i) => (
              <Skeleton key={i} className={`h-8 ${w} rounded-md`} />
            ))}
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            {["w-24", "w-20"].map((w, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className={`h-3 ${w}`} />
                <Skeleton className="h-9 w-36 rounded-md" />
              </div>
            ))}
          </div>
        </CardContent>
        <CardFooter className="justify-end border-t border-border pt-4">
          <Skeleton className="h-8 w-28 rounded-md" />
        </CardFooter>
      </Card>
    </section>
  );
}
