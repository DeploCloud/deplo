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
    <DomainTableFrame showContainer={props.showContainer}>
      <DomainRows {...props} />
      {children}
    </DomainTableFrame>
  );
}

export function DomainTableFrame({
  showContainer,
  children,
}: {
  showContainer: boolean;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <Table className="max-md:block">
        <TableHeader className="max-md:hidden">
          <TableRow>
            <TableHead>Domain</TableHead>
            {showContainer && <TableHead className="w-56">Container</TableHead>}
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="max-md:block">{children}</TableBody>
      </Table>
    </div>
  );
}

// The App's Domains tab heading; `note` and `action` are what the page knows.
export function DomainsIntro({
  note,
  action,
}: {
  note?: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h3 className="text-sm font-medium">Domains</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Custom domains routed to this app with automatic TLS.
        </p>
        {note}
      </div>
      {action}
    </div>
  );
}
