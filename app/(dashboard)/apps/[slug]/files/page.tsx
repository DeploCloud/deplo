import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps";
import { appFilesExist } from "@/lib/data/app-files";
import { PageHeader } from "@/components/shared/page-header";
import { FileExplorer } from "@/components/apps/file-explorer";

export const metadata = { title: "App Files" };

export default async function AppFilesPage(
  props: PageProps<"/apps/[slug]/files">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  // Re-gate on the page itself (not just the tab): the route must 404 for a
  // caller without manage_files or an app with no files dir, even on a direct
  // URL hit. appFilesExist returns false for both cases.
  if (!(await appFilesExist(project.id))) notFound();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Files"
        description="Browse and edit this app's files directory."
      />
      <FileExplorer appId={project.id} />
    </div>
  );
}
