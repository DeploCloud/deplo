"use client";

import { Badge } from "@/components/ui/badge";
import { VOLUME_KINDS } from "@/lib/apps/volume-model";
import type { ComposeMount } from "@/lib/apps/compose-storage";
import { KIND_ICON } from "./kind-picker";

export function ComposeMountList({ mounts }: { mounts: ComposeMount[] }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-sm font-medium">From docker-compose.yml</p>
      <p className="mt-1 text-xs text-muted-foreground">
        This app&apos;s compose file mounts these itself. Edit it under
        Deployments to change them.
      </p>
      <ul
        className="mt-3 space-y-2"
        aria-label="Storage the compose file mounts"
      >
        {mounts.map((m) => {
          const Icon = KIND_ICON[m.kind];
          return (
            <li
              key={`${m.kind}:${m.source}:${m.mountPath}`}
              className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
            >
              <Badge variant="muted" className="shrink-0 gap-1.5">
                <Icon className="size-3" />
                {VOLUME_KINDS[m.kind].label}
              </Badge>
              <span className="min-w-0 truncate font-mono text-xs text-foreground">
                {m.source}
                <span className="px-1.5 text-muted-foreground">→</span>
                {m.mountPath}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
