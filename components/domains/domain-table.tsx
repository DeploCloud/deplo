import type { ComponentProps, ReactNode } from "react";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DomainRows } from "./domain-row";

export function DomainTable({
  children,
  ...props
}: ComponentProps<typeof DomainRows> & { children?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Domain</TableHead>
            {props.showContainer && (
              <TableHead className="w-56">Container</TableHead>
            )}
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <DomainRows {...props} />
          {children}
        </TableBody>
      </Table>
    </div>
  );
}
