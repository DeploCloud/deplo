"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import {
  Plus,
  Trash2,
  Share2,
  ArrowUpRight,
  AppWindow,
  Boxes,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Layers,
  SearchX,
} from "lucide-react";
import { AppLogo } from "@/components/shared/project-logo";
import { SharedVarDialog } from "@/components/env/shared-var-wizard/dialog";
import type {
  AppRef,
  ProjectRef,
  TeamRef,
} from "@/components/env/shared-var-wizard/types";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import { AppsGraphic } from "@/components/apps/apps-graphic";
import { AppVarsGraphic } from "@/components/env/app-vars-graphic";
import { EnvValueCell } from "@/components/env/env-value-cell";
import { TimeAgo } from "@/components/shared/time-ago";
import { EnvVarDialog } from "@/components/env/env-var-dialog";
import { EnvAuthorCell } from "@/components/env/env-author-cell";
import { SharedVarEditDialog } from "@/components/env/shared-var-edit-dialog";
import { EnvEditButton } from "@/components/env/env-edit-button";
import { EnvFilters } from "@/components/env/env-filters/env-filters-toolbar";
import {
  editorFacet,
  sourceFacet,
  typeFacet,
  updatedFacet,
} from "@/components/env/env-filters/facets";
import { FACET_NONE, type EnvFacet } from "@/components/env/env-filters/types";
import { useEnvFilters } from "@/components/env/env-filters/use-env-filters";
import { gqlAction } from "@/lib/graphql-client";
import { cn, readableTextColor } from "@/lib/utils";
import {
  groupRowsByProject,
  TOP_LEVEL,
  type AppBucket,
  type ProjectBucket,
} from "@/lib/env-grouping";
import type { EnvVarDTO } from "@/lib/types/env";
import type { AppEnvGroup } from "@/lib/data/env";
import type { AppliedSharedVarDTO } from "@/lib/data/shared-vars/app-view";
import type { SharedVarDTO } from "@/lib/data/shared-vars/team-view";
import type { TeamEnvironment } from "@/lib/data/environments";

type RowApp = AppEnvGroup["app"];

type SharedVar = AppliedSharedVarDTO & { type: "plain" | "secret" };

type EnvRow =
  | ({ kind: "standalone"; app: RowApp; projectName: string } & EnvVarDTO)
  | ({ kind: "shared"; app: RowApp; projectName: string } & SharedVar);

const rowKey = (row: EnvRow) =>
  row.kind === "standalone"
    ? `standalone:${row.id}`
    : `shared:${row.app.id}:${row.id}`;

function useCollapsed(storageKey: string) {
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const current = React.useRef(collapsed);

  React.useEffect(() => {
    let stored: string[] = [];
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed))
        stored = parsed.filter((id): id is string => typeof id === "string");
    } catch {}
    if (stored.length === 0) return;
    const next = new Set(stored);
    current.current = next;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- apply persisted UI preference after mount
    setCollapsed(next);
  }, [storageKey]);

  const commit = React.useCallback(
    (next: ReadonlySet<string>) => {
      current.current = next;
      setCollapsed(next);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {}
    },
    [storageKey],
  );

  const toggle = React.useCallback(
    (id: string) => {
      const next = new Set(current.current);
      if (!next.delete(id)) next.add(id);
      commit(next);
    },
    [commit],
  );

  return { collapsed, toggle, commit };
}

