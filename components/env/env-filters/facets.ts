import type * as React from "react";
import { Clock, KeyRound, Share2, UserRound } from "lucide-react";
import type { VarAuthor } from "@/lib/types/identity";
import { timestamp } from "./filtering";
import {
  FACET_NONE,
  type EnvFacet,
  type FacetOption,
  type FilterableVar,
  type SourceRow,
  type TypedVar,
} from "./types";

function authorLabel(author: VarAuthor): string {
  return author.name.trim() || author.username;
}

export function lastEditor(row: FilterableVar): VarAuthor | null {
  return row.updatedBy ?? row.createdBy ?? null;
}

export function typeFacet<T extends TypedVar>(rows: T[]): EnvFacet<T> {
  const seen = new Set(rows.map((r) => r.type));
  return {
    id: "type",
    label: "Type",
    allLabel: "All types",
    icon: KeyRound,
    info: "Secret values are encrypted at rest and never shown again; plain values are readable.",
    docs: "env.types",
    options: (["plain", "secret"] as const)
      .filter((t) => seen.has(t))
      .map((t) => ({ value: t, label: t === "plain" ? "Plain" : "Secret" })),
    match: (row, value) => row.type === value,
  };
}

function authorFacet<T extends FilterableVar>(spec: {
  rows: T[];
  id: string;
  label: string;
  info: React.ReactNode;
  pick: (row: T) => VarAuthor | null;
  persistent?: boolean;
}): EnvFacet<T> {
  const { rows, pick } = spec;
  const byId = new Map<string, VarAuthor>();
  let anonymous = false;
  for (const row of rows) {
    const author = pick(row);
    if (author) {
      if (!byId.has(author.id)) byId.set(author.id, author);
    } else {
      anonymous = true;
    }
  }
  const options: FacetOption[] = [
    ...[...byId.values()]
      .sort((a, b) => authorLabel(a).localeCompare(authorLabel(b)))
      .map((a) => ({
        value: a.id,
        label: authorLabel(a),
        hint: a.name.trim() ? `@${a.username}` : undefined,
        author: a,
      })),
    ...(anonymous ? [{ value: FACET_NONE, label: "Unknown" }] : []),
  ];
  return {
    id: spec.id,
    label: spec.label,
    allLabel: "Anyone",
    icon: UserRound,
    persistent: spec.persistent ?? true,
    searchable: true,
    info: spec.info,
    options,
    match: (row, value) =>
      value === FACET_NONE ? pick(row) == null : pick(row)?.id === value,
  };
}

export function editorFacet<T extends FilterableVar>(
  rows: T[],
  noun = "variable",
): EnvFacet<T> {
  return authorFacet({
    rows,
    id: "editor",
    label: "Modified by",
    pick: lastEditor,
    info: `Who last changed the ${noun} - the user in the “Modified by” column. Type a name straight into the box to narrow the list; pick more than one to see everything any of them touched.`,
  });
}

export function creatorFacet<T extends FilterableVar>(
  rows: T[],
  noun = "variable",
): EnvFacet<T> {
  return authorFacet({
    rows,
    id: "creator",
    label: "Added by",
    pick: (row) => row.createdBy ?? null,
    info: `Who originally added the ${noun}, even if someone else has changed it since. Type a name straight into the box to narrow the list.`,
    persistent: false,
  });
}

const DAY = 86_400_000;
const WINDOWS: { value: string; label: string; within: number }[] = [
  { value: "24h", label: "Last 24 hours", within: DAY },
  { value: "7d", label: "Last 7 days", within: 7 * DAY },
  { value: "30d", label: "Last 30 days", within: 30 * DAY },
];

export function updatedFacet<T extends FilterableVar>(): EnvFacet<T> {
  const now = Date.now();
  return {
    id: "updated",
    label: "Updated",
    allLabel: "Any time",
    icon: Clock,
    options: [
      ...WINDOWS.map((w) => ({ value: w.value, label: w.label })),
      { value: "older", label: "More than 30 days ago" },
    ],
    match: (row, value) => {
      const age = now - timestamp(row.updatedAt);
      const window = WINDOWS.find((w) => w.value === value);
      return window ? age <= window.within : age > 30 * DAY;
    },
  };
}

export function sourceFacet<T extends FilterableVar & SourceRow>(
  rows: T[],
): EnvFacet<T> {
  const options: FacetOption[] = [
    ...(rows.some((r) => r.kind === "standalone")
      ? [{ value: "standalone", label: "Standalone" }]
      : []),
    ...(rows.some((r) => r.kind === "shared")
      ? [{ value: "shared", label: "Shared" }]
      : []),
  ];
  return {
    id: "source",
    label: "Source",
    allLabel: "All sources",
    icon: Share2,
    info: "Where the variable comes from: written on the app itself, or a shared variable the app opted into.",
    docs: "env.shared",
    options,
    match: (row, value) => row.kind === value,
  };
}
