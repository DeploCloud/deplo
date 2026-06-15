import Link from "next/link";
import { Plus, Rocket, Bell, Eye, ArrowUpRight } from "lucide-react";
import { listProjects } from "@/lib/data/projects";
import { listActivity } from "@/lib/data/activity";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { ProjectCard } from "@/components/projects/project-card";
import { ProjectSearch } from "@/components/projects/project-search";
import { timeAgo } from "@/lib/utils";

export default async function OverviewPage(props: PageProps<"/">) {
  const { q } = await props.searchParams;
  const query = (Array.isArray(q) ? q[0] : q)?.toLowerCase() ?? "";

  const [projects, activity] = await Promise.all([
    listProjects(),
    listActivity(6),
  ]);

  const filtered = query
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.repo?.repo.toLowerCase().includes(query) ||
          p.productionUrl?.toLowerCase().includes(query)
      )
    : projects;

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      {/* Left rail */}
      <div className="order-2 space-y-6 lg:order-1">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Recent activity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {activity.length === 0 && (
              <p className="text-xs text-muted-foreground">No recent activity.</p>
            )}
            {activity.map((a) => (
              <div key={a.id} className="flex items-start gap-2.5 text-xs">
                <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary">
                  <Bell className="size-3 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="text-foreground">{a.message}</p>
                  <p className="text-muted-foreground">
                    {a.actor} · {timeAgo(a.createdAt)}
                  </p>
                </div>
              </div>
            ))}
            <Button variant="outline" size="sm" className="w-full" asChild>
              <Link href="/activity">View all activity</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Recent Previews</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-8 text-center">
              <Eye className="size-5 text-muted-foreground" />
              <p className="max-w-50 text-xs text-muted-foreground">
                Preview deployments you create will appear here.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Projects */}
      <div className="order-1 space-y-5 lg:order-2">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <Button asChild size="sm">
            <Link href="/new">
              <Plus className="size-4" />
              Add New
            </Link>
          </Button>
        </div>

        <ProjectSearch initialQuery={query} />

        {filtered.length === 0 ? (
          query ? (
            <EmptyState
              icon={Rocket}
              title="No projects match your search"
              description={`Nothing found for “${query}”.`}
            />
          ) : (
            <EmptyState
              icon={Rocket}
              title="No projects yet"
              description="Import a Git repository or start from a template to deploy your first app."
              action={
                <div className="flex gap-2">
                  <Button asChild>
                    <Link href="/new">
                      <Plus className="size-4" />
                      Import Project
                    </Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href="/templates">
                      Browse Templates
                      <ArrowUpRight className="size-4" />
                    </Link>
                  </Button>
                </div>
              }
            />
          )
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {filtered.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
