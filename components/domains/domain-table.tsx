"use client";

import type { ComponentProps, ReactNode } from "react";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  SortableHead,
  useTableSort,
  type SortState,
} from "@/components/ui/table-sort";
import { DOMAIN_SORT, DomainRows } from "./domain-row";

type DomainColumn = keyof typeof DOMAIN_SORT;

export function DomainTable({
  children,
  ...props
}: ComponentProps<typeof DomainRows> & { children?: ReactNode }) {
  const { rows, sort, toggle } = useTableSort(props.domains, DOMAIN_SORT);
  return (
    <DomainTableFrame
      showContainer={props.showContainer}
      sort={sort}
      onSort={toggle}
    >
      <DomainRows
        {...props}
        domains={rows}
        siblings={props.siblings ?? props.domains}
      />
      {children}
    </DomainTableFrame>
  );
}

export function DomainTableFrame({
  showContainer,
  sort = null,
  onSort,
  children,
}: {
  showContainer: boolean;
  sort?: SortState<DomainColumn>;
  onSort?: (column: DomainColumn) => void;
  children: ReactNode;
}) {
  const head = (column: DomainColumn, label: string, className?: string) =>
    onSort ? (
      <SortableHead
        column={column}
        sort={sort}
        onSort={onSort}
        className={className}
      >
        {label}
      </SortableHead>
    ) : (
      <TableHead className={className}>{label}</TableHead>
    );
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <Table className="max-md:block max-md:[&_td]:whitespace-normal">
        <TableHeader className="max-md:hidden">
          <TableRow>
            {head("domain", "Domain")}
            {showContainer && head("container", "Container", "w-56")}
            {head("status", "Status")}
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
