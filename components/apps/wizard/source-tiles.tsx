"use client";

import { Badge } from "@/components/ui/badge";
import { KindCard } from "@/components/shared/kind-card";
import { SOURCE_TABS } from "@/components/apps/source-tabs";
import type { DeploySource } from "@/lib/types";

/** The bento of deploy sources - the wizard's first and only unavoidable choice. */
export function SourceTiles({
  value,
  onSelect,
}: {
  value: DeploySource | null;
  onSelect: (source: DeploySource) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Source"
      className="grid gap-2 sm:grid-cols-2"
    >
      {SOURCE_TABS.map((tab, i) => {
        const Icon = tab.icon;
        // An odd count leaves the last tile alone on its row; widening it is
        // what makes the grid read as finished rather than one short.
        const wide =
          i === SOURCE_TABS.length - 1 && SOURCE_TABS.length % 2 === 1;
        return (
          <KindCard
            key={tab.id}
            className={wide ? "sm:col-span-2" : undefined}
            selected={value === tab.id}
            onSelect={() => onSelect(tab.id)}
            icon={<Icon className="size-4" />}
            title={tab.label}
            caption={tab.blurb}
            badge={
              tab.id === "git" ? (
                <Badge variant="info" className="ml-auto">
                  Beta
                </Badge>
              ) : undefined
            }
          />
        );
      })}
    </div>
  );
}
