import { notFound } from "next/navigation";
import Link from "next/link";
import { SlidersHorizontal, SquareTerminal } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { hasAppCapability } from "@/lib/data/node-access";
import { listAppCronJobs } from "@/lib/data/crons";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DangerSettings } from "@/components/apps/settings/danger-settings";
import { RebuildContainerCard } from "@/components/apps/settings/rebuild-container-card";
import { CronSettingsForm } from "@/components/crons/cron-settings-form";
import { Button } from "@/components/ui/button";
import {
  CapabilityFieldset,
  CapabilityTip,
} from "@/components/apps/app-capabilities";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata = { title: "Advanced" };

/**
 * Advanced app settings: the powerful, less-everyday controls in one place — the
 * Advanced features card (the container Console and Cron jobs), a from-scratch
 * container Rebuild, and the Danger Zone (transfer to another team, delete).
 */
export default async function AppAdvancedSettingsPage(
  props: PageProps<"/apps/[slug]/settings/advanced">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  // The console page refuses without this, so the way in says so up front instead of
  // leading to a 404.
  const [canConsole, canCron] = await Promise.all([
    hasAppCapability(project.id, "open_app_console"),
    hasAppCapability(project.id, "manage_crons"),
  ]);
  const cron = canCron ? await listAppCronJobs(project.id) : null;

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={SlidersHorizontal}
        title="Advanced"
        docs="build.advanced"
        info="Turn on the advanced features, rebuild the container from scratch, hand the app to another team, or permanently delete it."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Advanced features</CardTitle>
          <CardDescription>
            Powerful extras, off the everyday path until you need them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
            <div className="min-w-56 flex-1 space-y-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                <SquareTerminal className="size-4 text-muted-foreground" />
                Console
              </p>
              <p className="text-sm text-muted-foreground">
                Open a terminal in the running container, or attach to its live
                output. No SSH needed.
              </p>
            </div>
            {canConsole ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/apps/${slug}/console`}>Open console</Link>
              </Button>
            ) : (
              <CapabilityTip cap="open_app_console">
                <Button size="sm" variant="outline" disabled>
                  Open console
                </Button>
              </CapabilityTip>
            )}
          </div>

          <CapabilityFieldset cap="manage_crons">
            <CronSettingsForm
              targetKind="app"
              targetId={project.id}
              enabled={cron?.enabled ?? project.cronEnabled}
              jobCount={cron?.jobs.length ?? 0}
            />
          </CapabilityFieldset>
        </CardContent>
      </Card>

      <RebuildContainerCard appId={project.id} slug={slug} />

      <DangerSettings appId={project.id} name={project.name} />
    </section>
  );
}
