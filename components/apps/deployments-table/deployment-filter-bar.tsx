"use client";

import { ListFilter, ArrowUpDown, CalendarClock, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { STATUS_LABELS } from "./deployment-status";
import { ALL, type DeploymentFilters } from "./use-deployment-filters";

// DeploymentFilterBar is the search box, the narrowers and the Created sort, on
// one wrapping row.
export function DeploymentFilterBar({
  filters,
}: {
  filters: DeploymentFilters;
}) {
  const {
    query,
    sortDir,
    serverOptions,
    appOptions,
    statusOptions,
    dateOptions,
    effectiveServerFilter,
    effectiveAppFilter,
    effectiveStatusFilter,
    effectiveDateFilter,
    hasFilter,
    applyServerFilter,
    applyAppFilter,
    applyStatusFilter,
    applyDateFilter,
    applyQuery,
    applySort,
    clearFilters,
    showServerFilter,
    showAppFilter,
    showStatusFilter,
    showDateFilter,
    showSearch,
    showSort,
    showNarrowers,
  } = filters;

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-2">
      {showSearch && (
        <div className="relative w-full min-w-0 sm:w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => applyQuery(e.target.value)}
            placeholder="Search deployments"
            aria-label="Search deployments"
            className="h-9 pl-9"
          />
        </div>
      )}
      {showNarrowers && <ListFilter className="size-4 text-muted-foreground" />}
      {showServerFilter && (
        <Select
          value={effectiveServerFilter ?? ALL}
          onValueChange={applyServerFilter}
        >
          <SelectTrigger className="w-[170px]" aria-label="Filter by server">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All servers</SelectItem>
            {serverOptions.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {showAppFilter && (
        <Select
          value={effectiveAppFilter ?? ALL}
          onValueChange={applyAppFilter}
        >
          <SelectTrigger className="w-[180px]" aria-label="Filter by app">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All apps</SelectItem>
            {appOptions.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {showStatusFilter && (
        <Select
          value={effectiveStatusFilter ?? ALL}
          onValueChange={applyStatusFilter}
        >
          <SelectTrigger className="w-[150px]" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All statuses</SelectItem>
            {statusOptions.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {showDateFilter && (
        <Select
          value={effectiveDateFilter ?? ALL}
          onValueChange={applyDateFilter}
        >
          <SelectTrigger
            className="w-[205px]"
            aria-label="Filter by created date"
          >
            {/* Same `flex!` trick as the sort trigger below - see the note there
                for why the plain class loses to `line-clamp-1`. */}
            <span className="flex! items-center gap-2">
              <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any time</SelectItem>
            {dateOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {hasFilter && (
        <Button variant="ghost" onClick={clearFilters}>
          Clear filters
        </Button>
      )}
      {showSort && (
        <div
          className={cn(
            "flex items-center gap-2",
            showNarrowers && "sm:ml-auto",
          )}
        >
          {showSort && (
            <Select value={sortDir} onValueChange={applySort}>
              <SelectTrigger
                className="w-[150px]"
                aria-label="Sort by created date"
              >
                {/* `flex!` is load-bearing: SelectTrigger's `[&>span]:line-clamp-1`
                    sets `display:-webkit-box` on direct-child spans and outranks a
                    plain `flex`, stacking the icon above the value. */}
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
          )}
        </div>
      )}
    </div>
  );
}
