"use client";

import * as React from "react";
import { Boxes, Layers, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { AppLogo } from "@/components/shared/project-logo";
import type { SharedVarDTO } from "@/lib/data/shared-vars/team-view";

const CHIP_LIMIT = 2;

type Chip = { key: string; name: string; icon: React.ReactNode };

const glyph = (Icon: React.ComponentType<{ className?: string }>) => (
  <Icon className="size-3 shrink-0" />
);

export function SharedWithChips({
  v,
  limit = CHIP_LIMIT,
}: {
  v: SharedVarDTO;
  limit?: number;
}) {
  const groups: Chip[][] = [
    v.teams.map((t) => ({ key: t.id, name: t.name, icon: glyph(Users) })),
    v.projects.map((p) => ({ key: p.id, name: p.name, icon: glyph(Boxes) })),
    v.environments.map((e) => ({
      key: e.id,
      name: `${e.projectName} · ${e.name}`,
      icon: glyph(Layers),
    })),
    v.apps.map((a) => ({
      key: a.id,
      name: a.name,
      icon: <AppLogo logo={a.logo} size={14} className="rounded-[3px]" />,
    })),
  ].filter((g) => g.length > 0);

  if (groups.length === 0)
    return (
      <span className="text-xs text-muted-foreground">
        Not shared with anything
      </span>
    );

  return (
    <div className="flex flex-wrap gap-1">
      {groups.map((chips, i) => {
        const shown = chips.slice(0, limit);
        const rest = chips.slice(limit);
        return (
          <React.Fragment key={i}>
            {shown.map((chip) => (
              <Badge
                key={chip.key}
                variant="muted"
                className="max-w-[14rem] gap-1 text-[10px] font-normal"
              >
                {chip.icon}
                <span className="truncate">{chip.name}</span>
              </Badge>
            ))}
            {rest.length > 0 && (
              <SimpleTooltip content={rest.map((c) => c.name).join(", ")}>
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
