import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps";
import { hasAppCapability } from "@/lib/data/node-access";
import { getConsoleInfo } from "@/lib/data/console";
import { LiveConsole } from "@/components/apps/live-console";

export const metadata = { title: "Console" };

export default async function AppConsolePage(
  props: PageProps<"/apps/[slug]/console">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  // Re-gate on the page, not just the sidebar entry: the terminal's own RPCs
  // require this, so a direct URL hit would render a shell that refuses to open.
  // The app's own switch answers the same way - off means the route is not there.
  if (!project.consoleEnabled) notFound();
  if (!(await hasAppCapability(project.id, "open_app_console"))) notFound();

  // No shell probe here - getConsoleInfo skips it so the console renders
  // instantly. The pane resolves the shell label after mount and appends the
  // distroless notice lazily if the container has no shell.
  const info = await getConsoleInfo(project.id);

  // No title, no description, no padding: this route is full-bleed (see
  // components/layout/shell-frame.tsx) and the terminal fills the frame.
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