function appSubtitle(
  app: RowApp,
  environmentName: Map<string, string>,
): string {
  return [
    app.environmentId ? environmentName.get(app.environmentId) : null,
    app.primaryDomain,
  ]
    .filter(Boolean)
    .join(" · ");
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function AllAppsEnvManager({
  groups,
  sharedByApp,
  sharedVars,
  apps,
  projects,
  environments,
  teams,
}: {
  groups: AppEnvGroup[];
  sharedByApp: Record<string, AppliedSharedVarDTO[]>;
  sharedVars: SharedVarDTO[];
  apps: AppRef[];
  projects: ProjectRef[];
  environments: TeamEnvironment[];
  teams: TeamRef[];
}) {
  const [dialog, setDialog] = React.useState<{
    appId: string;
    editing: EnvVarDTO | null;
  } | null>(null);
  const [sharedEditing, setSharedEditing] = React.useState<SharedVarDTO | null>(
    null,
  );
  const [sharedScoping, setSharedScoping] = React.useState<SharedVarDTO | null>(
    null,
  );
  const [deleteId, setDeleteId] = React.useState<string | null>(null);
  const router = useRouter();

  const sharedById = React.useMemo(
    () => new Map(sharedVars.map((v) => [v.id, v] as const)),
    [sharedVars],
  );
  const editableSharedIds = React.useMemo(
    () => new Set(sharedVars.filter((v) => v.editable).map((v) => v.id)),
    [sharedVars],
  );
  const projectName = React.useMemo(
    () => new Map(projects.map((p) => [p.id, p.name] as const)),
    [projects],
  );
  const environmentName = React.useMemo(
    () => new Map(environments.map((e) => [e.id, e.name] as const)),
    [environments],
  );

  const projectCollapse = useCollapsed("deplo:vars-collapsed-projects");
  const appCollapse = useCollapsed("deplo:vars-collapsed-apps");

  const serverRows = React.useMemo<EnvRow[]>(
    () =>
      groups.flatMap((g) => {
        const where = g.app.projectId
          ? (projectName.get(g.app.projectId) ?? "")
          : "";
        return [
          ...g.vars.map((v): EnvRow => ({
            ...v,
            kind: "standalone",
            app: g.app,
            projectName: where,
          })),
          ...(sharedByApp[g.app.id] ?? []).map((v): EnvRow => ({
            ...v,
            kind: "shared",
            type: v.masked ? "secret" : "plain",
            app: g.app,
            projectName: where,
          })),
        ];
      }),
    [groups, sharedByApp, projectName],
  );

  const {
    visible: rows,
    remove,
    restore,
  } = useOptimisticRemove(serverRows, rowKey);

  const facets = React.useMemo<EnvFacet<EnvRow>[]>(() => {
    const projectIds = new Set<string>();
    const environmentIds = new Set<string>();
    let loose = false;
    for (const row of rows) {
      if (row.app.projectId) projectIds.add(row.app.projectId);
      else loose = true;
      if (row.app.environmentId) environmentIds.add(row.app.environmentId);
    }

    const projectFacet: EnvFacet<EnvRow> = {
      id: "project",
      label: "Project",
      allLabel: "All projects",
      icon: Boxes,
      info: "The project container the variable's app lives in.",
      options: [
        ...projects
          .filter((p) => projectIds.has(p.id))
          .map((p) => ({ value: p.id, label: p.name })),
        ...(loose
          ? [{ value: FACET_NONE, label: "No project", hint: "standalone" }]
          : []),
      ],
      match: (row, value) =>
        value === FACET_NONE
          ? row.app.projectId == null
          : row.app.projectId === value,
    };

    const environmentFacet: EnvFacet<EnvRow> = {
      id: "environment",
      label: "Environment",
      allLabel: "All environments",
      icon: Layers,
      info: "The environment of its project the app lives in. Apps outside a project have none.",
      options: environments
        .filter((e) => environmentIds.has(e.id))
        .map((e) => ({ value: e.id, label: e.name, hint: e.projectName })),
      match: (row, value) => row.app.environmentId === value,
    };

    return [
      projectFacet,
      environmentFacet,
      sourceFacet(rows),
      typeFacet(rows),
      editorFacet(rows),
      updatedFacet<EnvRow>(),
    ];
  }, [rows, projects, environments]);

  const {
    state: filters,
    setState: setFilters,
    clear,
    shown,
    counts,
  } = useEnvFilters(
    rows,
    facets,
    (row) => `${row.app.name} ${row.projectName}`,
  );

  const sections = React.useMemo<ProjectBucket<EnvRow>[]>(
    () =>
      groupRowsByProject(shown, projects, { byName: filters.sort === "key" }),
    [shown, projects, filters.sort],
  );

  const openSections = sections.filter(
    (s) => !projectCollapse.collapsed.has(s.id),
  ).length;

  function toggleAllSections() {
    const next = new Set(projectCollapse.collapsed);
    for (const s of sections) {
      if (openSections > 0) next.add(s.id);
      else next.delete(s.id);
    }
    projectCollapse.commit(next);
  }

  if (groups.length === 0) {
    return (
      <EmptyState
        graphic={<AppsGraphic />}
        title="No apps yet"
        docs="deploy.sources"
        description="Create an app to start adding environment variables."
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        graphic={<AppVarsGraphic />}
        title="No variables yet"
        docs="env.allApps"
        description="None of your apps has an environment variable. Open an app to add its first one, or create a shared variable."
        action={
          <Button variant="outline" asChild>
            <Link href="/">
              Browse apps
              <ArrowUpRight className="size-4" />
            </Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <EnvFilters
        state={filters}
        onChange={setFilters}
        onClear={clear}
        facets={facets}
        counts={counts}
        actions={
          sections.length > 1 ? (
            <Button
              variant="ghost"
              className="text-muted-foreground"
              onClick={toggleAllSections}
            >
              {openSections > 0 ? (
                <>
                  <ChevronsDownUp className="size-4" />
                  Collapse all
                </>
              ) : (
                <>
                  <ChevronsUpDown className="size-4" />
                  Expand all
                </>
              )}
            </Button>
          ) : undefined
        }
      />

      {sections.length === 0 && (
        <EmptyState
          icon={SearchX}
          title="No matching variables"
          description="No variable on this page matches the current search and filters."
          action={
            <Button variant="outline" size="sm" onClick={clear}>
              Clear filters
            </Button>
          }
        />
      )}

      {sections.map((section) => {
        const open = !projectCollapse.collapsed.has(section.id);
        return (
          <section key={section.id} className="group space-y-3">
            <ProjectSectionHeader
              section={section}
              open={open}
              onToggle={() => projectCollapse.toggle(section.id)}
            />
            {open && (
              <div
                id={`vars-project-${section.id}`}
                className="space-y-4 sm:pl-4"
              >
                {section.apps.map((card) => (
                  <AppVarsCard
                    key={card.app.id}
                    card={card}
                    open={!appCollapse.collapsed.has(card.app.id)}
                    onToggle={() => appCollapse.toggle(card.app.id)}
                    environmentName={environmentName}
                    onAdd={() =>
                      setDialog({ appId: card.app.id, editing: null })
                    }
                    onEdit={(row) =>
                      setDialog({ appId: card.app.id, editing: row })
                    }
                    onDelete={setDeleteId}
                    onEditShared={(id) => {
                      const full = sharedById.get(id);
                      if (full) setSharedEditing(full);
                    }}
                    editableSharedIds={editableSharedIds}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {dialog && (
        <EnvVarDialog
          key={`${dialog.appId}:${dialog.editing?.id ?? "new"}`}
          open
          onOpenChange={(v) => !v && setDialog(null)}
          appId={dialog.appId}
          editing={dialog.editing}
          canCreateShared
          apps={apps}
          projects={projects}
          environments={environments}
          teams={teams}
        />
      )}
      {sharedEditing && (
        <SharedVarEditDialog
          key={sharedEditing.id}
          open
          onOpenChange={(v) => !v && setSharedEditing(null)}
          editing={sharedEditing}
          onChangeSharing={() => {
            setSharedScoping(sharedEditing);
            setSharedEditing(null);
          }}
        />
      )}
      {sharedScoping && (
        <SharedVarDialog
          teams={teams}
          key={sharedScoping.id}
          open
          onOpenChange={(v) => !v && setSharedScoping(null)}
          editing={sharedScoping}
          apps={apps}
          projects={projects}
          environments={environments}
        />
      )}
      <ConfirmAction
        open={deleteId !== null}
        onOpenChange={(v) => !v && setDeleteId(null)}
        title="Delete variable?"
        description="This removes the variable. It will no longer be available to new deployments."
        confirmLabel="Delete"
        successMessage="Variable deleted"
        optimistic
        onConfirm={async () => {
          const id = deleteId!;
          const key = `standalone:${id}`;
          remove(key);
          const res = await gqlAction<{ deleteEnv: boolean }>(
            `mutation($id: String!) { deleteEnv(id: $id) }`,
            { id },
          );
          if (res.ok) router.refresh();
          else restore(key);
          return res;
        }}
      />
    </div>
  );
}

function ProjectSectionHeader({
  section,
  open,
  onToggle,
}: {
  section: ProjectBucket<EnvRow>;
  open: boolean;
  onToggle: () => void;
}) {
  const top = section.id === TOP_LEVEL;
  const color = section.color;
  const headerStyle = color
    ? { backgroundColor: `${color}1a`, borderColor: `${color}40` }
    : undefined;
  const tileStyle = color
    ? { backgroundColor: color, color: readableTextColor(color) }
    : undefined;
  const Glyph = top ? AppWindow : Boxes;

  return (
    <div
      style={headerStyle}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg border border-border px-4 transition-colors",
        !color && "hover:bg-surface",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`vars-project-${section.id}`}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md py-3 text-left",
          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        )}
      >
        <ChevronDown
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
            !open && "-rotate-90",
          )}
        />
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md",
            color ? "" : "bg-secondary text-muted-foreground",
          )}
          style={tileStyle}
        >
          <Glyph className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {section.name}
          </span>
          <span className="mt-1 block truncate text-xs text-muted-foreground">
            {plural(section.apps.length, "app")} ·{" "}
            {plural(section.rowCount, "variable")}
          </span>
        </span>
      </button>
    </div>
  );
}

function AppVarsCard({
  card,
  open,
  onToggle,
  environmentName,
  onAdd,
  onEdit,
  onDelete,
  onEditShared,
  editableSharedIds,
}: {
  card: AppBucket<EnvRow>;
  open: boolean;
  onToggle: () => void;
  environmentName: Map<string, string>;
  onAdd: () => void;
  onEdit: (row: EnvVarDTO) => void;
  onDelete: (id: string) => void;
  onEditShared: (id: string) => void;
  editableSharedIds: Set<string>;
}) {
  const { app, rows } = card;
  const subtitle = appSubtitle(app, environmentName);
  const bodyId = `vars-app-${app.id}`;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-200",
              !open && "-rotate-90",
            )}
          />
          <AppLogo logo={app.logo} size={32} />
          <span className="min-w-0">
            <span className="block truncate text-base leading-none font-semibold tracking-tight lg:text-lg">
              {app.name}
            </span>
            <span className="mt-1 block truncate text-xs text-muted-foreground">
              {[subtitle, open ? null : plural(rows.length, "variable")]
                .filter(Boolean)
                .join(" · ") || plural(rows.length, "variable")}
            </span>
          </span>
        </button>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={onAdd}>
            <Plus className="size-4" />
            Add
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/apps/${app.slug}/environment`}>
              Open
              <ArrowUpRight className="size-4" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent id={bodyId}>
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">Key</TableHead>
                  <TableHead className="w-full">Value</TableHead>
                  <TableHead className="whitespace-nowrap">
                    Last modified
                  </TableHead>
                  <TableHead className="whitespace-nowrap">
                    Modified by
                  </TableHead>
                  <TableHead className="text-right whitespace-nowrap">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) =>
                  row.kind === "standalone" ? (
                    <TableRow key={`${app.id}:standalone:${row.id}`}>
                      <TableCell className="font-mono text-xs font-medium">
                        {row.key}
                      </TableCell>
                      <TableCell>
                        <EnvValueCell value={row.value} masked={row.masked} />
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                        <TimeAgo at={row.updatedAt} />
                      </TableCell>
                      <TableCell>
                        <EnvAuthorCell
                          author={row.updatedBy ?? row.createdBy ?? null}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <EnvEditButton
                            secret={row.type === "secret"}
                            onClick={() => onEdit(row)}
                          />
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => onDelete(row.id)}
                            aria-label="Delete"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    <TableRow key={`${app.id}:shared:${row.id}`}>
                      <TableCell className="font-mono text-xs font-medium">
                        <div className="flex items-center gap-2">
                          {row.key}
                          <Badge
                            variant="muted"
                            className="gap-1 text-[10px] font-normal whitespace-nowrap"
                          >
                            <Share2 className="size-3" />
                            Shared
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        <EnvValueCell value={row.value} masked={row.masked} />
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                        <TimeAgo at={row.updatedAt} />
                      </TableCell>
                      <TableCell>
                        <EnvAuthorCell author={row.updatedBy ?? null} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {editableSharedIds.has(row.id) ? (
                            <EnvEditButton
                              secret={row.type === "secret"}
                              label="Edit shared variable"
                              onClick={() => onEditShared(row.id)}
                            />
                          ) : (
                            <SimpleTooltip content="Another team owns this variable. Only they can change it.">
                              <span className="text-xs text-muted-foreground">
                                Read-only
                              </span>
                            </SimpleTooltip>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
