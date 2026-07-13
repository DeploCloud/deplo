"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Plus,
  Pencil,
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
  Variable,
} from "lucide-react";
import { AppLogo } from "@/components/shared/project-logo";
import {
  SharedVarDialog,
  type AppRef,
  type ProjectRef,
} from "@/components/env/shared-var-wizard";
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
import { EnvValueCell } from "@/components/env/env-value-cell";
import { EnvVarDialog } from "@/components/env/env-var-dialog";
import { EnvAuthorCell } from "@/components/env/env-author-cell";
import { SharedVarEditDialog } from "@/components/env/shared-var-edit-dialog";
import {
  EnvFilters,
  useEnvFilters,
  editorFacet,
  sourceFacet,
  typeFacet,
  updatedFacet,
  FACET_NONE,
  VIA_LABEL,
  type EnvFacet,
} from "@/components/env/env-filters";
import { gqlAction } from "@/lib/graphql-client";
import { cn, readableTextColor, timeAgo } from "@/lib/utils";
import {
  groupRowsByProject,
  TOP_LEVEL,
  type AppBucket,
  type ProjectBucket,
} from "@/lib/env-grouping";
import type { EnvVarDTO } from "@/lib/types";
import type { AppEnvGroup } from "@/lib/data/env";
import type { AppliedSharedVarDTO, SharedVarDTO } from "@/lib/data/shared-vars";
import type { TeamEnvironment } from "@/lib/data/environments";

/** The app a row belongs to — what the Project / Environment filters read. */
type RowApp = AppEnvGroup["app"];

/**
 * An applied shared var carries no `type` (the DTO never decrypts a value), but
 * the filters key off one — and at the source `masked` IS `type === "secret"`.
 */
type SharedVar = AppliedSharedVarDTO & { type: "plain" | "secret" };

/**
 * Every variable of every app in ONE flat row list, each row carrying its app and
 * the name of the app's project. Flat is what lets the filters cut across cards (a
 * Project filter is a property of the app, a Type filter of the variable) and the
 * sort order the whole page; the sections are folded back out of the survivors
 * afterwards.
 *
 * `projectName` rides on the ROW rather than being looked up in a closure because
 * the search haystack is what reads it, and `useEnvFilters` deliberately does not
 * depend on the haystack function — anything it reads that isn't in the rows goes
 * stale.
 */
type EnvRow =
  | ({ kind: "standalone"; app: RowApp; projectName: string } & EnvVarDTO)
  | ({ kind: "shared"; app: RowApp; projectName: string } & SharedVar);

/**
 * The ids of the sections the user has COLLAPSED, persisted so a page you tidied
 * stays tidy across reloads. Everything not in the set is open — which is what
 * makes "open" the default for a project or an app the user has never touched
 * (including ones created later).
 */
