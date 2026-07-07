import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Boxes, Folder } from "lucide-react";
import { getProjectBySlug, projectContents } from "@/lib/data/projects";
import { listEnvironmentsForProject } from "@/lib/data/environments";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { readableTextColor } from "@/lib/utils";

export async function generateMetadata(props: PageProps<"/projects/[slug]">) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
  return { title: project ? project.name : "Project" };
}

/**
 * A Project CONTAINER detail page: its folders and services. Environments (the
 * per-project isolated deploy targets) land here in a later phase.
 */
export default async function ProjectDetail(
  props: PageProps<"/projects/[slug]">,
) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const [{ folders, services }, environments] = await Promise.all([
    projectContents(project.id),
    listEnvironmentsForProject(project.id),
  ]);
  const empty = folders.length === 0 && services.length === 0;
  const tileStyle = project.color
    ? { backgroundColor: project.color, color: readableTextColor(project.color) }
    : undefined;

  return (
    <div className="space-y-6">
      <Link
        href="/projects"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Projects
      </Link>

      <div className="flex items-center gap-3">
        <div
          className={
            "flex size-10 shrink-0 items-center justify-center rounded-md " +
            (project.color ? "" : "bg-secondary text-muted-foreground")
          }
          style={tileStyle}
        >
          <Boxes className="size-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          <p className="text-sm text-muted-foreground">
            {services.length} {services.length === 1 ? "service" : "services"} ·{" "}
            {folders.length} {folders.length === 1 ? "folder" : "folders"}
          </p>
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Environments</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {environments.map((e) => (
            <Card key={e.id} className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{e.name}</span>
                  {e.isDefault && (
                    <Badge variant="secondary" className="text-[10px]">
                      Default
                    </Badge>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {e.gitBranch ? `branch: ${e.gitBranch}` : `kind: ${e.kind}`}
                </p>
              </div>
            </Card>
          ))}
        </div>
      </section>

      {empty ? (
        <EmptyState
          icon={Boxes}
          title="This project is empty"
          description="Move folders or services into this project from the Overview to organise them here."
        />
      ) : (
        <div className="space-y-8">
          {folders.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Folders</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {folders.map((f) => (
                  <Card key={f.id} className="p-4">
                    <Link
                      href={`/?folder=${f.id}`}
                      className="flex items-center gap-3"
                    >
                      <Folder className="size-4.5 text-muted-foreground" />
                      <span className="truncate font-medium">{f.name}</span>
                    </Link>
                  </Card>
                ))}
              </div>
            </section>
          )}
          {services.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Services</h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {services.map((s) => (
                  <Card key={s.id} className="p-4">
                    <Link
                      href={`/services/${s.slug}`}
                      className="flex items-center gap-3"
                    >
                      <StatusDot status={s.status} />
                      <span className="truncate font-medium">{s.name}</span>
                    </Link>
                  </Card>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
