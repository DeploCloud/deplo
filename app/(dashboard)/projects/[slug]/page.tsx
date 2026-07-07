import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Boxes, Folder } from "lucide-react";
import { getProjectBySlug, projectContents } from "@/lib/data/projects";
import { listEnvironmentsForProject } from "@/lib/data/environments";
import { listProjectEnvironmentEnv } from "@/lib/data/environment-env";
import { hasCapability } from "@/lib/membership";
import { Card } from "@/components/ui/card";
import { StatusDot } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { EnvironmentManager } from "@/components/services/environment-manager";
import { EnvironmentEnvManager } from "@/components/env/environment-env-manager";
import { readableTextColor } from "@/lib/utils";

export async function generateMetadata(props: PageProps<"/projects/[slug]">) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
  return { title: project ? project.name : "Project" };
}

/**
 * A Project CONTAINER detail page: its Environments (with their shared
 * variables) and its folders and services. The isolated per-environment deploy
 * pipeline (URLs / branches / containers) is wired in a later phase.
 */
export default async function ProjectDetail(
  props: PageProps<"/projects/[slug]">,
) {
  const { slug } = await props.params;
  const project = await getProjectBySlug(slug);
  if (!project) notFound();

  const [{ folders, services }, environments, canManage, canManageEnv] =
    await Promise.all([
      projectContents(project.id),
      listEnvironmentsForProject(project.id),
      hasCapability("deploy"),
      hasCapability("manage_env"),
    ]);
  // Env values are gated by manage_env — skip the (throwing) read without it.
  const envVarGroups = canManageEnv
    ? await listProjectEnvironmentEnv(project.id)
    : [];
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

      <EnvironmentManager
        projectId={project.id}
        canManage={canManage}
        environments={environments.map((e) => ({
          id: e.id,
          name: e.name,
          slug: e.slug,
          kind: e.kind,
          gitBranch: e.gitBranch,
          isDefault: e.isDefault,
        }))}
      />

      {canManageEnv && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-medium text-muted-foreground">
              Environment variables
            </h2>
            <p className="text-sm text-muted-foreground">
              Shared by every service in this project, per environment. A
              service&apos;s own variable with the same key overrides them.
            </p>
          </div>
          <EnvironmentEnvManager groups={envVarGroups} canManage />
        </section>
      )}

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