function useCollapsed(storageKey: string) {
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // The state mirror the writers read: computing the next set inside a setState
  // updater would make the localStorage write a side effect of a function React
  // is free to call twice.
  const current = React.useRef(collapsed);

  React.useEffect(() => {
    let stored: string[] = [];
    try {
      const raw = window.localStorage.getItem(storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed))
        stored = parsed.filter((id): id is string => typeof id === "string");
    } catch {
      /* ignore */
    }
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
      } catch {
        /* ignore */
      }
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

/**
 * A card's second line: the environment the app sits in, then how it's reached.
 * The PROJECT is not repeated here — the section header the card sits under is
 * the project.
 */
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

/**
 * The editable aggregate of every app's variables (the Variables page's "App"
 * tab). One collapsible section per Project — open by default — holding one card
 * per app: standalone vars with per-row edit/delete + an Add button, plus the
 * shared vars that apply, shown read-only. The same per-variable editing
 * experience as the single-app page, aggregated across the team.
 *
 * An app with no variables at all gets NO card, and a project with no such app no
 * section — an empty card is pure noise on a page whose whole subject is
 * variables. Reach such an app through its own page.
 */
export function AllAppsEnvManager({
  groups,
  sharedByApp,
  sharedVars,
  apps,
  projects,
  environments,
}: {
  groups: AppEnvGroup[];
  sharedByApp: Record<string, AppliedSharedVarDTO[]>;
  /** Full shared-var DTOs, so a shared row's Edit can open the shared dialog. */
  sharedVars: SharedVarDTO[];
  /** Every app in the active team — the wizard's "specific apps" scope. */
  apps: AppRef[];
  projects: ProjectRef[];
  environments: TeamEnvironment[];
}) {
  const [dialog, setDialog] = React.useState<{
    appId: string;
    editing: EnvVarDTO | null;
  } | null>(null);
  // Editing a shared variable's VALUE and changing WHO gets it are two different
  // dialogs: the row's Edit opens the small form, and only that form's "Change
  // sharing…" hands the variable on to the wizard.
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

  // Every variable of every app, flat. Computed BEFORE the filters so that
  // "nothing matches the search" stays distinguishable from "nothing to search".
  const rows = React.useMemo<EnvRow[]>(
    () =>
      groups.flatMap((g) => {
        const where = g.app.projectId
          ? (projectName.get(g.app.projectId) ?? "")
          : "";
        return [
          ...g.vars.map(
            (v): EnvRow => ({
              ...v,
              kind: "standalone",
              app: g.app,
              projectName: where,
            }),
          ),
          ...(sharedByApp[g.app.id] ?? []).map(
            (v): EnvRow => ({
              ...v,
              kind: "shared",
              type: v.masked ? "secret" : "plain",
              app: g.app,
              projectName: where,
            }),
          ),
        ];
      }),
    [groups, sharedByApp, projectName],
  );

  // This tab is the only place a variable is seen next to every OTHER app's, so
  // it is the only place WHERE the app lives is a filter: its project, and the
  // environment of that project it sits in. The options are the projects and
  // environments the rows actually reach — a project whose apps hold no variable
  // would only ever filter the page down to nothing.
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
          ? [{ value: FACET_NONE, label: "No project", hint: "top level" }]
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
        // Every project has a "Production": the project name is what tells two
        // same-named environments apart in the menu.
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

  // The app AND its project join the search haystack, so "storefront" surfaces
  // that app's variables rather than only the keys that spell it — and "acme"
  // surfaces every app of the Acme project.
  const { state: filters, setState: setFilters, clear, shown, counts } =
    useEnvFilters(rows, facets, (row) => `${row.app.name} ${row.projectName}`);

  // Back into sections, in the order the sort left the rows. Sorting BY KEY is
  // about the keys, not the apps — there the sections and cards stay in name
  // order instead of reshuffling behind the table.
  const sections = React.useMemo<ProjectBucket<EnvRow>[]>(
    () =>
      groupRowsByProject(shown, projects, { byName: filters.sort === "key" }),
    [shown, projects, filters.sort],
  );

  const openSections = sections.filter(
    (s) => !projectCollapse.collapsed.has(s.id),
  ).length;

  /**
   * Collapse (or expand) every section ON SCREEN, by MERGING into the collapsed
   * set rather than replacing it. `sections` is the post-FILTER list, so writing
   * it wholesale would drop the ids of the projects the current search is hiding
   * — and "Collapse all" would then quietly EXPAND a project you had collapsed by
   * hand, as soon as you cleared the search.
   */
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
        icon={Plus}
        title="No apps yet"
        description="Create an app to start adding environment variables."
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Variable}
        title="No variables yet"
        description="None of your apps has an environment variable. Open an app to add its first one, or create a shared variable."
        action={
          <Button variant="outline" asChild>
            <Link href="/apps">
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
        total={rows.length}
        shown={shown.length}
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

      {sections.length > 1 && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
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
        </div>
      )}

      {sections.map((section) => {
        const open = !projectCollapse.collapsed.has(section.id);
        return (
          <section key={section.id} className="space-y-3">
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
        onConfirm={async () => {
          const res = await gqlAction<{ deleteEnv: boolean }>(
            `mutation($id: String!) { deleteEnv(id: $id) }`,
            { id: deleteId! },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </div>
  );
}

/**
 * One Project's collapsible header. It wears the project's own colour — the same
 * ~10% wash / 25% edge the Overview's project cards use — so a section is
 * recognised here the way it is there. Collapsed, its counts are the only thing
 * left to say what is inside, and under an active search those counts are what
 * they matched.
 */
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
  // Hex alpha suffixes: `1a` ≈ 10%, `40` ≈ 25%.
  const headerStyle = color
    ? { backgroundColor: `${color}1a`, borderColor: `${color}40` }
    : undefined;
  const tileStyle = color
    ? { backgroundColor: color, color: readableTextColor(color) }
    : undefined;
  const Glyph = top ? AppWindow : Boxes;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={`vars-project-${section.id}`}
      style={headerStyle}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !color && "hover:bg-accent/40",
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
        <span className="block truncate text-xs text-muted-foreground">
          {plural(section.apps.length, "app")} ·{" "}
          {plural(section.rowCount, "variable")}
        </span>
      </span>
    </button>
  );
}

/**
 * One App's collapsible card: its own variables (editable) and the shared ones
 * that reach it (read-only, edited centrally). Only the title block toggles the
 * card — Add and Open are real actions and must stay clickable, which is also why
 * they can't live inside the toggle (a button never nests in a button).
 */
function AppVarsCard({
  card,
  open,
  onToggle,
  environmentName,
  onAdd,
  onEdit,
  onDelete,
  onEditShared,
}: {
  card: AppBucket<EnvRow>;
  open: boolean;
  onToggle: () => void;
  environmentName: Map<string, string>;
  onAdd: () => void;
  onEdit: (row: EnvVarDTO) => void;
  onDelete: (id: string) => void;
  onEditShared: (id: string) => void;
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
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
            {/* CardTitle's own classes, on a <span>: it renders a <div>, and a
                <div> can't legally live inside a <button>. */}
            <span className="block truncate text-base font-semibold leading-none tracking-tight">
              {app.name}
            </span>
            {/* Where the app is reached, and — once the table is folded away —
                how much it is hiding. */}
            <span className="block truncate text-xs text-muted-foreground">
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
                  <TableHead>Key</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Last modified</TableHead>
                  <TableHead>Modified by</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
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
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        <SimpleTooltip content={new Date(row.updatedAt).toLocaleString()}>
                          <span>{timeAgo(row.updatedAt)}</span>
                        </SimpleTooltip>
                      </TableCell>
                      <TableCell>
                        <EnvAuthorCell author={row.updatedBy ?? row.createdBy ?? null} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => onEdit(row)}
                            aria-label="Edit"
                          >
                            <Pencil className="size-4" />
                          </Button>
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
                          <Badge variant="muted" className="gap-1 text-[10px] font-normal">
                            <Share2 className="size-3" />
                            Shared · {VIA_LABEL[row.via] ?? "Shared"}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs text-muted-foreground">
                          managed centrally
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        <SimpleTooltip content={new Date(row.updatedAt).toLocaleString()}>
                          <span>{timeAgo(row.updatedAt)}</span>
                        </SimpleTooltip>
                      </TableCell>
                      <TableCell>
                        <EnvAuthorCell author={row.updatedBy ?? null} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => onEditShared(row.id)}
                            aria-label="Edit shared variable"
                          >
                            <Pencil className="size-4" />
                          </Button>
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
