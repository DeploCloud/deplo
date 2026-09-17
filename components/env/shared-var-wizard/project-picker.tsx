"use client";

import * as React from "react";
import { Boxes } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn, readableTextColor } from "@/lib/utils";
import type { TeamEnvironment } from "@/lib/data/environments";
import type { ProjectRef, ProjectScope } from "./types";
import { PickerSearch } from "./picker-search";

export function ProjectsSection({
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
      <PickerSearch
        value={q}
        onChange={setQ}
        placeholder="Search projects"
        label="Search projects"
      />
      {shown.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {q.trim()
            ? "No project matches your search."
            : "This team has no projects yet."}
        </p>
      )}
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
                  ? "border-primary bg-primary-wash ring-1 ring-primary/60"
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
          ? "border-primary bg-primary-wash-strong font-medium text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

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
