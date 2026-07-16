"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AppWindow,
  Boxes,
  Check,
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
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { FieldLabel } from "@/components/ui/info-tip";
import { AppLogo } from "@/components/shared/project-logo";
import { gqlAction } from "@/lib/graphql-client";
import { cn, readableTextColor } from "@/lib/utils";
import type { SharedVarDTO } from "@/lib/data/shared-vars";
import type { TeamEnvironment } from "@/lib/data/environments";

/** An App or a Project as the wizard needs it: enough to name and identify. */
export interface WizardRef {
  id: string;
  name: string;
  slug: string;
}

/**
 * An App, plus where it lives and what it looks like. The two ids are exactly
 * what the server matches a shared variable's project/environment scope against
 * (`listSharedVarsForApp`), so counting apps by them on Review gives the same
 * reach the deploy will; the logo and the primary domain are what the Details
 * cards show, so you recognise an app without reading its slug.
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

/** Mirrors the server's key rule (lib/data/shared-vars.ts) so a bad key fails on step 1. */
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

type StepId = "variable" | "scope" | "details" | "review";

/** The three sharing scopes. Multi-select — a variable may use any combination.
 *  Team/projects only make the variable AVAILABLE (each app still opts in from
 *  its own Environment tab — ADR-0012); "Specific apps" adds it right away. */
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
      "Suggested to every app in the team — each app still adds it explicitly, nothing is injected automatically.",
    icon: Users,
  },
  {
    id: "projects",
    title: "Projects",
    blurb:
      "Suggested to the apps of the projects you pick (narrowable to single environments) — each app still adds it explicitly.",
    icon: Folders,
  },
  {
    id: "apps",
    title: "Specific apps",
    blurb: "Added to the apps you pick right away, wherever they live.",
    icon: AppWindow,
  },
];

const STEP_LABEL: Record<StepId, string> = {
  variable: "Variable",
  scope: "Shared with",
  details: "Details",
  review: "Review",
};

