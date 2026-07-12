import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { SectionLabel } from "@/components/services/settings/settings-skeletons";

/** Storage settings (persistent volumes). */
export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading storage settings"
    >
      <SectionLabel width="w-16" />
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-20" />
          <div className="space-y-1">
            <Skeleton className="h-4 w-full max-w-md" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr]">
              {["w-16", "w-24", "w-32"].map((w, i) => (
                <div key={i} className="space-y-1.5">
                  <Skeleton className={`h-3 ${w}`} />
                  <Skeleton className="h-9 w-full rounded-md" />
                </div>
              ))}
            </div>
          </div>
          <Skeleton className="mt-3 h-3 w-full max-w-lg" />
        </CardContent>
        <CardFooter className="justify-end border-t border-border pt-4">
          <Skeleton className="h-8 w-28 rounded-md" />
        </CardFooter>
      </Card>
    </section>
  );
}
