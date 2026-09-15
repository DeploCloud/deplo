import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { hasAppCapability } from "@/lib/data/node-access";
import { getConsoleInfo } from "@/lib/data/console";
import { LiveConsole } from "@/components/apps/live-console";

export const metadata = { title: "Console" };

export default async function AppConsolePage(
  props: PageProps<"/[team]/apps/[slug]/console">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  if (!project.consoleEnabled) notFound();
  if (!(await hasAppCapability(project.id, "open_app_console"))) notFound();

  const info = await getConsoleInfo(project.id);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LiveConsole
        appId={project.id}
        title={{
          label: project.name,
          href: `/apps/${project.slug}`,
          settingsHref: `/apps/${project.slug}/settings/advanced`,
        }}
        initialInfo={
          info?.running
            ? { containerName: info.containerName, instances: info.instances }
            : null
        }
        initialRunning={!!info?.running}
      />
    </div>
  );
}
