import Link from "next/link";
import { Braces, ArrowUpRight } from "lucide-react";
import { listAllProjectEnv } from "@/lib/data/env";
import { listSharedEnvGroups } from "@/lib/data/shared-env";
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

export const metadata = { title: "Environment Variables" };

export default async function VariablesPage() {
  const [projectGroups, sharedGroups] = await Promise.all([
    listAllProjectEnv(),
    listSharedEnvGroups(),
  ]);
  const projects = projectGroups.map((g) => g.project);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Environment Variables"
        description="Per-project variables and reusable shared groups across your workspace."
      />

      <Tabs defaultValue="project">
        <UnderlineTabsList>
          <UnderlineTabsTrigger value="project">Project</UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="shared">Shared</UnderlineTabsTrigger>
        </UnderlineTabsList>

        {/* Project: every project's variables, grouped by project */}
        <TabsContent value="project" className="space-y-4">
          {projectGroups.length === 0 ? (
            <EmptyState
              icon={Braces}
              title="No projects yet"
              description="Variables appear here once you have projects."
            />
          ) : (
            projectGroups.map((g) => (
              <Card key={g.project.id}>
                <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                  <CardTitle className="text-base">{g.project.name}</CardTitle>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/projects/${g.project.slug}/environment`}>
                      Manage
                      <ArrowUpRight className="size-4" />
                    </Link>
                  </Button>
                </CardHeader>
                <CardContent>
                  {g.vars.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No variables for this project.
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
                                <code className="font-mono text-xs text-muted-foreground">
                                  {v.value}
                                </code>
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

        {/* Shared: reusable groups attached to multiple projects */}
        <TabsContent value="shared">
          <SharedEnvManager groups={sharedGroups} projects={projects} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
