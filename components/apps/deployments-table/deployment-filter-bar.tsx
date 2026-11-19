"use client";

import type * as React from "react";
import {
  AppWindow,
  ArrowUpDown,
  CalendarClock,
  CircleDot,
  Server,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ListToolbar } from "@/components/shared/list-toolbar";
import { AppLogo } from "@/components/shared/project-logo";
import { STATUS_LABELS } from "./deployment-status";
import type { DeploymentFilters } from "./use-deployment-filters";

export function DeploymentFilterBar({
  filters,
  action,
}: {
  filters: DeploymentFilters;
  action?: React.ReactNode;
}) {
  const { picked, counts, applyFacet } = filters;
  return (
    <ListToolbar
      query={filters.query}
      onQuery={filters.applyQuery}
      placeholder="Search deployments"
      onClear={filters.clearFacets}
      facets={[
        {
          id: "server",
          label: "Server",
          icon: Server,
          options: filters.serverOptions.map((s) => ({
            value: s.id,
            label: s.name,
          })),
          values: picked.server,
          counts: counts.server,
          onChange: (v) => applyFacet("server", v),
          searchable: true,
        },
        {
          id: "app",
          label: "App",
          icon: AppWindow,
          options: filters.appOptions.map((a) => ({
            value: a.id,
            label: a.name,
            leading: <AppLogo logo={a.logo ?? null} size={16} />,
          })),
          values: picked.app,
          counts: counts.app,
          onChange: (v) => applyFacet("app", v),
          searchable: true,
        },
        {
          id: "status",
          label: "Status",
          icon: CircleDot,
          options: filters.statusOptions.map((s) => ({
            value: s,
            label: STATUS_LABELS[s],
          })),
          values: picked.status,
          counts: counts.status,
          onChange: (v) => applyFacet("status", v),
        },
        {
          id: "date",
          label: "Created",
          icon: CalendarClock,
          options: filters.dateOptions,
          values: picked.date,
          counts: counts.date,
          onChange: (v) => applyFacet("date", v),
        },
      ]}
      sort={
        <Select value={filters.sortDir} onValueChange={filters.applySort}>
          <SelectTrigger
            className="w-[150px] shrink-0"
            aria-label="Sort by created date"
          >
            <span className="flex! items-center gap-2">
              <ArrowUpDown className="size-3.5 shrink-0 text-muted-foreground" />
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
          </SelectContent>
        </Select>
      }
      action={action}
    />
  );
}
