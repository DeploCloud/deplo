"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Pencil,
  Trash2,
  Share2,
  SearchX,
  AppWindow,
  Boxes,
  Layers,
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EnvValueCell } from "@/components/env/env-value-cell";
import { EnvAuthorCell } from "@/components/env/env-author-cell";
import { SharedVarEditDialog } from "@/components/env/shared-var-edit-dialog";
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
} from "@/components/env/shared-var-wizard";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { SharedVarDTO } from "@/lib/data/shared-vars";
import type { TeamEnvironment } from "@/lib/data/environments";

/**
 * The unified "Shared" tab: every shared variable of the team with create / edit
 * / delete and the sharing modes (team-wide / projects & their environments /
 * per-app links).
 *
 * The two things you can change about a variable are now two separate actions,
 * because they are two separate jobs: the pencil edits its VALUE (a small form),
 * and the share icon changes WHO gets it (the wizard). Creating one is the wizard
 * too — that is the walk through the scopes it was built for.
 */
export function SharedVarsManager({
  vars,
  apps,
  projects,
  environments,
}: {
  vars: SharedVarDTO[];
  /** Every app in the active team — the wizard's "specific apps" scope. */
  apps: AppRef[];
  projects: ProjectRef[];
  environments: TeamEnvironment[];
}) {
  // `wizard` is the scope editor (and the creator: `editing: null`); `editing` is
  // the small value form the pencil opens.
  const [wizard, setWizard] = React.useState<{ editing: SharedVarDTO | null } | null>(
    null,
  );
  const [editing, setEditing] = React.useState<SharedVarDTO | null>(null);
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const router = useRouter();

  // A variable narrowed to single environments carries only THEIR ids, so the
  // project it belongs to is only knowable through the environment.
  const projectOfEnv = React.useMemo(
    () => new Map(environments.map((e) => [e.id, e.projectId] as const)),
    [environments],
  );

  // The whole point of this tab is WHO gets the variable, so that is what it
  // filters on: the sharing mode, and then the single project / environment /
  // app a variable reaches. Options are the entities the variables actually name
  // — a project nobody shares with would only ever filter the page to nothing.
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
      info: "How the variable is shared. A variable can use several modes at once — it then shows under each.",
      options: [
        { value: "team", label: "The whole team" },
        { value: "project", label: "Projects" },
        { value: "environment", label: "Environments" },
        { value: "app", label: "Specific apps" },
      ].filter((o) =>
        vars.some((v) =>
          o.value === "team"
            ? v.teamWide
            : o.value === "project"
              ? v.projectIds.length > 0
              : o.value === "environment"
                ? v.environmentIds.length > 0
                : v.appIds.length > 0,
        ),
      ),
      match: (v, value) =>
        value === "team"
          ? v.teamWide
          : value === "project"
            ? v.projectIds.length > 0
            : value === "environment"
              ? v.environmentIds.length > 0
              : v.appIds.length > 0,
    };

    const projectFacet: EnvFacet<SharedVarDTO> = {
      id: "project",
      label: "Project",
      allLabel: "All projects",
      icon: Boxes,
      info: "Variables scoped to this project — as a whole, or through one of its environments. Team-wide variables reach it too: find those under “Shared with”.",
      options: projects
        .filter((p) => vars.some((v) => reachesProject(v, p.id)))
        .map((p) => ({ value: p.id, label: p.name })),
      match: reachesProject,
    };

    const environmentFacet: EnvFacet<SharedVarDTO> = {
      id: "environment",
      label: "Environment",
      allLabel: "All environments",
      icon: Layers,
      info: "Variables that reach this environment — picked directly, or through a scope on its whole project.",
      options: environments
        .filter((e) => vars.some((v) => reachesEnvironment(v, e.id)))
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
        .filter((a) => vars.some((v) => v.appIds.includes(a.id)))
        .map((a) => ({ value: a.id, label: a.name })),
      match: (v, value) => v.appIds.includes(value),
    };

    return [
      sharingFacet,
      projectFacet,
      environmentFacet,
      appFacet,
      typeFacet(vars),
      editorFacet(vars),
      updatedFacet<SharedVarDTO>(),
    ];
  }, [vars, projects, environments, apps, projectOfEnv]);

  // Searching "storefront" finds the variables shared WITH storefront, not only
  // the keys that spell it.
  const { state: filters, setState: setFilters, clear, shown, counts } =
    useEnvFilters(vars, facets, (v) =>
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
          <p className="text-sm text-muted-foreground">
            Define a variable once and share it with the whole team, with
            projects, or with single apps.
          </p>
        </div>
        <Button size="sm" onClick={() => setWizard({ editing: null })}>
          <Plus className="size-4" />
          New shared variable
        </Button>
      </div>

      {vars.length > 0 && (
        <EnvFilters
          state={filters}
          onChange={setFilters}
          onClear={clear}
          facets={facets}
          counts={counts}
          total={vars.length}
          shown={shown.length}
        />
      )}

      {vars.length === 0 ? (
        <EmptyState
          icon={Share2}
          title="No shared variables yet"
          description="Create a shared variable to reuse it across projects, apps, or the whole team."
        />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No matching variables"
          description="No shared variable matches the current search and filters."
          action={
            <Button variant="outline" size="sm" onClick={clear}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className="rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">Key</TableHead>
                <TableHead className="w-full">Value</TableHead>
                <TableHead className="whitespace-nowrap">Shared with</TableHead>
                <TableHead className="whitespace-nowrap">Last modified</TableHead>
                <TableHead className="whitespace-nowrap">Modified by</TableHead>
                <TableHead className="whitespace-nowrap text-right">Actions</TableHead>
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
                    <SharedWithChips v={v} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    <SimpleTooltip content={new Date(v.updatedAt).toLocaleString()}>
                      <span>{timeAgo(v.updatedAt)}</span>
                    </SimpleTooltip>
                  </TableCell>
                  <TableCell>
                    <EnvAuthorCell author={v.updatedBy ?? v.createdBy ?? null} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <SimpleTooltip content="Edit value">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setEditing(v)}
                          aria-label="Edit value"
                        >
                          <Pencil className="size-4" />
                        </Button>
                      </SimpleTooltip>
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
        onConfirm={async () => {
          const res = await gqlAction<{ deleteSharedVar: boolean }>(
            `mutation($id: String!) { deleteSharedVar(id: $id) }`,
            { id: deleteId! },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </div>
  );
}
