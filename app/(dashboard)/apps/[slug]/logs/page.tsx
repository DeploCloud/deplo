// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { getLogsInfo } from "@/lib/data/console";
import { hasAppCapability } from "@/lib/data/node-access";
import { EmptyState } from "@/components/shared/empty-state";
import { LiveLogs } from "@/components/apps/live-logs";
import { DEFAULT_LOG_RANGE_DAYS } from "@/lib/types";

export const metadata = { title: "Logs" };

export default async function AppLogsPage(
  props: PageProps<"/apps/[slug]/logs">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  // Held per app (ADR-0016). Without it every stream below answers nothing, so
  // say why instead of rendering an empty log viewer.
  if (!(await hasAppCapability(project.id, "view_logs"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to logs"
        docs="roles.floorCeiling"
        description="You don't have permission to read this app's logs. Ask a team admin for the “View logs” permission."
      />
    );
  }

  // Reuse the console's instance discovery: the same containers, the app's own one
  // first, so the logs picker matches the console's.
  const info = await getLogsInfo(project.id);

  // No title, no description, no padding: this route is full-bleed (see
  // components/layout/shell-frame.tsx) and the pane fills the frame.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/**
       * Seeded with whatever containers the host has, running or not: `docker logs`
       * outlives the process, so a dead or restarting container still streams.
       */}
      <LiveLogs
        appId={project.id}
        title={{ label: project.name, href: `/apps/${project.slug}` }}
        initialInstances={info?.instances ?? []}
        initialStreamable={!!info?.streamable}
        initialUnreachable={!!info?.unreachable}
        initialSupportsTimeline={!!info?.supportsTimeline}
        initialLogMaxDays={info?.logMaxDays ?? DEFAULT_LOG_RANGE_DAYS}
        deploymentsHref={`/apps/${project.slug}/deployments`}
      />
    </div>
  );
}
