import { notFound } from "next/navigation";
import { Timer } from "lucide-react";

import { getAppBySlug } from "@/lib/data/apps";
import { hasAppCapability } from "@/lib/data/node-access";
import { listAppCronJobs } from "@/lib/data/crons";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";
import { CronSettingsForm } from "@/components/crons/cron-settings-form";

export const metadata = { title: "Cron jobs" };

/**
 * Settings → Cron jobs: the opt-in switch, and nothing else.
 *
 * There is no second card here on purpose. Everything a cron job can be
 * configured with belongs to ONE job — two jobs on the same app legitimately
 * want different schedules, shells, timeouts and zones — so a target-level
 * default would be a knob whose only purpose is to be overridden. What this page
 * owns is the decision to have the feature at all, which is exactly what the
 * Pull requests page owns for previews.
 */
export default async function AppCronSettingsPage(
  props: PageProps<"/apps/[slug]/settings/cron-jobs">,
) {
  const { slug } = await props.params;
  const app = await getAppBySlug(slug);
  if (!app) notFound();

  // Checked BEFORE the read: `listAppCronJobs` is gated and throws, which would
  // take the whole page down for someone who cannot manage cron jobs but is
  // legitimately reading the rest of Settings.
  const canManage = await hasAppCapability(app.id, "manage_crons");
  const view = canManage ? await listAppCronJobs(app.id) : null;

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={Timer}
        title="Cron jobs"
        info="Run a command inside this app's container on a schedule, with its own timezone, timeout and retries."
      />
      <CapabilityFieldset cap="manage_crons">
        <CronSettingsForm
          targetKind="app"
          targetId={app.id}
          enabled={view?.enabled ?? app.cronEnabled}
          jobCount={view?.jobs.length ?? 0}
        />
      </CapabilityFieldset>
    </section>
  );
}
