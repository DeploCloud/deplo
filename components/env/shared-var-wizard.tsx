"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Loader2,
  AppWindow,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Folders,
  Search,
  Users,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { AppLogo } from "@/components/shared/project-logo";
import { gqlAction } from "@/lib/graphql-client";
import { cn, readableTextColor } from "@/lib/utils";
import { WizardStepper } from "@/components/shared/wizard-stepper";
import { ChoiceCard, CheckMark } from "@/components/shared/choice-card";
import {
  SlidingPanels,
  PANEL_BODY_MAX,
} from "@/components/shared/sliding-panels";
import {
  EnvRowsEditor,
  filledRows,
  invalidRows,
  type EnvRow,
} from "@/components/env/env-rows-editor";
import { SecretRow } from "@/components/env/secret-row";
import { SECRET_EDIT_BLOCKED } from "@/components/env/env-edit-button";
import type { SharedVarDTO } from "@/lib/data/shared-vars";
import type { TeamEnvironment } from "@/lib/data/environments";

/** An App or a Project as the wizard needs it: enough to name and identify. */
export interface WizardRef {
  id: string;
  name: string;
  slug: string;
}

/**
 * An App, plus where it lives and what it looks like.
 */
export interface AppRef extends WizardRef {
  projectId: string | null;
  environmentId: string | null;
  logo: string | null;
  primaryDomain: string | null;
}

/** A Project container, with the colour + counts its Details card shows. */
export interface ProjectRef extends WizardRef {
  color: string | null;
  appCount: number;
  environmentCount: number;
}

type StepId = "variable" | "scope" | "details" | "review";

/** The three sharing scopes. Multi-select - a variable may use any combination.
 *  Team/projects only make the variable AVAILABLE (each app still opts in from
 *  its own Environment tab - ADR-0012); "Specific apps" adds it right away. */
type ScopeId = "team" | "projects" | "apps";

const SCOPES: {
  id: ScopeId;
  title: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    id: "team",
    title: "The whole team",
    blurb:
      "Suggested to every app in the team - each app still adds it explicitly, nothing is injected automatically.",
    icon: Users,
  },
  {
    id: "projects",
    title: "Projects",
    blurb:
      "Suggested to the apps of the projects you pick (narrowable to single environments) - each app still adds it explicitly.",
    icon: Folders,
  },
  {
    id: "apps",
    title: "Specific apps",
    blurb: "Added to the apps you pick right away, wherever they live.",
    icon: AppWindow,
  },
];

/** Creating from inside an app: that app is the destination, fixed. */
export interface WizardAppContext {
  id: string;
  name: string;
}

/**
 * How one checked project shares: with all of its environments (the project id
 * goes to `projectIds`) or with a hand-picked few (those env ids go to
 * `environmentIds` and the project id does NOT).
 */
interface ProjectScope {
  mode: "all" | "some";
  envIds: string[];
}

function initialScopes(editing: SharedVarDTO | null): ScopeId[] {
  if (!editing) return [];
  const out: ScopeId[] = [];
  if (editing.teamWide) out.push("team");
  if (editing.projectIds.length > 0 || editing.environmentIds.length > 0)
    out.push("projects");
  if (editing.appIds.length > 0) out.push("apps");
  return out;
}

function initialProjectScopes(
  editing: SharedVarDTO | null,
  environments: TeamEnvironment[],
): Record<string, ProjectScope> {
  const out: Record<string, ProjectScope> = {};
  for (const id of editing?.projectIds ?? [])
    out[id] = { mode: "all", envIds: [] };
  for (const envId of editing?.environmentIds ?? []) {
    const env = environments.find((e) => e.id === envId);
    if (!env) continue;
    // The old dialog let a var carry a project AND some of that project's
    // environments; the two-way choice can't say both, so the wider one wins.
    const cur = out[env.projectId];
    if (cur?.mode === "all") continue;
    out[env.projectId] = {
      mode: "some",
      envIds: [...(cur?.envIds ?? []), envId],
    };
  }
  return out;
}

const emptyRow = (): EnvRow[] => [{ key: "", value: "" }];

/**
 * Create/edit shared variables, as a wizard: the same key/value table the app's
 * own variables are written in, then WHO gets them, then only the details of
 * what you picked.
 */
