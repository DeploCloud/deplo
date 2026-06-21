import { notFound } from "next/navigation";
import { getProjectBySlug } from "@/lib/data/projects";
import { projectFilesExist } from "@/lib/data/project-files";
import { PageHeader } from "@/components/shared/page-header";
import { FileExplorer } from "@/components/projects/file-explorer";

export const metadata = { title: "Project Files" };

export default async function ProjectFilesPage(
  props: PageProps<"/projects/[slug]/files">,
) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();
  // Re-gate on the page itself (not just the tab): the route must 404 for a
  // caller without manage_files or a project with no files dir, even on a direct
  // URL hit. projectFilesExist returns false for both cases.
  if (!(await projectFilesExist(project.id))) notFound();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Files"
        description="Browse and edit this project's files directory."
      />
      <FileExplorer projectId={project.id} />
    </div>
  );
}
