import { Card } from "@/components/ui/card";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { titleClass } from "@/components/shared/page-header";
import { cn } from "@/lib/utils";

const FACETS = ["w-[170px]", "w-[180px]", "w-[150px]", "w-[205px]"];

// [message, app, badge, branch, created]: the widest of each sizes its column
// the way the real rows do. 25 rows is the table's first page.
const PATTERN: string[][] = [
  ["w-44", "w-10", "w-[72px]", "w-[27px]", "w-[6.25rem]"],
  ["w-[251px]", "w-[57px]", "w-[72px]", "w-5", "w-[6.25rem]"],
  ["w-60", "w-10", "w-16", "w-[27px]", "w-[113px]"],
  ["w-44", "w-11", "w-[89px]", "w-[27px]", "w-24"],
  ["w-52", "w-[57px]", "w-[72px]", "w-5", "w-24"],
];
const ROWS = Array.from({ length: 25 }, (_, i) => PATTERN[i % 5]!);

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading deployments"
    >
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <TextLine type={titleClass.page} className="w-30" />
            <TextLine
              type="text-sm leading-[1.6]"
              className="w-[27.5rem] max-w-full"
            />
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Skeleton className="h-8 w-[107px]" />
          </div>
        </div>

        <div className="flex min-h-9 flex-wrap items-center gap-2">
          <div className="w-full min-w-0 sm:w-64">
            <Skeleton className="h-9 w-full" />
          </div>
          <Skeleton className="size-4 shrink-0 rounded" />
          {FACETS.map((w) => (
            <Skeleton key={w} className={cn("h-9 shrink-0", w)} />
          ))}
          <div className="flex items-center gap-2 sm:ml-auto">
            <Skeleton className="h-9 w-[150px] shrink-0" />
          </div>
        </div>

        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 pr-0">
                  <Skeleton className="size-4 rounded" />
                </TableHead>
                <TableHead>Deployment</TableHead>
                <TableHead>App</TableHead>
                <TableHead>Server</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-28 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROWS.map(([message, app, badge, branch, created], i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell className="pr-0">
                    <Skeleton className="size-4 rounded" />
                  </TableCell>
                  <TableCell className="max-w-[280px]">
                    <TextLine type="text-sm" className={message} />
                    <TextLine type="text-xs" className="w-12" />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Skeleton className="size-5 shrink-0 rounded-full" />
                      <TextLine type="text-sm" className={app} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <TextLine type="text-sm" className="w-16" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className={cn("h-[22px] rounded-md", badge)} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <Skeleton className="size-3.5 shrink-0 rounded" />
                      <TextLine type="font-mono text-xs" className={branch} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <TextLine
                      type="text-sm leading-[1.6]"
                      className={created}
                    />
                    <div className="flex h-[1.2rem] items-center gap-1.5">
                      <TextLine type="text-xs" className="w-3" />
                      <Skeleton className="size-4 shrink-0 rounded-full" />
                      <TextLine type="text-xs" className="w-8" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-0.5">
                      {[0, 1, 2].map((b) => (
                        <div key={b} className="grid size-8 place-items-center">
                          <Skeleton className="size-4 rounded" />
                        </div>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