/**
 * How one checked project shares: with all of its environments (the project id
 * goes to `projectIds`) or with a hand-picked few (those env ids go to
 * `environmentIds` and the project id does NOT). The two are mutually exclusive
 * — "all" already covers every environment.
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
  for (const id of editing?.projectIds ?? []) out[id] = { mode: "all", envIds: [] };
  for (const envId of editing?.environmentIds ?? []) {
    const env = environments.find((e) => e.id === envId);
    if (!env) continue;
    // The old dialog let a var carry a project AND some of that project's
    // environments; the two-way choice can't say both, so the wider one wins.
    const cur = out[env.projectId];
    if (cur?.mode === "all") continue;
    out[env.projectId] = { mode: "some", envIds: [...(cur?.envIds ?? []), envId] };
  }
  return out;
}

/**
 * Create/edit one shared variable, as a wizard: name and value, then WHO gets
 * it, then only the details of what you picked. Its predecessor showed every
 * scope picker at once — team-wide switch, project grid, environment grid — and
 * was unreadable.
 *
 * Named `SharedVarDialog` because both the Shared tab and the aggregate App tab
 * open it as the one editor for a shared variable.
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
  const [step, setStep] = React.useState<StepId>("variable");
  const [key, setKey] = React.useState(editing?.key ?? "");
  // A secret's DTO value is the MASK, and the server reads that back as "keep
  // the stored value" — so prefilling it is what lets a scope-only edit save.
  const [value, setValue] = React.useState(editing?.value ?? "");
  const [secret, setSecret] = React.useState(editing?.type === "secret");
  const [scopes, setScopes] = React.useState<ScopeId[]>(() => initialScopes(editing));
  const [projectScopes, setProjectScopes] = React.useState<
    Record<string, ProjectScope>
  >(() => initialProjectScopes(editing, environments));
  const [appIds, setAppIds] = React.useState<string[]>(editing?.appIds ?? []);
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

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
    apps: scopes.includes("apps"),
  };

  // Nothing to configure for a team-wide-only variable, so it never sees Details.
  const steps: StepId[] = [
    "variable",
    "scope",
    ...(picked.projects || picked.apps ? (["details"] as const) : []),
    "review",
  ];

  const checkedProjects = Object.entries(projectScopes);
  const projectsReady =
    checkedProjects.length > 0 &&
    checkedProjects.every(([, s]) => s.mode === "all" || s.envIds.length > 0);

  // Caught on step 1, not on Save four steps later.
  const keyInvalid = key.trim() !== "" && !KEY_RE.test(key.trim());

  const valid: Record<StepId, boolean> = {
    variable: KEY_RE.test(key.trim()),
    scope: scopes.length > 0,
    details:
      (!picked.projects || projectsReady) && (!picked.apps || appIds.length > 0),
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
    // array UNLINKS every app. That is deliberate — the wizard checks the "apps"
    // scope whenever the variable has links, so clearing it is an explicit act.
    appIds: picked.apps ? appIds : [],
  };

  function toggleScope(id: ScopeId) {
    setScopes((cur) =>
      cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id],
    );
  }

  function save() {
    startTransition(async () => {
      const res = await gqlAction<{ saveSharedVar: { id: string } }>(
        `mutation($input: SaveSharedVarInput!) { saveSharedVar(input: $input) { id } }`,
        {
          input: {
            id: editing?.id,
            key,
            value,
            type: secret ? "secret" : "plain",
            ...scoped,
          },
        },
      );
      if (res.ok) {
        toast.success(editing ? "Shared variable updated" : "Shared variable created");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Wide AND tall: the Details step lays its project + app cards out side by
          side, and each card carries an icon, a name and a domain under it. The
          height is FIXED (not content-driven) so the stepper and the Back/Next
          buttons hold their place instead of jumping around as you move between a
          three-field form and a hundred app cards — only the middle row scrolls. */}
      <DialogContent className="h-[min(90vh,52rem)] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit shared variable" : "New shared variable"}
          </DialogTitle>
          <DialogDescription>
            Write the variable once, then choose who can use it. Apps opt in —
            a shared variable is never added to an app automatically.
          </DialogDescription>
        </DialogHeader>

        <Stepper
          steps={steps}
          current={steps[index]}
          // A step is reachable once every step before it is complete — which,
          // when editing, is all of them from the first render.
          reachable={(s) => steps.slice(0, steps.indexOf(s)).every((p) => valid[p])}
          onSelect={setStep}
        />

        {/* The one scrolling row. The form steps keep a readable measure inside the
            wide dialog; only Details (the card grids) uses the full width. */}
        <div className="overflow-y-auto pr-1">
        {steps[index] === "variable" && (
          <div className="mx-auto w-full max-w-xl space-y-4">
            <div className="space-y-2">
              <FieldLabel info="The variable's name, exposed to apps during builds and at runtime. It can't be renamed once created.">
                Key
              </FieldLabel>
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="DATABASE_URL"
                aria-invalid={keyInvalid}
                className={cn(
                  "font-mono text-sm",
                  keyInvalid && "border-destructive focus-visible:ring-destructive",
                )}
                disabled={!!editing}
                autoFocus={!editing}
              />
              {keyInvalid && (
                <p className="text-xs text-destructive">
                  “{key.trim()}” isn&apos;t a valid variable name. Names must start
                  with a letter or underscore and contain only letters, digits and
                  underscores.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Value</label>
              <Textarea
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={editing ? "Enter a new value" : "value"}
                rows={3}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium">Secret</p>
                <p className="text-xs text-muted-foreground">
                  Hide the value in the UI after saving. It can never be read back.
                </p>
              </div>
              <Switch checked={secret} onCheckedChange={setSecret} />
            </div>
          </div>
        )}

        {steps[index] === "scope" && (
          <div className="mx-auto w-full max-w-xl space-y-3">
            <p className="text-sm text-muted-foreground">
              Who is this variable for? Pick one or more — you&apos;ll fill in
              the details next. Only “Specific apps” adds it somewhere right
              away; the other scopes suggest it and each app opts in itself.
            </p>
            <div role="group" aria-label="Shared with" className="space-y-2">
              {SCOPES.map((s) => (
                <ScopeCard
                  key={s.id}
                  title={s.title}
                  blurb={s.blurb}
                  icon={s.icon}
                  selected={scopes.includes(s.id)}
                  disabled={
                    (s.id === "projects" && projects.length === 0) ||
                    (s.id === "apps" && apps.length === 0)
                  }
                  disabledNote={
                    s.id === "projects" ? "No projects yet." : "No apps yet."
                  }
                  onSelect={() => toggleScope(s.id)}
                />
              ))}
            </div>
          </div>
        )}

        {steps[index] === "details" && (
          <div className="space-y-6">
            {picked.projects && (
              <ProjectsSection
                projects={projects}
                envsByProject={envsByProject}
                scopes={projectScopes}
                onChange={setProjectScopes}
              />
            )}
            {picked.projects && picked.apps && (
              <hr className="border-border" />
            )}
            {picked.apps && (
              <AppsSection
                apps={apps}
                selected={appIds}
                onChange={setAppIds}
              />
            )}
          </div>
        )}

        {steps[index] === "review" && (
          <div className="mx-auto w-full max-w-xl">
            <Review
              varKey={key}
              secret={secret}
              teamWide={scoped.teamWide}
              projects={projects}
              environments={environments}
              projectScopes={picked.projects ? projectScopes : {}}
              apps={apps}
              appIds={scoped.appIds}
            />
          </div>
        )}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            onClick={() => setStep(steps[index - 1])}
            disabled={index === 0 || pending}
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
              <Button onClick={save} disabled={pending || !canSave}>
                {pending ? "Saving…" : "Save"}
              </Button>
            ) : (
              <Button
                onClick={() => setStep(steps[index + 1])}
                disabled={!canGoOn}
              >
                Next
                <ChevronRight className="size-4" />
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The step rail: where you are, what's left, and a way back to a done step. */
function Stepper({
  steps,
  current,
  reachable,
  onSelect,
}: {
  steps: StepId[];
  current: StepId;
  reachable: (s: StepId) => boolean;
  onSelect: (s: StepId) => void;
}) {
  const at = steps.indexOf(current);
  return (
    <ol className="flex items-center gap-1">
      {steps.map((s, i) => {
        const done = i < at;
        const active = i === at;
        const open = reachable(s);
        return (
          <li key={s} className="flex min-w-0 items-center gap-1">
            {i > 0 && <span aria-hidden className="w-3 border-t border-border" />}
            <button
              type="button"
              onClick={() => onSelect(s)}
              disabled={!open}
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-secondary font-medium text-foreground"
                  : open
                    ? "text-muted-foreground hover:text-foreground"
                    : "text-muted-foreground/50",
              )}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px]",
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : done
                      ? "border-primary/40 text-primary"
                      : "border-border",
                )}
              >
                {done ? <Check className="size-3" /> : i + 1}
              </span>
              <span className="truncate">{STEP_LABEL[s]}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** One sharing mode, as a big multi-select card (this is a checkbox, not a radio). */
function ScopeCard({
  title,
  blurb,
  icon: Icon,
  selected,
  disabled,
  disabledNote,
  onSelect,
}: {
  title: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
  selected: boolean;
  disabled: boolean;
  disabledNote: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-primary bg-primary/[0.06] ring-1 ring-primary/60"
          : "border-border hover:border-foreground/20 hover:bg-muted/40",
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors",
          selected
            ? "border-primary/40 bg-background text-primary"
            : "border-border bg-muted/50 text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
          {disabled ? disabledNote : blurb}
        </span>
      </span>
      <CheckMark selected={selected} className="mt-0.5" />
    </button>
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

  // Search hides rows, never selections — the count is the only thing that can
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
        <p className="text-xs text-muted-foreground">
          Pick the projects whose apps should see this variable suggested —
          narrow a project to single environments if you like. Each app still
          adds it itself. {count > 0 && `${count} selected.`}
        </p>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search projects…"
          aria-label="Search projects"
          className="h-9 pl-9"
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
                  <span className="block truncate text-xs text-muted-foreground">
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
                          Selected environments…
                        </ModeButton>
                      </div>
                      {scope.mode === "some" && (
                        <div className="grid grid-cols-1 gap-1 sm:grid-cols-3">
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
                          Pick at least one environment, or share with all of them.
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
        <p className="text-xs text-muted-foreground">Pick at least one project.</p>
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
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
        <p className="text-xs text-muted-foreground">
          Pick the apps to add this variable to — it reaches them on their next
          deploy. {selected.length > 0 && `${selected.length} selected.`}
        </p>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search apps by name or domain…"
          aria-label="Search apps"
          className="h-9 pl-9"
        />
      </div>
      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {q.trim()
            ? `No app matches “${q.trim()}”.`
            : "This team has no apps yet."}
        </p>
      ) : (
        <div
          role="group"
          aria-label="Apps"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
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
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
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
                  <span className="block truncate text-xs text-muted-foreground">
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

/** The square tick of a card that IS a checkbox (ScopeCard, app cards). */
function CheckMark({
  selected,
  className,
}: {
  selected: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-muted-foreground/40",
        className,
      )}
    >
      {selected && <Check className="size-3" />}
    </span>
  );
}

/** The last step: everything the Save button is about to do, as chips. */
function Review({
  varKey,
  secret,
  teamWide,
  projects,
  environments,
  projectScopes,
  apps,
  appIds,
}: {
  varKey: string;
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
          (a) => a.environmentId != null && scope.envIds.includes(a.environmentId),
        ).length;
  const appCount = (n: number) => `${n} app${n === 1 ? "" : "s"}`;

  // Keyed by ENTITY id, never by the label: two projects (or an app and a
  // project) may legitimately carry the same name.
  const projectChips = Object.entries(projectScopes).map(([projectId, scope]) => ({
    id: projectId,
    label:
      (scope.mode === "all"
        ? `${name(projects, projectId)} · all environments`
        : `${name(projects, projectId)} · ${scope.envIds
            .map((id) => environments.find((e) => e.id === id)?.name ?? id)
            .join(", ")}`) + ` → ${appCount(reach(scope, projectId))} can add it`,
  }));
  const appChips = appIds.map((id) => ({ id, label: name(apps, id) }));
  const teamChips = teamWide
    ? [
        {
          id: "team",
          label: `Every app in the team can add it — ${appCount(apps.length)} today`,
        },
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Variable
        </p>
        <div className="flex items-center gap-2">
          <code className="font-mono text-sm font-medium">{varKey}</code>
          <Badge variant="muted" className="text-[10px]">
            {secret ? "Secret" : "Plain"}
          </Badge>
        </div>
      </div>
      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Available to
        </p>
        <ChipGroup title="Whole team" chips={teamChips} />
        <ChipGroup title="Projects" chips={projectChips} />
        <ChipGroup title="Added to these apps" chips={appChips} />
      </div>
    </div>
  );
}

/** One labelled row of scope chips — the label is what tells a project from an app. */
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