export function SharedVarDialog({
  open,
  onOpenChange,
  editing,
  apps,
  projects,
  environments,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing: SharedVarDTO | null;
  apps: AppRef[];
  projects: ProjectRef[];
  environments: TeamEnvironment[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Same box as "Add environment variables": the body owns its height and
          eases between steps instead of padding out to the tallest one. */}
      <DialogContent
        selfManaged
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>
            {editing ? "Edit shared variable" : "New shared variables"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Change who can use it - the key stays as it is."
              : "Write them once, then choose who can use them."}
          </DialogDescription>
        </DialogHeader>
        <SharedVarWizardBody
          editing={editing}
          apps={apps}
          projects={projects}
          environments={environments}
          onOpenChange={onOpenChange}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The wizard itself, without a Dialog of its own: the Variables page hosts it in
 * one, an app's Add-variable modal hosts it as a panel on its own track.
 */
export function SharedVarWizardBody({
  editing,
  apps,
  projects,
  environments,
  appContext,
  onOpenChange,
}: {
  editing: SharedVarDTO | null;
  /** Every app of the team - empty in an app context, where nothing is picked. */
  apps: AppRef[];
  projects: ProjectRef[];
  environments: TeamEnvironment[];
  appContext?: WizardAppContext;
  /** Closes on save and re-opens on a refusal, exactly like a Dialog's own. */
  onOpenChange: (v: boolean) => void;
}) {
  const inApp = appContext != null;
  const [step, setStep] = React.useState<StepId>("variable");
  // A secret's DTO value is the MASK, and the server reads that back as "keep
  // the stored value", so prefilling it is what lets a scope-only edit save.
  const [rows, setRows] = React.useState<EnvRow[]>(() =>
    editing ? [{ key: editing.key, value: editing.value }] : emptyRow(),
  );
  const [secret, setSecret] = React.useState(editing?.type === "secret");
  const [scopes, setScopes] = React.useState<ScopeId[]>(() =>
    initialScopes(editing),
  );
  const [projectScopes, setProjectScopes] = React.useState<
    Record<string, ProjectScope>
  >(() => initialProjectScopes(editing, environments));
  const [appIds, setAppIds] = React.useState<string[]>(editing?.appIds ?? []);
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();
  /** Editing a stored secret: its value, key and type are frozen server-side. */
  const frozen = editing?.type === "secret";

  const envsByProject = React.useMemo(() => {
    const m = new Map<string, TeamEnvironment[]>();
    for (const e of environments) {
      const arr = m.get(e.projectId) ?? [];
      arr.push(e);
      m.set(e.projectId, arr);
    }
    return m;
  }, [environments]);

  const picked = {
    team: scopes.includes("team"),
    projects: scopes.includes("projects"),
    apps: inApp || scopes.includes("apps"),
  };

  // Nothing to configure for a team-wide-only variable, so it never sees Details.
  // In an app context the destination is settled, so there is nothing to review.
  const needsDetails = picked.projects || (!inApp && picked.apps);
  const steps: StepId[] = [
    "variable",
    "scope",
    ...(needsDetails ? (["details"] as const) : []),
    ...(inApp ? [] : (["review"] as const)),
  ];

  const checkedProjects = Object.entries(projectScopes);
  const projectsReady =
    checkedProjects.length > 0 &&
    checkedProjects.every(([, s]) => s.mode === "all" || s.envIds.length > 0);

  const filled = filledRows(rows);
  const badRows = invalidRows(rows);

  const valid: Record<StepId, boolean> = {
    variable: filled.length > 0 && badRows.length === 0,
    // This app is always a destination, so an app context can never be empty.
    scope: inApp || scopes.length > 0,
    details:
      (!picked.projects || projectsReady) &&
      (inApp || !picked.apps || appIds.length > 0),
    review: true,
  };

  const index = Math.max(0, steps.indexOf(step));
  const last = index === steps.length - 1;
  const canGoOn = valid[steps[index]];
  const canSave = steps.every((s) => valid[s]);

  // Only the scopes actually picked reach the server: unchecking "Projects"
  // drops its details rather than saving them invisibly.
  const scoped = {
    teamWide: picked.team,
    projectIds: picked.projects
      ? checkedProjects.filter(([, s]) => s.mode === "all").map(([id]) => id)
      : [],
    environmentIds: picked.projects
      ? checkedProjects.flatMap(([, s]) => (s.mode === "some" ? s.envIds : []))
      : [],
    // Always sent: `saveSharedVar` replaces the whole link set, so an empty
    // array UNLINKS every app. That is deliberate - the wizard checks the "apps"
    // scope whenever the variable has links, so clearing it is an explicit act.
    appIds: inApp ? [appContext.id] : picked.apps ? appIds : [],
  };

  function toggleScope(id: ScopeId) {
    setScopes((cur) =>
      cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id],
    );
  }

  // Enter runs whatever the current step's primary button does: "Next" until the
  // last step, "Save" on it.
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (last) {
      if (canSave && !pending) save();
    } else if (canGoOn) {
      setStep(steps[index + 1]);
    }
  }

  function reset() {
    setRows(emptyRow());
    setSecret(false);
    setScopes([]);
    setProjectScopes({});
    setAppIds([]);
    setStep("variable");
  }

  function save() {
    // Stays open until the writes answer - the state that would carry a refused
    // row back lives INSIDE the dialog, and Radix unmounts that on close. What
    // it never waits for is the refresh behind it, which is the slow half.
    const batch = filled;
    const type = secret ? "secret" : "plain";
    startTransition(async () => {
      // One variable per call - `saveSharedVar` writes one row, and every row of
      // the batch shares the scope picked once.
      const results = await Promise.all(
        batch.map((r) =>
          gqlAction<{ saveSharedVar: { id: string } }>(
            `mutation($input: SaveSharedVarInput!) { saveSharedVar(input: $input) { id } }`,
            {
              input: {
                id: editing?.id,
                key: r.key.trim(),
                value: r.value,
                type,
                ...scoped,
              },
            },
          ),
        ),
      );
      const failed = batch.filter((_, i) => !results[i].ok);
      if (failed.length === 0) {
        onOpenChange(false);
        reset();
        toast.success(
          editing
            ? "Shared variable updated"
            : batch.length === 1
              ? "Shared variable created"
              : `${batch.length} shared variables created`,
        );
      } else {
        // The rows that landed stay landed; the ones that did not stay in the
        // table, with the server's own words for why.
        const first = results.find((r) => !r.ok);
        const done = batch.length - failed.length;
        const why = first && !first.ok ? first.error : "Something went wrong";
        setRows(failed);
        setStep("variable");
        toast.error(
          done > 0 ? `${done} created, ${failed.length} failed. ${why}` : why,
        );
      }
      router.refresh();
    });
  }

  const stepLabel: Record<StepId, string> = {
    variable: editing ? "Variable" : "Variables",
    scope: "Shared with",
    details: "Details",
    review: "Review",
  };

  return (
    <form className="flex min-h-0 flex-col" onSubmit={onSubmit}>
      {/* Nested in an app's Add-variable modal there is a back row above this
          one, so the rail needs its own top padding; under a DialogHeader the
          header's `pb-4` already provides it. */}
      <div className={cn("border-b border-border px-6 pb-4", inApp && "pt-4")}>
        <WizardStepper
          steps={steps.map((s) => ({ id: s, label: stepLabel[s] }))}
          current={steps[index]}
          // A step is reachable once every step before it is complete, which,
          // when editing, is all of them from the first render.
          reachable={(s) =>
            steps.slice(0, steps.indexOf(s)).every((p) => valid[p])
          }
          onSelect={setStep}
        />
      </div>

      <SlidingPanels
        panels={steps}
        current={steps[index]}
        labelFor={(s) => stepLabel[s]}
        render={(s) => (
          <div
            className={cn(
              "space-y-4 overflow-y-auto px-6 py-4",
              PANEL_BODY_MAX,
            )}
          >
            {s === "variable" && (
              <>
                <EnvRowsEditor
                  rows={rows}
                  onChange={setRows}
                  keyPlaceholder="DATABASE_URL"
                  singleRow={!!editing}
                  keyDisabled={!!editing}
                  valueReadOnly={frozen}
                />
                {frozen ? (
                  <p className="text-xs text-muted-foreground">
                    {SECRET_EDIT_BLOCKED} You can still change who it is shared
                    with.
                  </p>
                ) : (
                  <SecretRow secret={secret} onChange={setSecret} />
                )}
              </>
            )}

            {s === "scope" && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {inApp
                    ? "This app gets it right away. Pick who else may use it."
                    : "Pick one or more. Only “Specific apps” adds it somewhere right away."}
                </p>
                <div
                  role="group"
                  aria-label="Shared with"
                  className="space-y-2"
                >
                  {inApp && <ThisApp name={appContext.name} />}
                  {SCOPES.filter((sc) => !inApp || sc.id !== "apps").map(
                    (sc) => (
                      <ChoiceCard
                        multi
                        key={sc.id}
                        title={sc.title}
                        blurb={sc.blurb}
                        icon={sc.icon}
                        selected={scopes.includes(sc.id)}
                        disabled={
                          (sc.id === "projects" && projects.length === 0) ||
                          (sc.id === "apps" && apps.length === 0)
                        }
                        disabledNote={
                          sc.id === "projects"
                            ? "No projects yet."
                            : "No apps yet."
                        }
                        onSelect={() => toggleScope(sc.id)}
                      />
                    ),
                  )}
                </div>
              </div>
            )}

            {s === "details" && (
              <div className="space-y-6">
                {picked.projects && (
                  <ProjectsSection
                    projects={projects}
                    envsByProject={envsByProject}
                    scopes={projectScopes}
                    onChange={setProjectScopes}
                  />
                )}
                {picked.projects && !inApp && picked.apps && (
                  <hr className="border-border" />
                )}
                {!inApp && picked.apps && (
                  <AppsSection
                    apps={apps}
                    selected={appIds}
                    onChange={setAppIds}
                  />
                )}
              </div>
            )}

            {s === "review" && (
              <Review
                varKeys={filled.map((r) => r.key.trim())}
                secret={secret}
                teamWide={scoped.teamWide}
                projects={projects}
                environments={environments}
                projectScopes={picked.projects ? projectScopes : {}}
                apps={apps}
                appIds={scoped.appIds}
              />
            )}
          </div>
        )}
      />

      <DialogFooter className="items-center border-t border-border px-6 py-4">
        {/* Kept in the footer, hidden on the first step: a disabled Back reads
            as something broken, and removing it would move Cancel across. */}
        <Button
          variant="ghost"
          onClick={() => setStep(steps[index - 1])}
          disabled={index === 0 || pending}
          className={cn(index === 0 && "invisible")}
        >
          <ChevronLeft className="size-4" />
          Back
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          {last ? (
            <Button type="submit" disabled={pending || !canSave}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              {editing
                ? "Save"
                : filled.length > 1
                  ? `Create ${filled.length}`
                  : "Create"}
            </Button>
          ) : (
            <Button type="submit" disabled={!canGoOn}>
              Next
              <ChevronRight className="size-4" />
            </Button>
          )}
        </div>
      </DialogFooter>
    </form>
  );
}

