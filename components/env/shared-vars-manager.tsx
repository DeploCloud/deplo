"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import {
  Plus,
  Trash2,
  Share2,
  SearchX,
  AppWindow,
  Boxes,
  Layers,
  Users,
} from "lucide-react";
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
import { SimpleTooltip } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import { SharedVarsGraphic } from "@/components/env/shared-vars-graphic";
import { EnvValueCell } from "@/components/env/env-value-cell";
import { TimeAgo } from "@/components/shared/time-ago";
import { EnvAuthorCell } from "@/components/env/env-author-cell";
import { SharedVarEditDialog } from "@/components/env/shared-var-edit-dialog";
import { EnvEditButton } from "@/components/env/env-edit-button";
import { SharedWithChips } from "@/components/env/shared-with-chips";
import { EnvFilters } from "@/components/env/env-filters/env-filters-toolbar";
import {
  editorFacet,
  typeFacet,
  updatedFacet,
} from "@/components/env/env-filters/facets";
import type { EnvFacet } from "@/components/env/env-filters/types";
import { useEnvFilters } from "@/components/env/env-filters/use-env-filters";
import { SharedVarDialog } from "@/components/env/shared-var-wizard/dialog";
import type {
  AppRef,
  ProjectRef,
  TeamRef,
} from "@/components/env/shared-var-wizard/types";
import { gqlAction } from "@/lib/graphql-client";
import type { SharedVarDTO } from "@/lib/data/shared-vars/team-view";
import type { TeamEnvironment } from "@/lib/data/environments";

function matchSharing(v: SharedVarDTO, value: string): boolean {
  if (value === "team") return v.teamIds.length > 0;
  if (value === "automatic") return v.autoInject;
  if (value === "project") return v.projectIds.length > 0;
  if (value === "environment") return v.environmentIds.length > 0;
  return v.appIds.length > 0;
}

