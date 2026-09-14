"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { TeamAvatar } from "@/components/shared/user-avatar";
import type { TeamEnvironment } from "@/lib/data/environments";
import type { AppRef, ProjectScope, TeamRef, WizardRef } from "./types";

// Review - the last step: everything the Save button is about to do, as chips.
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

  // Availability scopes only SUGGEST (each app opts in itself, ADR-0012), so the
  // counts read "can add it"; only the Apps group adds anything directly.
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
  // `apps` only counts the ACTIVE team, so a multi-team reach names the teams
  // rather than pretending to a total it cannot see.
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
          {/* The type is one choice for the whole batch, so it is named once
              here rather than repeated on every row. */}
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

// list - "a, b and c", the plain-English join the review sentence reads with.
function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ChipGroup - one labelled row of scope chips; the label tells a project from an app.
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
