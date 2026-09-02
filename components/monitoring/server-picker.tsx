"use client";

import * as React from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Command as CommandPrimitive } from "cmdk";
import { Button } from "@/components/ui/button";
import { Command, CommandItem, CommandList } from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusDot } from "@/components/shared/status-badge";
import type { FleetRow } from "@/components/monitoring/fleet-list";
import type { ServerStatus } from "@/lib/types";
import { cn, serverLabel } from "@/lib/utils";
import { ServerRoleHint } from "@/components/shared/server-role-hint";

export interface PickableServer {
  id: string;
  name: string;
  status: ServerStatus;
  ip: string;
  isDeploHost: boolean;
}

/**
 * Which host the panels below belong to, and how to change it. It replaces the
 * plain name that used to sit here rather than adding a control: the list below
 * stays the fleet's overview, this is the jump.
 */
export function ServerPicker({
  servers,
  rows,
  selectedId,
  onSelect,
}: {
  servers: PickableServer[];
  /** Live readings, so a host can be picked on how it is doing, not just its name. */
  rows: Record<string, FleetRow>;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = servers.find((s) => s.id === selectedId);
  if (!selected) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label="Server"
          className="gap-2"
        >
          <StatusDot status={selected.status} />
          <span className="font-medium">{serverLabel(selected)}</span>
          <ChevronsUpDown className="size-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <CommandPrimitive.Input
              placeholder="Search servers"
              className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <CommandList className="max-h-72 p-1">
            <CommandPrimitive.Empty className="py-6 text-center text-sm text-muted-foreground">
              No server found
            </CommandPrimitive.Empty>
            {servers.map((s) => {
              const row = rows[s.id];
              const measured = Boolean(row && row.ts > 0);
              return (
                <CommandItem
                  key={s.id}
                  // Both, so an address is as searchable as a name.
                  value={`${s.name} ${s.ip}`}
                  onSelect={() => {
                    onSelect(s.id);
                    setOpen(false);
                  }}
                >
                  <StatusDot status={s.status} />
                  <span className="flex-1 truncate">{serverLabel(s)}</span>
                  <ServerRoleHint isDeploHost={s.isDeploHost} />
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {measured
                      ? `${row.cpu.toFixed(0)}% · ${row.memPct.toFixed(0)}%`
                      : "No data"}
                  </span>
                  <Check
                    className={cn(
                      "size-4 shrink-0",
                      s.id !== selectedId && "invisible",
                    )}
                  />
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
