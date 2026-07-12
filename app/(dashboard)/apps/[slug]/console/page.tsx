import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps";
import { getConsoleInfo } from "@/lib/data/console";
import { PageHeader } from "@/components/shared/page-header";
import { LiveConsole } from "@/components/apps/live-console";

export const metadata = { title: "Console" };

export default async function AppConsolePage(
  props: PageProps<"/apps/[slug]/console">
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  // No shell probe here — getConsoleInfo skips it so the console renders
  // instantly. ContainerConsole resolves the shell label after mount and
  // appends the distroless notice lazily if the container has no shell.
  const info = await getConsoleInfo(project.id);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Console"
        description="Run commands in the running container (docker exec)."
      />

      {/* Follows the app's live running state: the terminal appears/
          disappears as the container starts/stops, no reload. */}
      <LiveConsole
        appId={project.id}
        initialInfo={
          info?.running
            ? {
                containerName: info.containerName,
                image: info.image,
                instances: info.instances,
              }
            : null
        }
        initialRunning={!!info?.running}
      />
    </div>
  );
}
