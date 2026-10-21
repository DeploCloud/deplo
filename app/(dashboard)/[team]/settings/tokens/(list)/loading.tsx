import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// [name, permissions badge, access, last used] per token row.
const TOKENS: [string, string, string, string][] = [
  ["w-28", "w-20", "w-24", "w-20"],
  ["w-20", "w-24", "w-32", "w-16"],
  ["w-32", "w-16", "w-24", "w-20"],
  ["w-24", "w-28", "w-20", "w-24"],
];

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading API tokens"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <TextLine type={titleClass.page} className="w-26" />
          <TextLine type="text-sm leading-[1.6]" className="w-160 max-w-full" />
        </div>
        <Skeleton className="h-8 w-27" />
      </div>

      <div className="rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Permissions</TableHead>
              <TableHead>Access</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {TOKENS.map(([name, badge, access, used], i) => (
              <TableRow key={i}>
                <TableCell>
                  <TextLine type="font-medium" className={name} />
                  <TextLine
                    type="mt-1 font-mono text-xs leading-[1.6]"
                    className="w-28"
                  />
                </TableCell>
                <TableCell>
                  <Skeleton className={`h-[22px] ${badge}`} />
                </TableCell>
                <TableCell>
                  <TextLine className={access} />
                </TableCell>
                <TableCell>
                  <TextLine className={used} />
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
  );
}