export function SharedVarsManager({
  vars,
  apps,
  projects,
  environments,
  teams,
  openEditId,
}: {
  vars: SharedVarDTO[];
  apps: AppRef[];
  projects: ProjectRef[];
  environments: TeamEnvironment[];
  teams: TeamRef[];
  openEditId?: string;
}) {
  const [wizard, setWizard] = React.useState<{
    editing: SharedVarDTO | null;
  } | null>(null);
  const [editing, setEditing] = React.useState<SharedVarDTO | null>(
    () =>
      vars.find(
        (v) => v.id === openEditId && v.editable && v.type !== "secret",
      ) ?? null,
  );
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const router = useRouter();

  React.useEffect(() => {
    if (openEditId) router.replace("/variables?tab=shared", { scroll: false });
  }, [openEditId, router]);

  const projectOfEnv = React.useMemo(
    () => new Map(environments.map((e) => [e.id, e.projectId] as const)),
    [environments],
  );

  const {
    visible: rows,
    remove,
    restore,
  } = useOptimisticRemove(vars, (v) => v.id);

  const facets = React.useMemo<EnvFacet<SharedVarDTO>[]>(() => {
    const reachesProject = (v: SharedVarDTO, projectId: string) =>
      v.projectIds.includes(projectId) ||
      v.environmentIds.some((id) => projectOfEnv.get(id) === projectId);
    const reachesEnvironment = (v: SharedVarDTO, environmentId: string) =>
      v.environmentIds.includes(environmentId) ||
      v.projectIds.some((p) => p === projectOfEnv.get(environmentId));

    const sharingFacet: EnvFacet<SharedVarDTO> = {
      id: "sharing",
      label: "Shared with",
      allLabel: "Anyone it reaches",
      icon: Share2,
      info: "How the variable is shared. A variable can use several modes at once - it then shows under each.",
      options: [
        { value: "team", label: "Teams" },
        { value: "automatic", label: "Added automatically" },
        { value: "project", label: "Projects" },
        { value: "environment", label: "Environments" },
        { value: "app", label: "Specific apps" },
      ].filter((o) => rows.some((v) => matchSharing(v, o.value))),
      match: matchSharing,
    };

    const projectFacet: EnvFacet<SharedVarDTO> = {
      id: "project",
      label: "Project",
      allLabel: "All projects",
      icon: Boxes,
      info: "Variables scoped to this project - as a whole, or through one of its environments. Team-wide variables reach it too: find those under “Shared with”.",
      options: projects
        .filter((p) => rows.some((v) => reachesProject(v, p.id)))
        .map((p) => ({ value: p.id, label: p.name })),
      match: reachesProject,
    };

    const environmentFacet: EnvFacet<SharedVarDTO> = {
      id: "environment",
      label: "Environment",
      allLabel: "All environments",
      icon: Layers,
      info: "Variables that reach this environment - picked directly, or through a scope on its whole project.",
      options: environments
        .filter((e) => rows.some((v) => reachesEnvironment(v, e.id)))
        .map((e) => ({ value: e.id, label: e.name, hint: e.projectName })),
      match: reachesEnvironment,
    };

    const appFacet: EnvFacet<SharedVarDTO> = {
      id: "app",
      label: "App",
      allLabel: "All apps",
      icon: AppWindow,
      info: "Variables linked directly to this app, wherever it lives.",
      options: apps
        .filter((a) => rows.some((v) => v.appIds.includes(a.id)))
        .map((a) => ({ value: a.id, label: a.name })),
      match: (v, value) => v.appIds.includes(value),
    };

    return [
      sharingFacet,
      projectFacet,
      environmentFacet,
      appFacet,
      typeFacet(rows),
      editorFacet(rows),
      updatedFacet<SharedVarDTO>(),
    ];
  }, [rows, projects, environments, apps, projectOfEnv]);

  const {
    state: filters,
    setState: setFilters,
    clear,
    shown,
    counts,
  } = useEnvFilters(rows, facets, (v) =>
    [
      ...v.projects.map((p) => p.name),
      ...v.apps.map((a) => a.name),
      ...v.environments.map((e) => `${e.projectName} ${e.name}`),
    ].join(" "),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Shared variables</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Define a variable once and make it available to every app in the
            team, in a project, or add it to single apps. Apps opt in - a shared
            variable is never added to an app automatically.
          </p>
        </div>
        <Button size="sm" onClick={() => setWizard({ editing: null })}>
          <Plus className="size-4" />
          New shared variable
        </Button>
      </div>

      {rows.length > 0 && (
        <EnvFilters
          state={filters}
          onChange={setFilters}
          onClear={clear}
          facets={facets}
          counts={counts}
        />
      )}

      {rows.length === 0 ? (
        <EmptyState
          graphic={<SharedVarsGraphic />}
          title="No shared variables yet"
          docs="env.shared"
          description="Create a shared variable to reuse it across projects, apps, or the whole team."
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No matching variables"
          description="No shared variable matches the current search and filters."
        />
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">Key</TableHead>
                <TableHead className="w-full">Value</TableHead>
                <TableHead className="whitespace-nowrap">Shared with</TableHead>
                <TableHead className="whitespace-nowrap">
                  Last modified
                </TableHead>
                <TableHead className="whitespace-nowrap">Modified by</TableHead>
                <TableHead className="text-right whitespace-nowrap">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((v) => (
                <TableRow key={v.id}>
                  <TableCell className="font-mono text-xs font-medium">
                    {v.key}
                  </TableCell>
                  <TableCell>
                    <EnvValueCell value={v.value} masked={v.masked} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      {!v.editable && (
                        <Badge
                          variant="outline"
                          className="gap-1 text-[10px] font-normal"
                        >
                          <Users className="size-3" />
                          {v.ownerTeam?.name ?? "Every team"}
                        </Badge>
                      )}
                      <SharedWithChips v={v} />
                    </div>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                    <TimeAgo at={v.updatedAt} />
                  </TableCell>
                  <TableCell>
                    <EnvAuthorCell
                      author={v.updatedBy ?? v.createdBy ?? null}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {v.editable ? (
                      <div className="flex justify-end gap-1">
                        <EnvEditButton
                          secret={v.type === "secret"}
                          label="Edit value"
                          tooltip="Edit value"
                          onClick={() => setEditing(v)}
                        />
                        <SimpleTooltip content="Change sharing">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => setWizard({ editing: v })}
                            aria-label="Change sharing"
                          >
                            <Share2 className="size-4" />
                          </Button>
                        </SimpleTooltip>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteId(v.id)}
                          aria-label="Delete"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ) : (
                      <SimpleTooltip
                        content={`Owned by ${v.ownerTeam?.name ?? "an instance admin"}. Only they can change it.`}
                      >
                        <span className="text-xs text-muted-foreground">
                          Read-only
                        </span>
                      </SimpleTooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {editing && (
        <SharedVarEditDialog
          key={editing.id}
          open
          onOpenChange={(v) => !v && setEditing(null)}
          editing={editing}
          onChangeSharing={() => {
            setWizard({ editing });
            setEditing(null);
          }}
        />
      )}
      {wizard && (
        <SharedVarDialog
          teams={teams}
          key={wizard.editing?.id ?? "new"}
          open
          onOpenChange={(v) => !v && setWizard(null)}
          editing={wizard.editing}
          apps={apps}
          projects={projects}
          environments={environments}
        />
      )}
      <ConfirmAction
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
        title="Delete shared variable?"
        description="This removes the variable from every app it reaches. New deployments will no longer receive it."
        confirmLabel="Delete"
        successMessage="Shared variable deleted"
        optimistic
        onConfirm={async () => {
          const id = deleteId!;
          remove(id);
          const res = await gqlAction<{ deleteSharedVar: boolean }>(
            `mutation($id: String!) { deleteSharedVar(id: $id) }`,
            { id },
          );
          if (res.ok) router.refresh();
          else restore(id);
          return res;
        }}
      />
    </div>
  );
}
