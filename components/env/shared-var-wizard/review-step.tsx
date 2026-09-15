"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { TeamAvatar } from "@/components/shared/user-avatar";
import type { TeamEnvironment } from "@/lib/data/environments";
import type { AppRef, ProjectScope, TeamRef, WizardRef } from "./types";

export function Review({
  varKeys,
  secret,
  teams,
  teamIds,
  projects,
  environments,
  projectScopes,
  apps,
  appIds,
}: {
  varKeys: string[];
  secret: boolean;
  teams: TeamRef[];
  teamIds: string[];
  projects: WizardRef[];
  environments: TeamEnvironment[];
  projectScopes: Record<string, ProjectScope>;
  apps: AppRef[];
  appIds: string[];
}) {
  const name = (list: WizardRef[], id: string) =>
    list.find((x) => x.id === id)?.name ?? id;

  const reach = (scope: ProjectScope, projectId: string) =>
    scope.mode === "all"
      ? apps.filter((a) => a.projectId === projectId).length
      : apps.filter(
          (a) =>
            a.environmentId != null && scope.envIds.includes(a.environmentId),
        ).length;
  const appCount = (n: number) => `${n} app${n === 1 ? "" : "s"}`;

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
  const teamNames = teamIds.map(
    (id) => teams.find((t) => t.id === id)?.name ?? id,
  );
  const teamMark = (id: string) => {
    const t = teams.find((x) => x.id === id);
    return t ? (
      <TeamAvatar name={t.name} avatarUrl={t.avatarUrl} size="xs" />
    ) : undefined;
  };
  const teamChips =
    teamIds.length === 1
      ? [
          {
            id: teamIds[0],
            icon: teamMark(teamIds[0]),
            label: `Every app in ${teamNames[0]} can add it - ${appCount(apps.length)} today`,
          },
        ]
      : teamIds.map((id, i) => ({
          id,
          icon: teamMark(id),
          label: teamNames[i],
        }));

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {varKeys.length === 1 ? "Variable" : `${varKeys.length} variables`}
          </p>
          <Badge variant="muted" className="text-[10px]">
            {secret ? "Secret" : "Plain"}
          </Badge>
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {varKeys.map((k) => (
            <p key={k} className="truncate px-3 py-2 font-mono text-xs">
              {k}
            </p>
          ))}
        </div>
      </div>
      <div className="space-y-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Available to
        </p>
        <ChipGroup
          title={teamIds.length > 1 ? "Added to every app in" : "Teams"}
          chips={teamChips}
        />
        {teamIds.length > 1 && (
          <p className="text-xs text-muted-foreground">
            No opt-in: every app in {list(teamNames)} gets it on its next
            deploy. An app&apos;s own value for the same name still wins.
            {secret &&
              " Being a secret, the value lands in those teams' containers."}
          </p>
        )}
        <ChipGroup title="Projects" chips={projectChips} />
        <ChipGroup title="Added to these apps" chips={appChips} />
      </div>
    </div>
  );
}

function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function ChipGroup({
  title,
  chips,
}: {
  title: string;
  chips: { id: string; label: string; icon?: React.ReactNode }[];
}) {
  if (chips.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <Badge
            key={c.id}
            variant="muted"
            className="gap-1.5 py-1 text-[11px] font-normal"
          >
            {c.icon}
            {c.label}
          </Badge>
        ))}
      </div>
    </div>
  );
}
