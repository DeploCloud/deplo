import { notFound } from "next/navigation";
import { getServiceBySlug } from "@/lib/data/services";
import { serviceFilesExist } from "@/lib/data/service-files";
import { PageHeader } from "@/components/shared/page-header";
import { FileExplorer } from "@/components/services/file-explorer";

export const metadata = { title: "Service Files" };

export default async function ServiceFilesPage(
  props: PageProps<"/services/[slug]/files">,
) {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
  if (!project) notFound();
  // Re-gate on the page itself (not just the tab): the route must 404 for a
  // caller without manage_files or a service with no files dir, even on a direct
  // URL hit. serviceFilesExist returns false for both cases.
  if (!(await serviceFilesExist(project.id))) notFound();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Files"
        description="Browse and edit this service's files directory."
      />
      <FileExplorer serviceId={project.id} />
    </div>
  );
}
