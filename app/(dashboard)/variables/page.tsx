import Link from "next/link";
import { Braces, Boxes, ArrowUpRight, Lock } from "lucide-react";
import { listAllServiceEnv } from "@/lib/data/env";
import { listSharedEnvGroups } from "@/lib/data/shared-env";
import { listTeamGlobalEnv, listInstanceEnv } from "@/lib/data/global-env";
import { listProjectEnvironmentEnv } from "@/lib/data/environment-env";
import { listProjects } from "@/lib/data/projects";
import { hasCapability, isInstanceAdmin } from "@/lib/membership";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SharedEnvManager } from "@/components/env/shared-env-manager";
import { GlobalEnvManager } from "@/components/env/global-env-manager";
import { EnvironmentEnvManager } from "@/components/env/environment-env-manager";
import { EnvValueCell } from "@/components/env/env-value-cell";

export const metadata = { title: "Environment Variables" };

export default async function VariablesPage(
  props: PageProps<"/variables">,
) {
  const { tab: tabParam } = await props.searchParams;
  const tab = Array.isArray(tabParam) ? tabParam[0] : tabParam;

  // Env values are gated by manage_env. The sidebar link is hidden without it;
  // guard the page too for direct navigation.
  if (!(await hasCapability("manage_env"))) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Variables"
          description="Service & shared environment variables."
        />
        <EmptyState
          icon={Lock}
          title="No access to variables"
          description="You don't have permission to view environment variables. Ask a team admin for the “Manage env vars” permission."
        />
      </div>
    );
  }

  const admin = await isInstanceAdmin();
  const [allServiceGroups, sharedGroups, teamGlobals, instanceGlobals, projects] =
    await Promise.all([
      listAllServiceEnv(),
      listSharedEnvGroups(),
      listTeamGlobalEnv(),
      // Instance-wide vars are admin-only; skip the (throwing) read otherwise.
      admin ? listInstanceEnv() : Promise.resolve([]),
      listProjects(),
    ]);
  const services = allServiceGroups.map((g) => g.service);
  // Environment-scoped shared vars, grouped per Project container → environment.
  const projectEnvGroups = await Promise.all(
    projects.map(async (p) => ({
      project: p,
      groups: await listProjectEnvironmentEnv(p.id),
    })),
  );

  // Only surface a service here if it has variables to show: its own vars, or
  // at least one attached shared group. Empty services add noise, not signal.
  const projectsWithSharedGroup = new Set(
    sharedGroups.flatMap((g) => g.serviceIds),
  );
  const serviceGroups = allServiceGroups.filter(
    (g) => g.vars.length > 0 || projectsWithSharedGroup.has(g.service.id),
  );

  const allowedTabs = new Set([
    "service",
    "environments",
    "shared",
    "team",
    ...(admin ? ["instance"] : []),
  ]);
  const defaultTab = tab && allowedTabs.has(tab) ? tab : "service";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Environment Variables"
        description="Per-service, per-environment, team-global and reusable shared variables across your workspace."
      />

      <Tabs defaultValue={defaultTab}>
        <UnderlineTabsList>
          <UnderlineTabsTrigger value="service">Service</UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="environments">
            Environments
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="shared">Shared</UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="team">Team globals</UnderlineTabsTrigger>
          {admin && (
            <UnderlineTabsTrigger value="instance">
              All teams
            </UnderlineTabsTrigger>
          )}
        </UnderlineTabsList>

        {/* Service: every service's variables, grouped by project */}
        <TabsContent value="service" className="space-y-4">
          {serviceGroups.length === 0 ? (
            <EmptyState
              icon={Braces}
              title="No variables yet"
              description="Services appear here once they have their own variables or an attached shared group."
            />
          ) : (
            serviceGroups.map((g) => (
              <Card key={g.service.id}>
                <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                  <CardTitle className="text-base">{g.service.name}</CardTitle>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/services/${g.service.slug}/environment`}>
                      Manage
                      <ArrowUpRight className="size-4" />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  {g.vars.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No variables for this service.
                    </p>
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Key</TableHead>
                            <TableHead>Value</TableHead>
                            <TableHead>Environments</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {g.vars.map((v) => (
                            <TableRow key={v.id}>
                              <TableCell className="font-mono text-xs font-medium">
                                {v.key}
                              </TableCell>
                              <TableCell>
                                <EnvValueCell
                                  value={v.value}
                                  masked={v.masked}
                                />
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-wrap gap-1">
                                  {v.targets.map((t) => (
                                    <Badge
                                      key={t}
                                      variant="muted"
                                      className="text-[10px] capitalize"
                                    >
                                      {t}
                                    </Badge>
                                  ))}
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        {/* Environments: per-project, per-environment shared variables */}
        <TabsContent value="environments" className="space-y-4">
          {projectEnvGroups.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="No projects yet"
              description="Create a project to group services and share variables per environment (Production, Preview, …)."
            />
          ) : (
            projectEnvGroups.map(({ project, groups }) => (
              <Card key={project.id}>
                <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                  <CardTitle className="text-base">{project.name}</CardTitle>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/projects/${project.slug}`}>
                      Open project
                      <ArrowUpRight className="size-4" />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  <EnvironmentEnvManager groups={groups} canManage />
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        {/* Shared: reusable groups attached to multiple services */}
        <TabsContent value="shared">
          <SharedEnvManager groups={sharedGroups} services={services} />
        </TabsContent>

        {/* Team globals: injected into every service in this team */}
        <TabsContent value="team">
          <GlobalEnvManager scope="team" vars={teamGlobals} />
        </TabsContent>

        {/* All teams: instance-wide, admin only */}
        {admin && (
          <TabsContent value="instance">
            <GlobalEnvManager scope="instance" vars={instanceGlobals} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
