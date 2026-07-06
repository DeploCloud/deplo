import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
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
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading deployments"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-4 w-96" />
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>
                <Skeleton className="h-3 w-24" />
              </TableHead>
              <TableHead>
                <Skeleton className="h-3 w-16" />
              </TableHead>
              <TableHead>
                <Skeleton className="h-3 w-14" />
              </TableHead>
              <TableHead>
                <Skeleton className="h-3 w-24" />
              </TableHead>
              <TableHead>
                <Skeleton className="h-3 w-16" />
              </TableHead>
              <TableHead>
                <Skeleton className="h-3 w-16" />
              </TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 8 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell className="max-w-[280px]">
                  <div className="space-y-1.5">
                    <Skeleton shimmer className="h-4 w-44" />
                    <Skeleton shimmer className="h-3 w-14" />
                  </div>
                </TableCell>

                <TableCell>
                  <Skeleton shimmer className="h-4 w-24" />
                </TableCell>

                <TableCell>
                  <Skeleton shimmer className="h-5 w-20 rounded-md" />
                </TableCell>

                <TableCell>
                  <Skeleton shimmer className="h-5 w-20 rounded-md" />
                </TableCell>

                <TableCell>
                  <span className="flex items-center gap-1.5">
                    <Skeleton shimmer className="size-3.5 rounded-sm" />
                    <Skeleton shimmer className="h-3 w-20" />
                  </span>
                </TableCell>

                <TableCell>
                  <div className="space-y-1.5">
                    <Skeleton shimmer className="h-4 w-20" />
                    <Skeleton shimmer className="h-3 w-16" />
                  </div>
                </TableCell>

                <TableCell className="text-right">
                  <div className="flex justify-end">
                    <Skeleton shimmer className="size-8 rounded-md" />
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
