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

const RUN_DESTINATIONS = ["w-52", "w-48", "w-56", "w-52"];

export default function Loading() {
  return (
    <div
      className="space-y-8"
      role="status"
      aria-busy
      aria-label="Loading backups"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <TextLine type={titleClass.section} className="w-20" />
          <TextLine type="text-sm" className="w-[33rem] max-w-full" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-8 w-30" />
        </div>
      </div>

      <section className="space-y-3">
        <TextLine type="text-sm" className="w-24" />
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Backup</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {RUN_DESTINATIONS.map((width, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Skeleton className="size-2.5 shrink-0 rounded-full" />
                      <TextLine type="text-sm" className="w-20" />
                    </div>
                    <TextLine type="mt-1 text-xs" className={width} />
                  </TableCell>
                  <TableCell>
                    <TextLine type="justify-end text-sm" className="w-14" />
                  </TableCell>
                  <TableCell className="w-px">
                    <Skeleton className="size-8" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
