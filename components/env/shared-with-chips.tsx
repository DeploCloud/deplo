"use client";

import * as React from "react";
import { AppWindow, Boxes, Layers, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { SharedVarDTO } from "@/lib/data/shared-vars";

/** How many named scopes a chip row spells out before it starts counting. */
const CHIP_LIMIT = 2;

/**
 * WHO a shared variable is available to (and which apps added it), BY NAME —
 * not by count. "2 projects" made you open the editor to find out which two,
 * and who can use the variable is the whole point of the Shared tab. Scopes
 * are availability only — each app opts in itself (ADR-0012).
 *
 * `limit` caps how many names each group spells out before folding the rest into
 * a "+N" chip that names them in its tooltip: a table cell is tight (2), the edit
 * dialog — where the chips exist to VOUCH that the save leaves the scope alone —
 * is not, and passes Infinity.
 */
export function SharedWithChips({
  v,
  limit = CHIP_LIMIT,
}: {
  v: SharedVarDTO;
  limit?: number;
}) {
  const groups: {
    icon: React.ComponentType<{ className?: string }>;
    names: string[];
  }[] = [
    ...(v.teamWide ? [{ icon: Users, names: ["The whole team"] }] : []),
    ...(v.projects.length > 0
      ? [{ icon: Boxes, names: v.projects.map((p) => p.name) }]
      : []),
    ...(v.environments.length > 0
      ? [
          {
            icon: Layers,
            names: v.environments.map((e) => `${e.projectName} · ${e.name}`),
          },
        ]
      : []),
    ...(v.apps.length > 0
      ? [{ icon: AppWindow, names: v.apps.map((a) => a.name) }]
      : []),
  ];

  return (
    <div className="flex flex-wrap gap-1">
      {groups.map(({ icon: Icon, names }, i) => {
        const shown = names.slice(0, limit);
        const rest = names.slice(limit);
        return (
          <React.Fragment key={i}>
            {shown.map((name) => (
              <Badge
                key={name}
                variant="muted"
                className="max-w-[14rem] gap-1 text-[10px] font-normal"
              >
                <Icon className="size-3 shrink-0" />
                <span className="truncate">{name}</span>
              </Badge>
            ))}
            {rest.length > 0 && (
              <SimpleTooltip content={rest.join(", ")}>
                <Badge variant="muted" className="text-[10px] font-normal">
                  +{rest.length}
                </Badge>
              </SimpleTooltip>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
