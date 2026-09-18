"use client";

import * as React from "react";
import { Boxes, Check, CircleSlash, Layers } from "lucide-react";

import { Combobox } from "@/components/shared/combobox";

export interface EnvironmentOption {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
}

export const NO_ENVIRONMENT = "none";

export type Row =
  | { kind: "none"; key: string; search: string }
  | { kind: "project"; key: string; search: string; name: string }
  | {
      kind: "env";
      key: string;
      search: string;
      name: string;
      projectName: string;
    };

// A project row matches on its environments too, so searching keeps whole branches.
export function rowsFor(environments: EnvironmentOption[]): Row[] {
  const rows: Row[] = [
    { kind: "none", key: NO_ENVIRONMENT, search: "no environment top level" },
  ];
  const byProject = new Map<string, EnvironmentOption[]>();
  for (const env of environments) {
    const group = byProject.get(env.projectId) ?? [];
    group.push(env);
    byProject.set(env.projectId, group);
  }
  for (const [projectId, envs] of byProject) {
    const projectName = envs[0]!.projectName;
    rows.push({
      kind: "project",
      key: `project:${projectId}`,
      name: projectName,
      search:
        `${projectName} ${envs.map((e) => e.name).join(" ")}`.toLowerCase(),
    });
    for (const env of envs)
      rows.push({
        kind: "env",
        key: env.id,
        name: env.name,
        projectName,
        search: `${projectName} ${env.name}`.toLowerCase(),
      });
  }
  return rows;
}

function RowIcon({ kind }: { kind: Row["kind"] }) {
  const className = "size-3.5 shrink-0 text-muted-foreground";
  if (kind === "none") return <CircleSlash className={className} />;
  if (kind === "project") return <Boxes className={className} />;
  return <Layers className={className} />;
}

export function EnvironmentCombobox({
  value,
  onChange,
  environments,
  id,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  environments: EnvironmentOption[];
  id?: string;
  disabled?: boolean;
}) {
  const rows = React.useMemo(() => rowsFor(environments), [environments]);

  return (
    <Combobox<Row>
      id={id}
      items={rows}
      value={value}
      onChange={onChange}
      disabled={disabled}
      getKey={(r) => r.key}
      selectable={(r) => r.kind !== "project"}
      matches={(r, q) => r.search.includes(q)}
      displayValue={(r) =>
        r.kind === "env" ? `${r.projectName} / ${r.name}` : "No environment"
      }
      placeholder="No environment"
      searchPlaceholder="Search environments"
      emptyLabel={(hasItems) =>
        hasItems ? "No environment matches that" : "No environments yet"
      }
      renderLeading={(r) => <RowIcon kind={r.kind} />}
      renderTrailing={(r) =>
        r.key === value ? <Check className="size-4 text-primary" /> : null
      }
      renderOption={(r) =>
        r.kind === "project" ? (
          <span className="flex items-center gap-2 px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
            <RowIcon kind="project" />
            <span className="truncate">{r.name}</span>
          </span>
        ) : (
          <span
            className={`flex items-center gap-2 text-sm ${r.kind === "env" ? "pl-4" : ""}`}
          >
            <RowIcon kind={r.kind} />
            <span className="truncate">
              {r.kind === "env" ? r.name : "No environment"}
            </span>
          </span>
        )
      }
    />
  );
}
