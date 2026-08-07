import { notFound } from "next/navigation";

import { getAppBySlug } from "@/lib/data/apps";
import { hasAppCapability } from "@/lib/data/node-access";
import { listAppCronJobs } from "@/lib/data/crons";
import { CronJobsList } from "@/components/crons/cron-jobs-list";
import { EmptyState } from "@/components/shared/empty-state";
import { Lock } from "lucide-react";

export const metadata = { title: "Cron jobs" };

/**
 * The operational page: what is scheduled on this app, and what each one did.
 *
 * Reachable only once the switch in Settings is on (the sidebar entry appears
 * with it), so the "off" branch below is for the person who kept the URL — it
 * points at the switch rather than pretending the page is broken.
 */
export default async function AppCronJobsPage(
  props: PageProps<"/apps/[slug]/cron-jobs">,
) {
  const { slug } = await props.params;
  const app = await getAppBySlug(slug);
  if (!app) notFound();

  const canManage = await hasAppCapability(app.id, "manage_crons");
  if (!canManage) {
    return (
      <EmptyState
        icon={Lock}
        title="You cannot manage cron jobs"
        description={`Ask an admin for the "Manage cron jobs" permission on this app.`}
      />
    );
  }

  const view = await listAppCronJobs(app.id);
  return (
    <CronJobsList
      targetKind="app"
      targetId={app.id}
      enabled={view.enabled}
      jobs={view.jobs}
      services={view.services}
      canManage
      settingsHref={`/apps/${slug}/settings/cron-jobs`}
    />
  );
}