/** The destination you cannot unpick: the app the modal was opened from. */
function ThisApp({ name }: { name: string }) {
  return (
    <div className="flex w-full items-start gap-3 rounded-lg border border-primary bg-primary/[0.06] p-3 text-left ring-1 ring-primary/60">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/40 bg-background text-primary">
        <AppWindow className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">
          This app · {name}
        </span>
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
          Added right away - it reaches the app on its next deploy.
        </span>
      </span>
      <CheckMark selected />
    </div>
  );
}

/** Details for the "Projects" scope: which projects, and how much of each. */
function ProjectsSection({
  projects,
  envsByProject,
  scopes,
  onChange,
}: {
  projects: ProjectRef[];
  envsByProject: Map<string, TeamEnvironment[]>;
  scopes: Record<string, ProjectScope>;
  onChange: (next: Record<string, ProjectScope>) => void;
}) {
  const [q, setQ] = React.useState("");
  const shown = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return projects;
    return projects.filter((p) =>
      `${p.name} ${p.slug}`.toLowerCase().includes(needle),
    );
  }, [projects, q]);

  // Search hides rows, never selections - the count is the only thing that can
  // vouch for a checked project the current needle filtered out of view.
  const count = Object.keys(scopes).length;

  function toggleProject(id: string) {
    const next = { ...scopes };
    if (next[id]) delete next[id];
    else next[id] = { mode: "all", envIds: [] };
    onChange(next);
  }

  function setMode(id: string, mode: ProjectScope["mode"]) {
    onChange({ ...scopes, [id]: { mode, envIds: scopes[id]?.envIds ?? [] } });
  }

  function toggleEnv(id: string, envId: string) {
    const cur = scopes[id]?.envIds ?? [];
    const envIds = cur.includes(envId)
      ? cur.filter((e) => e !== envId)
      : [...cur, envId];
    onChange({ ...scopes, [id]: { mode: "some", envIds } });
  }

  return (
    <section className="space-y-2">
      <div>
        <h4 className="text-sm font-medium">Projects</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick the projects whose apps should see this variable suggested -
          narrow a project to single environments if you like. Each app still
          adds it itself. {count > 0 && `${count} selected.`}
        </p>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search projects"
          aria-label="Search projects"
          className="h-9 pl-9"
          // A filter box, not a field of the form: Enter here would otherwise
          // advance the wizard mid-search.
          onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
        />
      </div>
      {shown.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {q.trim()
            ? `No project matches “${q.trim()}”.`
            : "This team has no projects yet."}
        </p>
      )}
      {/* No scroller of its own: the dialog's body is the ONE scrolling region,
          so a long project list never traps the wheel in a nested box. */}
      <div className="space-y-2">
        {shown.map((p) => {
          const scope = scopes[p.id];
          const envs = envsByProject.get(p.id) ?? [];
          return (
            <div
              key={p.id}
              className={cn(
                "rounded-lg border transition-colors",
                scope
                  ? "border-primary bg-primary/[0.06] ring-1 ring-primary/60"
                  : "border-border hover:border-foreground/20",
              )}
            >
              <label className="flex cursor-pointer items-center gap-3 p-3 text-sm">
                <Checkbox
                  checked={!!scope}
                  onCheckedChange={() => toggleProject(p.id)}
                />
                <ProjectTile color={p.color} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {p.appCount} app{p.appCount === 1 ? "" : "s"} ·{" "}
                    {envs.length} environment{envs.length === 1 ? "" : "s"}
                  </span>
                </span>
              </label>

              {scope && (
                <div className="space-y-2 border-t border-border/60 px-3 py-2">
                  {envs.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Suggested to every app in this project.
                    </p>
                  ) : (
                    <>
                      <div
                        role="radiogroup"
                        aria-label={`${p.name} scope`}
                        className="flex flex-wrap gap-1"
                      >
                        <ModeButton
                          selected={scope.mode === "all"}
                          onSelect={() => setMode(p.id, "all")}
                        >
                          All environments
                        </ModeButton>
                        <ModeButton
                          selected={scope.mode === "some"}
                          onSelect={() => setMode(p.id, "some")}
                        >
                          Some environments
                        </ModeButton>
                      </div>
                      {scope.mode === "some" && (
                        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                          {envs.map((e) => (
                            <label
                              key={e.id}
                              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent"
                            >
                              <Checkbox
                                checked={scope.envIds.includes(e.id)}
                                onCheckedChange={() => toggleEnv(p.id, e.id)}
                              />
                              <span className="truncate">{e.name}</span>
                            </label>
                          ))}
                        </div>
                      )}
                      {scope.mode === "some" && scope.envIds.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          Pick at least one environment, or share with all of
                          them.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {count === 0 && (
        <p className="text-xs text-muted-foreground">
          Pick at least one project.
        </p>
      )}
    </section>
  );
}

/** The all/some switch of one checked project. */
function ModeButton({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "rounded-md border px-2.5 py-1 text-xs transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        selected
          ? "border-primary bg-primary/10 font-medium text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Details for the "Specific apps" scope: a searchable grid of app cards. */
function AppsSection({
  apps,
  selected,
  onChange,
}: {
  apps: AppRef[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [q, setQ] = React.useState("");
  // The domain is on the card, so it's also worth searching: "the app on
  // shop.acme.com" is how you remember an app you named `web`.
  const shown = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return apps;
    return apps.filter((a) =>
      `${a.name} ${a.slug} ${a.primaryDomain ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [apps, q]);

  function toggle(id: string) {
    onChange(
      selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id],
    );
  }

  return (
    <section className="space-y-2">
      <div>
        <h4 className="text-sm font-medium">Apps</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick the apps to add this variable to - it reaches them on their next
          deploy. {selected.length > 0 && `${selected.length} selected.`}
        </p>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search apps by name or domain"
          aria-label="Search apps"
          className="h-9 pl-9"
          // A filter box, not a field of the form: Enter here would otherwise
          // advance the wizard mid-search.
          onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
        />
      </div>
      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {q.trim()
            ? `No app matches “${q.trim()}”.`
            : "This team has no apps yet."}
        </p>
      ) : (
        <div role="group" aria-label="Apps" className="grid grid-cols-1 gap-2">
          {shown.map((a) => {
            const on = selected.includes(a.id);
            return (
              <button
                key={a.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(a.id)}
                className={cn(
                  "flex items-center gap-3 rounded-lg border p-3 text-left transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
                  on
                    ? "border-primary bg-primary/[0.06] ring-1 ring-primary/60"
                    : "border-border hover:border-foreground/20 hover:bg-muted/40",
                )}
              >
                <AppLogo logo={a.logo} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {a.name}
                  </span>
                  {/* The primary domain is the app's identity at a glance; the
                      slug stands in until one exists. */}
                  <span className="mt-1 block truncate text-xs text-muted-foreground">
                    {a.primaryDomain ?? `${a.slug} · no domain yet`}
                  </span>
                </span>
                <CheckMark selected={on} />
              </button>
            );
          })}
        </div>
      )}
      {selected.length === 0 && (
        <p className="text-xs text-muted-foreground">Pick at least one app.</p>
      )}
    </section>
  );
}

/** A Project's avatar: its colour, or the neutral tile when it has none. */
function ProjectTile({ color }: { color: string | null }) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md",
        color ? "" : "bg-secondary text-muted-foreground",
      )}
      style={
        color
          ? { backgroundColor: color, color: readableTextColor(color) }
          : undefined
      }
    >
      <Boxes className="size-4" />
    </span>
  );
}

/** The last step: everything the Save button is about to do, as chips. */
function Review({
  varKeys,
  secret,
  teamWide,
  projects,
  environments,
  projectScopes,
  apps,
  appIds,
}: {
  varKeys: string[];
  secret: boolean;
  teamWide: boolean;
  projects: WizardRef[];
  environments: TeamEnvironment[];
  projectScopes: Record<string, ProjectScope>;
  apps: AppRef[];
  appIds: string[];
}) {
  const name = (list: WizardRef[], id: string) =>
    list.find((x) => x.id === id)?.name ?? id;

  // `apps` is every app in the active team, so every count below is exact as of
  // now. Availability scopes only SUGGEST (each app opts in itself, ADR-0012),
  // so the counts read "can add it"; only the Apps group adds anything directly.
  const reach = (scope: ProjectScope, projectId: string) =>
    scope.mode === "all"
      ? apps.filter((a) => a.projectId === projectId).length
      : apps.filter(
          (a) =>
            a.environmentId != null && scope.envIds.includes(a.environmentId),
        ).length;
  const appCount = (n: number) => `${n} app${n === 1 ? "" : "s"}`;

  // Keyed by ENTITY id, never by the label: two projects (or an app and a
  // project) may legitimately carry the same name.
  const projectChips = Object.entries(projectScopes).map(
    ([projectId, scope]) => ({
      id: projectId,
      label:
        (scope.mode === "all"
          ? `${name(projects, projectId)} · all environments`
          : `${name(projects, projectId)} · ${scope.envIds
              .map((id) => environments.find((e) => e.id === id)?.name ?? id)
              .join(", ")}`) +
        ` → ${appCount(reach(scope, projectId))} can add it`,
    }),
  );
  const appChips = appIds.map((id) => ({ id, label: name(apps, id) }));
  const teamChips = teamWide
    ? [
        {
          id: "team",
          label: `Every app in the team can add it - ${appCount(apps.length)} today`,
        },
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {varKeys.length === 1 ? "Variable" : `${varKeys.length} variables`}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {varKeys.map((k) => (
            <code key={k} className="font-mono text-sm font-medium">
              {k}
            </code>
          ))}
          <Badge variant="muted" className="text-[10px]">
            {secret ? "Secret" : "Plain"}
          </Badge>
        </div>
      </div>
      <div className="space-y-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Available to
        </p>
        <ChipGroup title="Whole team" chips={teamChips} />
        <ChipGroup title="Projects" chips={projectChips} />
        <ChipGroup title="Added to these apps" chips={appChips} />
      </div>
    </div>
  );
}

/** One labelled row of scope chips - the label is what tells a project from an app. */
function ChipGroup({
  title,
  chips,
}: {
  title: string;
  chips: { id: string; label: string }[];
}) {
  if (chips.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <Badge key={c.id} variant="muted" className="text-[11px] font-normal">
            {c.label}
          </Badge>
        ))}
      </div>
    </div>
  );
}
