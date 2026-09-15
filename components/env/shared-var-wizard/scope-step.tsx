"use client";

import * as React from "react";
import { AppWindow, Folders, Users } from "lucide-react";
import { ChoiceCard } from "@/components/shared/choice-card";
import type { AppRef, ProjectRef, ScopeId } from "./types";

const SCOPES: {
  id: ScopeId;
  title: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    id: "team",
    title: "Teams",
    blurb:
      "Offered to every app in the teams you pick. Pick one and each app still adds it explicitly; pick two or more and it is added to all of them.",
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

export function ScopeStep({
  scopes,
  projects,
  apps,
  onToggle,
}: {
  scopes: ScopeId[];
  projects: ProjectRef[];
  apps: AppRef[];
  onToggle: (id: ScopeId) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Pick one or more. Only “Specific apps” adds it somewhere right away.
      </p>
      <div role="group" aria-label="Shared with" className="space-y-2">
        {SCOPES.map((sc) => (
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
              sc.id === "projects" ? "No projects yet." : "No apps yet."
            }
            onSelect={() => onToggle(sc.id)}
          />
        ))}
      </div>
    </div>
  );
}
