import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { SectionLabel } from "@/components/apps/settings/settings-skeletons";

// Varied bar widths so the repo list placeholder reads like a real list
// (mirrors GithubRepoPicker's own loading skeleton).
const REPO_WIDTHS = ["w-1/2", "w-2/3", "w-2/5", "w-3/5", "w-1/3", "w-1/2"];

/** Deployment settings (deploy source + build + automatic deployments). */
export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading deployment settings"
    >
      <SectionLabel width="w-24" />
      <div className="space-y-6">
        {/* Deploy Source */}
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-80" />
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Source picker (GitHub · Git · Docker Image · Upload · Compose) */}
            <div className="flex flex-wrap items-center gap-2">
              {["w-24", "w-16", "w-32", "w-24", "w-28"].map((w, i) => (
                <Skeleton key={i} className={`h-8 ${w} rounded-md`} />
              ))}
            </div>
            {/* GitHub repo picker (default source) */}
            <div className="space-y-3">
              <Skeleton className="h-9 w-full rounded-md" />
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
                {REPO_WIDTHS.map((w, i) => (
                  <div key={i} className="flex w-full items-center gap-2 px-3 py-2">
                    <Skeleton className={`h-3.5 ${w}`} />
                  </div>
                ))}
              </div>
            </div>
            {/* Server select */}
            <div className="max-w-md space-y-2">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-9 w-full rounded-md" />
            </div>
          </CardContent>
          <CardFooter className="justify-end border-t border-border pt-4">
            <Skeleton className="h-8 w-28 rounded-md" />
          </CardFooter>
        </Card>

        {/* Build & Output Settings */}
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-44" />
            <Skeleton className="h-4 w-80" />
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              <div className="space-y-2">
                <Skeleton className="h-4 w-28" />
                <div className="grid gap-2 sm:grid-cols-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 rounded-lg" />
                  ))}
                </div>
              </div>
              <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="space-y-2">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-9 w-full rounded-md" />
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
          <CardFooter className="justify-end border-t border-border pt-4">
            <Skeleton className="h-8 w-40 rounded-md" />
          </CardFooter>
        </Card>

        {/* Automatic deployments */}
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-72" />
              </div>
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
