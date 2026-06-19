"use client";

import * as React from "react";
import { Search, ChevronRight, Database, Pencil, Play } from "lucide-react";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/shared/copy-button";
import { ScopeBadge } from "./scope-badge";
import { holdsScope, exampleFor } from "./examples";
import { schemaExampleFor } from "./graphql-language";
import { cn } from "@/lib/utils";
import type { GraphQLSchema } from "graphql";
import type { Capability } from "@/lib/types";
import type { ApiCatalog, ApiFieldDoc } from "./types";

/**
 * The searchable GraphQL reference. Lists every query and mutation grouped by
 * domain, each expandable to show its arguments, return type, required scope and
 * a copyable example operation. A "Try" affordance hands the example to the
 * playground via `onTry`.
 */
export function ApiReference({
  catalog,
  capabilities,
  isInstanceAdmin,
  schema,
  onTry,
}: {
  catalog: ApiCatalog;
  capabilities: Capability[];
  isInstanceAdmin: boolean;
  /** Rebuilt client schema, used to generate always-valid examples. */
  schema: GraphQLSchema | null;
  onTry: (operation: string) => void;
}) {
  const [search, setSearch] = React.useState("");
  const [tab, setTab] = React.useState<"query" | "mutation">("query");

  const fields = tab === "query" ? catalog.queries : catalog.mutations;

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return fields;
    return fields.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.group.toLowerCase().includes(q) ||
        (f.description?.toLowerCase().includes(q) ?? false),
    );
  }, [fields, search]);

  const groups = React.useMemo(() => {
    const map = new Map<string, ApiFieldDoc[]>();
    for (const f of filtered) {
      const arr = map.get(f.group) ?? [];
      arr.push(f);
      map.set(f.group, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex rounded-lg border border-border p-0.5">
          <TabButton
            active={tab === "query"}
            onClick={() => setTab("query")}
            icon={<Database className="size-3.5" />}
            label={`Queries (${catalog.queries.length})`}
          />
          <TabButton
            active={tab === "mutation"}
            onClick={() => setTab("mutation")}
            icon={<Pencil className="size-3.5" />}
            label={`Mutations (${catalog.mutations.length})`}
          />
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${tab === "query" ? "queries" : "mutations"}…`}
            className="pl-8"
          />
        </div>
      </div>

      {tab === "mutation" && (
        <p className="rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 px-3 py-2 text-xs text-muted-foreground">
          In the playground, mutations never run — they are simulated as a{" "}
          <span className="font-medium text-foreground">dry run</span> and gated
          by your own capabilities. From the real API (with a token), they
          execute for real.
        </p>
      )}

      <div className="space-y-6">
        {groups.length === 0 && (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No {tab === "query" ? "queries" : "mutations"} match “{search}”.
          </p>
        )}
        {groups.map(([group, items]) => (
          <div key={group} className="space-y-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group}
            </h3>
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {items.map((field) => (
                <FieldRow
                  key={field.name}
                  field={field}
                  held={holdsScope(field.scope, capabilities, isInstanceAdmin)}
                  schema={schema}
                  onTry={onTry}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function FieldRow({
  field,
  held,
  schema,
  onTry,
}: {
  field: ApiFieldDoc;
  held: boolean;
  schema: GraphQLSchema | null;
  onTry: (operation: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  // Prefer a schema-generated example (always valid — correct enum/input args
  // and sub-selections); fall back to the string heuristic without a schema.
  const example = React.useMemo(
    () =>
      (schema && schemaExampleFor(schema, field.name, field.operation)) ||
      exampleFor(field),
    [schema, field],
  );

  return (
    <div className="bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-secondary/30"
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <code className="font-mono text-sm font-medium">{field.name}</code>
        <code className="hidden truncate font-mono text-xs text-muted-foreground sm:inline">
          : {field.returnType}
        </code>
        <div className="ml-auto shrink-0">
          <ScopeBadge scope={field.scope} held={held} />
        </div>
      </button>

      {open && (
        <div className="space-y-4 border-t border-border bg-secondary/20 px-3 py-3 pl-10">
          {field.description && (
            <p className="text-sm text-muted-foreground">{field.description}</p>
          )}

          <div className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
            <span className="text-muted-foreground">Returns</span>
            <code className="font-mono">{field.returnType}</code>
            <span className="text-muted-foreground">Requires</span>
            <span className="flex items-center gap-2">
              <ScopeBadge scope={field.scope} held={held} />
              {!held && (
                <span className="text-muted-foreground">
                  (you don’t currently hold this)
                </span>
              )}
            </span>
          </div>

          {field.args.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                Arguments
              </p>
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-xs">
                  <tbody className="divide-y divide-border">
                    {field.args.map((arg) => (
                      <tr key={arg.name} className="align-top">
                        <td className="whitespace-nowrap px-3 py-1.5 font-mono font-medium">
                          {arg.name}
                          {arg.required && (
                            <span className="text-[var(--destructive)]">*</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted-foreground">
                          {arg.type}
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {arg.description ?? ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">
                Example
              </p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onTry(example)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-secondary"
                >
                  <Play className="size-3" />
                  Try it
                </button>
                <CopyButton value={example} />
              </div>
            </div>
            <pre className="overflow-x-auto rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs">
              {example}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
