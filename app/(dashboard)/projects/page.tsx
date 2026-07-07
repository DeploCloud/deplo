import { Boxes } from "lucide-react";
import { listProjects } from "@/lib/data/projects";
import { hasCapability } from "@/lib/membership";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { ProjectContainerCard } from "@/components/services/project-container-card";
import { NewProjectButton } from "@/components/services/create-project-dialog";

export const metadata = { title: "Projects" };

/**
 * The Project CONTAINER index (ADR-0008). Lists the active team's top-level
 * containers; each groups folders and services and owns their environments.
 * Additive — top-level (un-contained) folders and services still live on the
 * Overview.
 */
export default async function ProjectsIndex() {
  const [projects, canManage] = await Promise.all([
    listProjects(),
    hasCapability("deploy"),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        description="Top-level containers that group folders and services and own their environments."
        actions={canManage ? <NewProjectButton /> : undefined}
      />

      {projects.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No projects yet"
          description={
            canManage
              ? "Create a project to group related services and give each stage its own environment."
              : "No projects have been created in this team yet."
          }
          action={canManage ? <NewProjectButton /> : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <ProjectContainerCard
              key={p.id}
              project={{
                id: p.id,
                name: p.name,
                slug: p.slug,
                color: p.color,
                folderCount: p.folderCount,
                serviceCount: p.serviceCount,
              }}
              canManage={canManage}
            />
          ))}
        </div>
      )}
    </div>
  );
}
