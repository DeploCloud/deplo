"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { WizardStepper } from "@/components/shared/wizard-stepper";
import {
  SlidingPanels,
  PANEL_BODY_MAX,
  PANEL_BODY_MAX_NESTED,
} from "@/components/shared/sliding-panels";
import {
  filledRows,
  invalidRows,
  type EnvRow,
} from "@/components/env/env-rows-editor";
import type { SharedVarDTO } from "@/lib/data/shared-vars/team-view";
import type { TeamEnvironment } from "@/lib/data/environments";
import type {
  AppRef,
  ProjectRef,
  ProjectScope,
  ScopeId,
  StepId,
  TeamRef,
} from "./types";
import { emptyRow, initialProjectScopes, initialScopes } from "./initial-state";
import { VariableStep } from "./variable-step";
import { ScopeStep } from "./scope-step";
import { TeamsSection } from "./team-picker";
import { ProjectsSection } from "./project-picker";
import { AppsSection } from "./app-picker";
import { Review } from "./review-step";

export function SharedVarWizardBody({
  editing,
  apps,
  projects,
  environments,
  teams,
  defaultAppIds,
  nested = false,
  onOpenChange,
}: {
  editing: SharedVarDTO | null;
  apps: AppRef[];
  projects: ProjectRef[];
  environments: TeamEnvironment[];
  teams: TeamRef[];
  defaultAppIds?: string[];
  nested?: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [step, setStep] = React.useState<StepId>(
    editing ? "scope" : "variable",
  );
  const [rows, setRows] = React.useState<EnvRow[]>(() =>
    editing ? [{ key: editing.key, value: editing.value }] : emptyRow(),
  );
  const [secret, setSecret] = React.useState(editing?.type === "secret");
  const [scopes, setScopes] = React.useState<ScopeId[]>(() =>
    initialScopes(editing, defaultAppIds),
  );
  const [projectScopes, setProjectScopes] = React.useState<
    Record<string, ProjectScope>
  >(() => initialProjectScopes(editing, environments));
  const [teamIds, setTeamIds] = React.useState<string[]>(() =>
    editing ? editing.teamIds : teams.map((t) => t.id),
  );
  const [appIds, setAppIds] = React.useState<string[]>(
    editing?.appIds ?? defaultAppIds ?? [],
  );
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();
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
    apps: scopes.includes("apps"),
  };

  const lockedTeams = (editing?.teams ?? []).filter(
    (t) => !teams.some((o) => o.id === t.id),
  );
  const teamPickerRows = teams.length + lockedTeams.length;

  const needsDetails =
    (picked.team && teamPickerRows > 1) || picked.projects || picked.apps;
  const steps: StepId[] = [
    "variable",
    "scope",
    ...(needsDetails ? (["details"] as const) : []),
    "review",
  ];

  const checkedProjects = Object.entries(projectScopes);
  const projectsReady =
    checkedProjects.length > 0 &&
    checkedProjects.every(([, s]) => s.mode === "all" || s.envIds.length > 0);

  const filled = filledRows(rows);
  const badRows = invalidRows(rows);

  const valid: Record<StepId, boolean> = {
    variable: filled.length > 0 && badRows.length === 0,
    scope: scopes.length > 0,
    details:
      (!picked.team || teamIds.length > 0) &&
      (!picked.projects || projectsReady) &&
      (!picked.apps || appIds.length > 0),
    review: true,
  };

  const index = Math.max(0, steps.indexOf(step));
  const last = index === steps.length - 1;
  const canGoOn = valid[steps[index]];
  const canSave = steps.every((s) => valid[s]);

  const scoped = {
    teamIds: picked.team ? teamIds : [],
    projectIds: picked.projects
      ? checkedProjects.filter(([, s]) => s.mode === "all").map(([id]) => id)
      : [],
    environmentIds: picked.projects
      ? checkedProjects.flatMap(([, s]) => (s.mode === "some" ? s.envIds : []))
      : [],
    appIds: picked.apps ? appIds : [],
  };

  function toggleScope(id: ScopeId) {
    setScopes((cur) =>
      cur.includes(id) ? cur.filter((s) => s !== id) : [...cur, id],
    );
  }

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
    setScopes(initialScopes(null, defaultAppIds));
    setProjectScopes({});
    setAppIds(defaultAppIds ?? []);
    setStep("variable");
  }

  function save() {
    const batch = filled.filter(
      (r, i) => filled.findIndex((o) => o.key.trim() === r.key.trim()) === i,
    );
    const type = secret ? "secret" : "plain";
    startTransition(async () => {
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
      <div className={cn("border-b border-border px-6 pb-4", nested && "pt-4")}>
        <WizardStepper
          steps={steps.map((s) => ({ id: s, label: stepLabel[s] }))}
          current={steps[index]}
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
              nested ? PANEL_BODY_MAX_NESTED : PANEL_BODY_MAX,
            )}
          >
            {s === "variable" && (
              <VariableStep
                rows={rows}
                onRowsChange={setRows}
                editing={!!editing}
                frozen={frozen}
                secret={secret}
                onSecretChange={setSecret}
              />
            )}

            {s === "scope" && (
              <ScopeStep
                scopes={scopes}
                projects={projects}
                apps={apps}
                onToggle={toggleScope}
              />
            )}

            {s === "details" && (
              <div className="space-y-6">
                {picked.team && teamPickerRows > 1 && (
                  <TeamsSection
                    teams={teams}
                    locked={lockedTeams}
                    selected={teamIds}
                    onChange={setTeamIds}
                  />
                )}
                {picked.team && teamPickerRows > 1 && picked.projects && (
                  <hr className="border-border" />
                )}
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

            {s === "review" && (
              <Review
                varKeys={filled.map((r) => r.key.trim())}
                secret={secret}
                teams={teams}
                teamIds={scoped.teamIds}
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
