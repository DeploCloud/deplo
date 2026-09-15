"use client";

import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { ServerRoleHint } from "@/components/shared/server-role-hint";
import type { PlanService, ServerChoice } from "../types";

const AUTOMATIC = "__automatic__";

export function RunSelect({
  id,
  servers,
  value,
  onChange,
  placeholder,
  className,
  label,
}: {
  id?: string;
  servers: ServerChoice[];
  value: string | undefined;
  onChange: (serverId: string) => void;
  placeholder?: string;
  className?: string;
  label?: string;
}) {
  return (
    <Select value={value ?? ""} onValueChange={onChange}>
      <SelectTrigger
        id={id}
        aria-label={label}
        className={cn("h-8 w-full [&_[data-hint]]:hidden", className)}
      >
        <SelectValue placeholder={placeholder ?? "Choose a server"} />
      </SelectTrigger>
      <SelectContent>
        {servers.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{s.name}</span>
              <ServerRoleHint isDeploHost={s.isDeploHost} />
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function BuildSelect({
  id,
  servers,
  value,
  onChange,
  placeholder,
  className,
  label,
}: {
  id?: string;
  servers: ServerChoice[];
  value: string | null | undefined;
  onChange: (buildServerId: string | null) => void;
  placeholder?: string;
  className?: string;
  label?: string;
}) {
  return (
    <Select
      value={value === undefined ? "" : (value ?? AUTOMATIC)}
      onValueChange={(v) => onChange(v === AUTOMATIC ? null : v)}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        className={cn("h-8 w-full [&_[data-hint]]:hidden", className)}
      >
        <SelectValue placeholder={placeholder ?? "Automatic"} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTOMATIC}>Automatic</SelectItem>
        <SelectSeparator />
        {servers.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{s.name}</span>
              <ServerRoleHint isDeploHost={s.isDeploHost} />
              {s.buildOnly && (
                <span data-hint className="text-xs text-muted-foreground">
                  Build only
                </span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function NothingToBuild({ service }: { service: PlanService }) {
  return (
    <SimpleTooltip
      content={
        service.kind === "compose"
          ? "A compose stack runs the images it names, so Deplo builds nothing for it."
          : "Deployed from a prebuilt image, so Deplo builds nothing for it."
      }
    >
      <span
        id={`imp-nobuild-${service.sourceId}`}
        className="flex h-8 cursor-default items-center justify-center text-sm text-muted-foreground"
      >
        -
      </span>
    </SimpleTooltip>
  );
}
