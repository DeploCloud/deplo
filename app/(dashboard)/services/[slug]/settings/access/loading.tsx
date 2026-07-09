import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SectionLabel } from "@/components/services/settings/settings-skeletons";

/** Access settings (HTTP Basic Auth). */
export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading access settings"
    >
      <SectionLabel width="w-14" />
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1.5">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-full max-w-md" />
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
    </section>
  );
}
