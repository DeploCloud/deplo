"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { TableHead } from "@/components/ui/table";

export type SortDir = "asc" | "desc";
export type SortValue = string | number | boolean | null | undefined;
export type SortState<K extends string> = { key: K; dir: SortDir } | null;

const isEmpty = (v: SortValue) => v === null || v === undefined || v === "";

function compare(a: SortValue, b: SortValue): number {
  if (typeof a !== "string" && typeof b !== "string")
    return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

// Empty values sink in both directions, and equal rows keep their order.
export function sortRows<T>(
  rows: readonly T[],
  value: (row: T) => SortValue,
  dir: SortDir,
): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, v: value(row), i }))
    .sort((a, b) => {
      const ea = isEmpty(a.v);
      const eb = isEmpty(b.v);
      if (ea || eb) return Number(ea) - Number(eb) || a.i - b.i;
      return sign * compare(a.v, b.v) || a.i - b.i;
    })
    .map((x) => x.row);
}

// The first click puts the biggest number on top and text from A; the next one reverses it.
export function nextSort<T, K extends string>(
  prev: SortState<K>,
  key: K,
  rows: readonly T[],
  value: (row: T) => SortValue,
): { key: K; dir: SortDir } {
  if (prev?.key === key)
    return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
  const sample = rows.map(value).find((v) => !isEmpty(v));
  return { key, dir: typeof sample === "number" ? "desc" : "asc" };
}

export function useTableSort<T, K extends string>(
  rows: readonly T[],
  columns: Record<K, (row: T) => SortValue>,
) {
  const [sort, setSort] = React.useState<SortState<K>>(null);
  return {
    rows: sort ? sortRows(rows, columns[sort.key], sort.dir) : [...rows],
    sort,
    toggle: (key: K) =>
      setSort((prev) => nextSort(prev, key, rows, columns[key])),
  };
}

type SortProps<K extends string> = {
  column: K;
  sort: SortState<K>;
  onSort: (key: K) => void;
  align?: "left" | "right";
  children: React.ReactNode;
};

export function SortButton<K extends string>({
  column,
  sort,
  onSort,
  align,
  children,
}: SortProps<K>) {
  const dir = sort?.key === column ? sort.dir : null;
  const Icon =
    dir === "asc" ? ArrowUp : dir === "desc" ? ArrowDown : ArrowUpDown;
  return (
    <button
      type="button"
      onClick={() => onSort(column)}
      className={cn(
        "group/sort -mx-1.5 inline-flex cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        dir && "text-foreground",
        align === "right" && "flex-row-reverse",
      )}
    >
      {children}
      <Icon
        aria-hidden
        className={cn(
          "size-3 shrink-0 transition-opacity",
          !dir && "opacity-0 group-hover/sort:opacity-60",
        )}
      />
    </button>
  );
}

export function ariaSort<K extends string>(sort: SortState<K>, column: K) {
  if (sort?.key !== column) return "none" as const;
  return sort.dir === "asc" ? ("ascending" as const) : ("descending" as const);
}

export function SortableHead<K extends string>({
  className,
  ...props
}: SortProps<K> & { className?: string }) {
  return (
    <TableHead
      aria-sort={ariaSort(props.sort, props.column)}
      className={cn(props.align === "right" && "text-right", className)}
    >
      <SortButton {...props} />
    </TableHead>
  );
}
