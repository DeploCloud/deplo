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
  if (!(await hasAppCapability(project.id, "open_app_console"))) notFound();

  // No shell probe here — getConsoleInfo skips it so the console renders
  // instantly. The pane resolves the shell label after mount and appends the
  // distroless notice lazily if the container has no shell.
  const info = await getConsoleInfo(project.id);

  // No title, no description, no padding: this route is full-bleed (see
  // components/layout/shell-frame.tsx) and the terminal fills the frame. What
  // the page header used to say is either obvious from the sidebar (which app,
  // which section) or now sits in the pane's own toolbar — including the app's
  // name, which is the link back to it.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LiveConsole
        appId={project.id}
        title={{ label: project.name, href: `/apps/${project.slug}` }}
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
