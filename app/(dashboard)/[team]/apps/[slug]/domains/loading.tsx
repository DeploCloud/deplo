import { Skeleton, TextLine } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function Loading() {
  return (
    <div
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading domains"
    >
      <div className="flex items-center justify-between">
        <div>
          <TextLine type="text-sm font-medium" className="w-16" />
          <TextLine type="mt-1 text-sm leading-[1.6]" className="w-[22rem]" />
        </div>
        <Skeleton className="h-8 w-[120px]" />
      </div>

      <div className="rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Domain</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow className="hover:bg-transparent">
              <TableCell>
                <div className="flex flex-wrap items-center gap-2">
                  <TextLine type="font-medium" className="w-28" />
                  <Skeleton className="h-[22px] w-20" />
                  <Skeleton className="h-[22px] w-16" />
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Skeleton className="h-[22px] w-20" />
                  <Skeleton className="size-8" />
                </div>
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Skeleton className="size-8" />
                  <Skeleton className="size-8" />
                </div>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
