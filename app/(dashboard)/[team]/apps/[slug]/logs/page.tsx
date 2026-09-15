import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { getLogsInfo } from "@/lib/data/console";
import { hasAppCapability } from "@/lib/data/node-access";
import { EmptyState } from "@/components/shared/empty-state";
import { LiveLogs } from "@/components/apps/live-logs";
import { DEFAULT_LOG_RANGE_DAYS } from "@/lib/types/deployment";

export const metadata = { title: "Logs" };

export default async function AppLogsPage(
  props: PageProps<"/[team]/apps/[slug]/logs">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

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

  const info = await getLogsInfo(project.id);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
