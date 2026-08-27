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
      {SOURCE_TABS.map((tab) => {
        const Icon = tab.icon;
        return (
          <KindCard
            key={tab.id}
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
