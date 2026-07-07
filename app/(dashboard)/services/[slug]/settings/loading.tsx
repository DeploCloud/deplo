import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Varied bar widths so the repo list placeholder reads like a real list
// (mirrors GithubRepoPicker's own loading skeleton).
const REPO_WIDTHS = ["w-1/2", "w-2/3", "w-2/5", "w-3/5", "w-1/3", "w-1/2"];

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading project settings"
    >
      {/* General */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 w-52" />
        </CardHeader>
        <CardContent>
          <div className="max-w-md space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-9 w-full rounded-md" />
          </div>
        </CardContent>
        <CardFooter className="justify-end border-t border-border pt-4">
          <Skeleton className="h-8 w-20 rounded-md" />
        </CardFooter>
      </Card>

      {/* Logo */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-14" />
          <div className="space-y-1">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <Skeleton className="size-12 rounded-md" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-36 rounded-md" />
            </div>
          </div>
          <Skeleton className="mt-3 h-3 w-80" />
        </CardContent>
      </Card>

      {/* Deploy Source */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-80" />
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Source tabs (GitHub · Git · Docker Image · Upload · Compose) */}
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
                <div
                  key={i}
                  className="flex w-full items-center gap-2 px-3 py-2"
                >
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
            {/* Build method picker */}
            <div className="space-y-2">
              <Skeleton className="h-4 w-28" />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 rounded-md" />
                ))}
              </div>
              <Skeleton className="h-3 w-64" />
            </div>

            {/* Command / runtime / port fields */}
            <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
              {Array.from({ length: 6 }).map((_, i) => (
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

      {/* Volumes */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-5 w-20" />
          </div>
          <div className="space-y-1">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {/* One volume row */}
            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="grid gap-3 sm:grid-cols-[auto_1fr_1fr]">
                {["w-16", "w-24", "w-32"].map((w, i) => (
                  <div key={i} className="space-y-1.5">
                    <Skeleton className={`h-3 ${w}`} />
                    <Skeleton className="h-9 w-full rounded-md" />
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-3 w-64" />
                <div className="flex items-center gap-4">
                  <Skeleton className="h-5 w-9 rounded-full" />
                  <Skeleton className="size-8 rounded-md" />
                </div>
              </div>
            </div>
            <Skeleton className="h-8 w-28 rounded-md" />
          </div>
          <Skeleton className="mt-3 h-3 w-full" />
        </CardContent>
        <CardFooter className="justify-end border-t border-border pt-4">
          <Skeleton className="h-8 w-28 rounded-md" />
        </CardFooter>
      </Card>

      {/* Git */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-10" />
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-72" />
            </div>
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
        </CardContent>
      </Card>

      {/* HTTP Basic Auth */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1.5">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <Skeleton className="h-8 w-24 shrink-0 rounded-md" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Skeleton className="h-3 w-20" />
                  </TableHead>
                  <TableHead>
                    <Skeleton className="h-3 w-20" />
                  </TableHead>
                  <TableHead className="text-right">
                    <Skeleton className="ml-auto h-3 w-14" />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Array.from({ length: 2 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Skeleton className="h-4 w-24" />
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-28" />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Skeleton className="size-8 rounded-md" />
                        <Skeleton className="size-8 rounded-md" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Danger Zone */}
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
