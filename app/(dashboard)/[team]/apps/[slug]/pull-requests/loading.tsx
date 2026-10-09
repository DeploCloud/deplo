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

const ROWS: [string, string][] = [
  ["w-56", "w-44"],
  ["w-40", "w-36"],
  ["w-64", "w-40"],
];

export default function Loading() {
  return (
    <div
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading pull requests"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <TextLine type="text-sm font-medium" className="w-36" />
          <TextLine
            type="mt-1 text-sm leading-[1.6]"
            className="w-[30rem] max-w-full"
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="size-8" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>

      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pull request</TableHead>
              <TableHead className="w-[140px]">Status</TableHead>
              <TableHead>Preview</TableHead>
              <TableHead className="w-[120px]">Updated</TableHead>
              <TableHead className="w-[120px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ROWS.map(([title, host], i) => (
              <TableRow key={i} className="hover:bg-transparent">
                <TableCell>
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <TextLine type="font-mono" className="w-7" />
                    <TextLine className={title} />
                  </div>
                  <TextLine
                    type="mt-0.5 text-xs leading-[1.6]"
                    className="w-40"
                  />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-[22px] w-[72px]" />
                </TableCell>
                <TableCell>
                  <TextLine type="font-mono text-xs" className={host} />
                </TableCell>
                <TableCell>
                  <TextLine type="text-xs" className="w-16" />
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {[0, 1, 2].map((b) => (
                      <Skeleton key={b} className="size-9" />
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
