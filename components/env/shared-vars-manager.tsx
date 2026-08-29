"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
import {
  EnvFilters,
  useEnvFilters,
  editorFacet,
  typeFacet,
  updatedFacet,
  type EnvFacet,
} from "@/components/env/env-filters";
import {
  SharedVarDialog,
  type AppRef,
  type ProjectRef,
  type TeamRef,
} from "@/components/env/shared-var-wizard";
import { gqlAction } from "@/lib/graphql-client";
import type { SharedVarDTO } from "@/lib/data/shared-vars";
import type { TeamEnvironment } from "@/lib/data/environments";

/** The "Shared with" facet, as one predicate both the options and the filter use. */
function matchSharing(v: SharedVarDTO, value: string): boolean {
  if (value === "team") return v.teamIds.length > 0;
  if (value === "automatic") return v.autoInject;
  if (value === "project") return v.projectIds.length > 0;
  if (value === "environment") return v.environmentIds.length > 0;
  return v.appIds.length > 0;
}

/**
 * The unified "Shared" tab: every shared variable of the team with create / edit /
 * delete and the sharing modes (team-wide / projects & their environments /
 * per-app links).
 */
export function SharedVarsManager({
  vars,
  apps,
  projects,
  environments,
  teams,
  openEditId,
}: {
  vars: SharedVarDTO[];
  /** Every app in the active team - the wizard's "specific apps" scope. */
  apps: AppRef[];
  projects: ProjectRef[];
  environments: TeamEnvironment[];
  /** The teams the viewer may share a variable with (the wizard's Teams step). */
  teams: TeamRef[];
  /** `?edit=` - an app's "Manage" button lands here with its dialog already open. */
  openEditId?: string;
}) {
  // `wizard` is the scope editor (and the creator: `editing: null`); `editing` is
  // the small value form the pencil opens.
  const [wizard, setWizard] = React.useState<{
    editing: SharedVarDTO | null;
  } | null>(null);
  const [editing, setEditing] = React.useState<SharedVarDTO | null>(
    // A secret has no value form, so the deep link only lands the user on the row.
    () =>
      vars.find(
        (v) => v.id === openEditId && v.editable && v.type !== "secret",
      ) ?? null,
  );
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const router = useRouter();

  // The deep link has been consumed: drop it, or leaving and re-entering the tab
  // would reopen the dialog the user just closed.
  React.useEffect(() => {
    if (openEditId) router.replace("/variables?tab=shared", { scroll: false });
  }, [openEditId, router]);

  // A variable narrowed to single environments carries only THEIR ids, so the
  // project it belongs to is only knowable through the environment.
  const projectOfEnv = React.useMemo(
    () => new Map(environments.map((e) => [e.id, e.projectId] as const)),
    [environments],
  );

  // A deleted variable leaves the table on the click, instead of waiting out the
  // mutation and then the `router.refresh()` behind it - the window in which a second
  // click on the same row earned a "Not found".
  const {
    visible: rows,
    remove,
    restore,
  } = useOptimisticRemove(vars, (v) => v.id);

  // The whole point of this tab is WHO gets the variable, so that is what it filters
  // on: the sharing mode, and then the single project / environment / app a variable
  // reaches.
  const facets = React.useMemo<EnvFacet<SharedVarDTO>[]>(() => {
    const reachesProject = (v: SharedVarDTO, projectId: string) =>
      v.projectIds.includes(projectId) ||
      v.environmentIds.some((id) => projectOfEnv.get(id) === projectId);
    const reachesEnvironment = (v: SharedVarDTO, environmentId: string) =>
      v.environmentIds.includes(environmentId) ||
      // A whole-project scope reaches every environment of that project.
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
        // Every project has a "Production": the project name is what tells two
        // same-named environments apart in the menu.
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

  // Searching "storefront" finds the variables shared WITH storefront, not only
  // the keys that spell it.
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
      {/* The action sits in the HEADER, not beside the filters: the toolbar needs
          the full width to keep its dropdowns on one row. */}
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
                      /* Another team owns it: it reaches us, we do not edit it. */
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
          // `deleteId` is this render's value: the dialog has already closed
          // itself (and cleared it) by the time this runs.
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
