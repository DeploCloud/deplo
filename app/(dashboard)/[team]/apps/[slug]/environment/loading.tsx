import { Button } from "@/components/ui/button";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Type and Modified by carry an info tip, Updated does not.
const FACETS = [true, true, false];

const KEY_WIDTHS = ["w-40", "w-32", "w-24", "w-28", "w-44", "w-28"];

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading environment variables"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <TextLine type="text-sm" className="w-38" />
            <TextLine type="mt-1 text-sm" className="w-96 max-w-full" />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
          <div className="min-w-[11rem] flex-1 basis-full sm:basis-auto lg:max-w-[16rem]">
            <Skeleton className="h-9 w-full" />
          </div>
          {FACETS.map((info, i) => (
            <div
              key={i}
              className="flex min-w-[10rem] flex-1 items-center gap-1 lg:min-w-0"
            >
              <Skeleton className="h-9 min-w-0 flex-1" />
              {info && <Skeleton className="size-3.5 shrink-0 rounded-full" />}
            </div>
          ))}
          <Button variant="ghost" disabled className="invisible shrink-0">
            Clear filters
          </Button>
          <Skeleton className="h-9 w-[11.5rem] shrink-0" />
          <div className="flex shrink-0 items-center gap-2">
            <Skeleton className="h-9 w-21" />
          </div>
        </div>

        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">Key</TableHead>
                <TableHead className="w-full">Value</TableHead>
                <TableHead className="whitespace-nowrap">
                  Last modified
                </TableHead>
                <TableHead className="whitespace-nowrap">Modified by</TableHead>
                <TableHead className="text-right whitespace-nowrap">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {KEY_WIDTHS.map((width, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <TextLine type="font-mono text-xs" className={width} />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-7 w-full" />
                  </TableCell>
                  <TableCell>
                    <TextLine type="text-xs" className="w-18" />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Skeleton className="size-5 shrink-0 rounded-full" />
                      <TextLine type="text-xs" className="w-10" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Skeleton className="size-8" />
                      <Skeleton className="size-8" />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
