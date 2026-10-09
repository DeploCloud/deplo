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

const ROWS: [string, string][] = [
  ["w-52", "w-24"],
  ["w-40", "w-20"],
  ["w-60", "w-28"],
  ["w-36", "w-24"],
  ["w-48", "w-16"],
  ["w-56", "w-24"],
  ["w-44", "w-20"],
  ["w-64", "w-28"],
  ["w-40", "w-24"],
  ["w-52", "w-20"],
];

export default function Loading() {
  return (
    <div
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading deployments"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <TextLine type={titleClass.section} className="w-40" />
          <TextLine type="text-sm leading-[1.6]" className="w-16" />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Skeleton className="h-8 w-[107px]" />
          <Skeleton className="size-8" />
        </div>
      </div>

      <div className="flex min-h-9 flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-full min-w-0 sm:w-64" />
        <Skeleton className="size-4 shrink-0 rounded" />
        <Skeleton className="h-9 w-[150px] shrink-0" />
        <Skeleton className="h-9 w-[205px] shrink-0" />
        <Skeleton className="h-9 w-[150px] shrink-0 sm:ml-auto" />
      </div>

      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10 pr-0">
                <Skeleton className="size-4 rounded-[4px]" />
              </TableHead>
              <TableHead>Deployment</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-28 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ROWS.map(([message, created], i) => (
              <TableRow key={i} className="hover:bg-transparent">
                <TableCell className="pr-0">
                  <Skeleton className="size-4 rounded-[4px]" />
                </TableCell>
                <TableCell className="max-w-[280px]">
                  <TextLine className={message} />
                  <TextLine type="text-xs" className="w-14" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-[22px] w-[72px]" />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Skeleton className="size-3.5 shrink-0 rounded" />
                    <TextLine type="font-mono text-xs" className="w-10" />
                  </div>
                </TableCell>
                <TableCell>
                  <TextLine type="leading-[1.6]" className={created} />
                  <TextLine type="text-xs leading-[1.6]" className="w-20" />
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-0.5">
                    {[0, 1, 2].map((b) => (
                      <Skeleton key={b} className="size-8" />
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
