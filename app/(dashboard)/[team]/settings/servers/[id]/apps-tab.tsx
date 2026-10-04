"use client";

import { AppWindow } from "lucide-react";

import Link from "@/components/ui/link";
import { EmptyState } from "@/components/shared/empty-state";
import { AppLogo } from "@/components/shared/project-logo";
import type { ServerRunningApp } from "@/lib/data/servers/running-apps";

export function ServerAppsTab({ apps }: { apps: ServerRunningApp[] }) {
  if (apps.length === 0)
    return (
      <EmptyState
        icon={AppWindow}
        title="Nothing running here"
        description="Apps deployed to this server show up here while they run."
      />
    );

  return (
    <div className="divide-y divide-border rounded-lg border border-border bg-card">
      {apps.map((app) => {
        const row = (
          <>
            <AppLogo logo={app.logo} tone={app.logoTone} size={32} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{app.name}</div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {app.teamName}
              </div>
            </div>
          </>
        );
        return app.teamSlug ? (
          <Link
            key={app.id}
            href={`/${app.teamSlug}/apps/${app.slug}`}
            className="flex items-center gap-3 p-3 hover:bg-surface"
          >
            {row}
          </Link>
        ) : (
          <div key={app.id} className="flex items-center gap-3 p-3">
            {row}
          </div>
        );
      })}
    </div>
  );
}
