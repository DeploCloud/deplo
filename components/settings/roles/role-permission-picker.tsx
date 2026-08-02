"use client";

import * as React from "react";
import { Lock, Rocket, Database, Users, type LucideIcon } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";
import { ALL_CAPABILITIES, type Capability } from "@/lib/types";
import {
  CAPABILITY_GROUPS,
  CAPABILITY_META,
} from "@/lib/membership-shared";

/** One icon per capability group, in the group's own order. */
const GROUP_ICON: Record<string, LucideIcon> = {
  apps: Rocket,
  infrastructure: Database,
  team: Users,
};

/** Optional capabilities = everything except the always-on `view` floor. */
const OPTIONAL_COUNT = ALL_CAPABILITIES.length - 1;

/**
 * What a role is allowed to do, at two depths over ONE capability set.
 *
 * - **Simple** (the default): one switch per area — Apps & configuration,
 *   Infrastructure, Team administration. Flipping it grants or revokes every
 *   permission in that area, which is how most teams actually think about a role.
 * - **Advanced**: the same areas expanded into their individual permissions, for
 *   the role that needs to deploy but not touch domains.
 *
 * There is no second permission model behind the simple tier — both write the
 * same capabilities, so switching between them never loses a choice. `view` is
 * the always-on floor and is shown locked, never as a toggle.
 */
export function RolePermissionPicker({
  capabilities,
  onChange,
  idPrefix = "role",
  disabled = false,
}: {
  capabilities: Capability[];
  onChange: (caps: Capability[]) => void;
  idPrefix?: string;
  /** Read-only rendering (the locked Owner role). */
  disabled?: boolean;
}) {
  const enabled = React.useMemo(() => new Set(capabilities), [capabilities]);
  const [advanced, setAdvanced] = React.useState(() =>
    // Open on Advanced when the set is already a partial one no simple switch
    // could have produced — otherwise the first render would misrepresent it.
    CAPABILITY_GROUPS.some((g) => {
      const on = g.caps.filter((c) => capabilities.includes(c)).length;
      return on > 0 && on < g.caps.length;
    }),
  );

  function write(next: Set<Capability>) {
    next.add("view");
    onChange(ALL_CAPABILITIES.filter((c) => next.has(c)));
  }

  function toggleCap(cap: Capability, on: boolean) {
    if (cap === "view" || disabled) return;
    const next = new Set(capabilities);
    if (on) next.add(cap);
    else next.delete(cap);
    write(next);
  }

  function toggleGroup(caps: Capability[], on: boolean) {
    if (disabled) return;
    const next = new Set(capabilities);
    for (const c of caps) {
      if (on) next.add(c);
      else next.delete(c);
    }
    write(next);
  }

  const enabledOptional = capabilities.filter((c) => c !== "view").length;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-medium">Permissions</h3>
          <InfoTip content="Simple grants a whole area at once. Advanced opens the same areas into their individual permissions — both edit the same role, so you can switch freely." />
        </div>
        {!disabled && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Advanced</span>
            <Switch
              checked={advanced}
              onCheckedChange={setAdvanced}
              aria-label="Show individual permissions"
            />
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        {/* view — the locked, always-granted floor (never a toggle). */}
        <div
          className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
          aria-label={`View — always granted and can't be removed. ${CAPABILITY_META.view.description}`}
        >
          <Lock className="size-3.5 shrink-0" aria-hidden />
          <span>
            <span className="font-medium text-foreground/80">
              {CAPABILITY_META.view.label}
            </span>
            {" — always granted. "}
            {CAPABILITY_META.view.description}
          </span>
        </div>

        <div className="divide-y divide-border">
          {CAPABILITY_GROUPS.map((group) => {
            const Icon = GROUP_ICON[group.key] ?? Rocket;
            const on = group.caps.filter((c) => enabled.has(c)).length;
            const all = on === group.caps.length;
            const partial = on > 0 && !all;
            return (
              <div key={group.key} className="p-3">
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md",
                      on > 0
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{group.label}</span>
                      {group.caps.length > 1 && (
                        <Badge
                          variant={on === 0 ? "muted" : partial ? "outline" : "secondary"}
                          className="tabular-nums"
                        >
                          {on}/{group.caps.length}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs leading-snug text-muted-foreground">
                      {group.description}
                    </p>
                  </div>
                  <Switch
                    checked={all}
                    disabled={disabled}
                    onCheckedChange={(v) => toggleGroup(group.caps, v === true)}
                    aria-label={group.label}
                    className={cn("mt-0.5", partial && "opacity-70")}
                  />
                </div>

                {/* A one-permission area IS its switch — repeating it as a lone
                    checkbox underneath would be the same control twice. */}
                {advanced && group.caps.length > 1 && (
                  <div className="mt-2 space-y-0.5 pl-11">
                    {group.caps.map((cap) => {
                      const meta = CAPABILITY_META[cap];
                      const id = `${idPrefix}-${cap}`;
                      return (
                        <label
                          key={cap}
                          htmlFor={id}
                          className={cn(
                            "flex items-start gap-2.5 rounded-md px-2 py-1.5 transition-colors",
                            disabled
                              ? "cursor-default"
                              : "cursor-pointer hover:bg-accent",
                          )}
                        >
                          <Checkbox
                            id={id}
                            checked={enabled.has(cap)}
                            disabled={disabled}
                            onCheckedChange={(v) => toggleCap(cap, v === true)}
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium leading-tight">
                              {meta.label}
                            </span>
                            <span className="block text-xs leading-snug text-muted-foreground">
                              {meta.description}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <p
        aria-live="polite"
        className="text-right text-xs font-medium tabular-nums text-muted-foreground"
      >
        {enabledOptional} of {OPTIONAL_COUNT} permissions granted
      </p>
    </section>
  );
}
