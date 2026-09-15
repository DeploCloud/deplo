"use client";

import * as React from "react";
import { Boxes, FolderTree, Folder } from "lucide-react";
import { TintedMark } from "@/components/shared/tinted-mark";
import type {
  ScopeTreeApp,
  ScopeTreeFolder,
} from "@/lib/data/tokens/scope-tree";
import { envMeta, folderMeta, projectMeta, teamMeta } from "./app-counts";
import { AppMark, Row, TeamMark } from "./row";
import type { ScopeNode } from "./selection";
import type { ScopePickerState } from "./use-scope-picker";

export function ScopeTree({
  state,
  disabled,
  teamPickable,
  environmentsExpressible,
  renderMeta,
}: {
  state: ScopePickerState;
  disabled: boolean;
  teamPickable: boolean;
  environmentsExpressible: boolean;
  renderMeta?: (node: ScopeNode) => React.ReactNode;
}) {
  const {
    shown,
    teams,
    projects,
    environments,
    folders,
    apps,
    isOpen,
    toggleOpen,
    toggleTeam,
    toggleProject,
    toggleFolder,
    toggleEnvironment,
    toggleApp,
  } = state;

  function appRow(
    app: ScopeTreeApp,
    depth: number,
    covered: boolean,
    withMeta = true,
  ) {
    const checked = covered || apps.has(app.id);
    return (
      <Row
        key={app.id}
        depth={depth}
        mark={<AppMark logo={app.logo} />}
        label={app.name}
        meta={app.slug}
        checked={checked}
        disabled={disabled || covered}
        onCheckedChange={(v) => toggleApp(app.id, v, covered)}
        id={`scope-app-${app.id}`}
        right={
          withMeta
            ? renderMeta?.({
                kind: "app",
                id: app.id,
                name: app.name,
                checked,
              })
            : undefined
        }
      />
    );
  }

  function renderFolder(
    folder: ScopeTreeFolder,
    depth: number,
    covered: boolean,
  ): React.ReactNode {
    const on = covered || folders.has(folder.id);
    const expanded = isOpen(folder.id);
    const hasChildren = folder.folders.length > 0 || folder.apps.length > 0;
    return (
      <div key={folder.id}>
        <Row
          depth={depth}
          mark={<TintedMark icon={Folder} color={folder.color} />}
          label={folder.name}
          meta={folderMeta(folder)}
          checked={on}
          disabled={disabled || covered}
          onCheckedChange={(v) => toggleFolder(folder, v, covered)}
          expandable={hasChildren}
          expanded={expanded}
          onToggleExpand={() => toggleOpen(folder.id)}
          id={`scope-folder-${folder.id}`}
          right={renderMeta?.({
            kind: "folder",
            id: folder.id,
            name: folder.name,
            checked: on,
          })}
        />
        {expanded && (
          <>
            {folder.folders.map((child) => renderFolder(child, depth + 1, on))}
            {folder.apps.map((app) => appRow(app, depth + 1, on))}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="max-h-96 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border">
      {shown.map((team) => {
        const teamOn = teams.has(team.id);
        const expanded = isOpen(team.id);
        const hasChildren =
          team.projects.length > 0 ||
          team.folders.length > 0 ||
          team.looseApps.length > 0;
        return (
          <div key={team.id}>
            <Row
              depth={0}
              mark={<TeamMark name={team.name} />}
              label={team.name}
              meta={teamMeta(team)}
              checkbox={teamPickable}
              checked={teamOn}
              disabled={disabled}
              onCheckedChange={(v) => toggleTeam(team, v)}
              expandable={hasChildren}
              expanded={expanded}
              onToggleExpand={() => toggleOpen(team.id)}
              id={`scope-team-${team.id}`}
              right={renderMeta?.({
                kind: "team",
                id: team.id,
                name: team.name,
                checked: teamOn,
              })}
            />
            {expanded && (
              <>
                {team.projects.map((project) => {
                  const projOn = teamOn || projects.has(project.id);
                  const projExpanded = isOpen(project.id);
                  const projHasChildren =
                    project.folders.length > 0 || project.apps.length > 0;
                  return (
                    <div key={project.id}>
                      <Row
                        depth={1}
                        mark={
                          <TintedMark icon={FolderTree} color={project.color} />
                        }
                        label={project.name}
                        meta={projectMeta(project)}
                        checked={projOn}
                        disabled={disabled || teamOn}
                        onCheckedChange={(v) =>
                          toggleProject(project, v, teamOn)
                        }
                        expandable={projHasChildren}
                        expanded={projExpanded}
                        onToggleExpand={() => toggleOpen(project.id)}
                        id={`scope-project-${project.id}`}
                        right={renderMeta?.({
                          kind: "project",
                          id: project.id,
                          name: project.name,
                          checked: projOn,
                        })}
                      />
                      {projExpanded && (
                        <>
                          {(environmentsExpressible
                            ? project.environments
                            : []
                          ).map((env) => {
                            const envOn = projOn || environments.has(env.id);
                            const envExpanded = isOpen(env.id);
                            return (
                              <div key={env.id}>
                                <Row
                                  depth={2}
                                  mark={
                                    <Boxes className="size-3.5 text-muted-foreground" />
                                  }
                                  label={env.name}
                                  meta={envMeta(env)}
                                  checked={envOn}
                                  disabled={disabled || projOn}
                                  onCheckedChange={(v) =>
                                    toggleEnvironment(env, v, projOn)
                                  }
                                  expandable={env.apps.length > 0}
                                  expanded={envExpanded}
                                  onToggleExpand={() => toggleOpen(env.id)}
                                  id={`scope-env-${env.id}`}
                                />
                                {envExpanded &&
                                  env.apps.map((app) =>
                                    appRow(app, 3, envOn, false),
                                  )}
                              </div>
                            );
                          })}
                          {project.folders.map((f) =>
                            renderFolder(f, 2, projOn),
                          )}
                          {(environmentsExpressible
                            ? project.apps
                            : [
                                ...project.environments.flatMap((e) => e.apps),
                                ...project.apps,
                              ]
                          ).map((app) => appRow(app, 2, projOn))}
                        </>
                      )}
                    </div>
                  );
                })}
                {team.folders.map((f) => renderFolder(f, 1, teamOn))}
                {team.looseApps.map((app) => appRow(app, 1, teamOn))}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
