import { Skeleton } from "@/components/ui/skeleton";
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
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-8 w-32 rounded-md" />
      </div>

      <div className="rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Skeleton className="h-3 w-16" />
              </TableHead>
              <TableHead>
                <Skeleton className="h-3 w-14" />
              </TableHead>
              <TableHead>
                <Skeleton className="h-3 w-12" />
              </TableHead>
              <TableHead className="text-right">
                <Skeleton className="ml-auto h-3 w-14" />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 3 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <Skeleton shimmer className="h-4 w-40" />
                    <Skeleton shimmer className="h-5 w-16 rounded-md" />
                    <Skeleton shimmer className="h-5 w-24 rounded-md" />
                  </div>
                </TableCell>
                <TableCell>
                  <Skeleton shimmer className="h-4 w-24" />
                </TableCell>
                <TableCell>
                  <Skeleton shimmer className="h-5 w-20 rounded-md" />
                </TableCell>
                <TableCell className="text-right">
                  <Skeleton className="ml-auto size-8 rounded-md" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
