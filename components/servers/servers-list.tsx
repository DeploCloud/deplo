"use client";

import * as React from "react";
import { Server as ServerIcon } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { ListToolbar } from "@/components/shared/list-toolbar";
import { titleClass } from "@/components/shared/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SERVER_USES,
  SERVER_USE_IDS,
  type ServerUse,
} from "./server-role-badge";

export type ServerListItem = {
  id: string;
  /** Name, host and IP, lowercased - everything the search box matches on. */
  search: string;
  use: ServerUse;
  /** The card, rendered on the server so the cards stay RSC. */
  card: React.ReactNode;
};

/**
 * The fleet, searchable and filtered by what each server is for. Migration
 * sources stay in their own section: they are another platform's machines,
 * borrowed for one import.
 */
export function ServersList({ items }: { items: ServerListItem[] }) {
  const [query, setQuery] = React.useState("");
  const [use, setUse] = React.useState<ServerUse | "all">("all");

  const q = query.trim().toLowerCase();
  const shown = items.filter(
    (i) => (use === "all" || i.use === use) && (!q || i.search.includes(q)),
  );
  const fleet = shown.filter((i) => i.use !== "import");
  const sources = shown.filter((i) => i.use === "import");

  return (
    <div className="space-y-4">
      {/* One server needs no search box. */}
      {items.length > 1 && (
        <ListToolbar
          query={query}
          onQuery={setQuery}
          placeholder="Search servers"
          filters={
            <Select
              value={use}
              onValueChange={(v) => setUse(v as ServerUse | "all")}
            >
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All servers</SelectItem>
                {SERVER_USE_IDS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {SERVER_USES[id].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      )}

      {shown.length === 0 ? (
        <EmptyState
          icon={ServerIcon}
          title="No matching servers"
          description="No server matches the current search and filter."
        />
      ) : (
        <>
          {fleet.length > 0 && (
            <div className="grid items-start gap-4 sm:grid-cols-2">
              {fleet.map((i) => (
                <React.Fragment key={i.id}>{i.card}</React.Fragment>
              ))}
            </div>
          )}
          {sources.length > 0 && (
            <div>
              <h2 className={titleClass.section}>Migration sources</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Only used to import from another platform.
              </p>
              <div className="mt-3 grid items-start gap-4 sm:grid-cols-2">
                {sources.map((i) => (
                  <React.Fragment key={i.id}>{i.card}</React.Fragment>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
