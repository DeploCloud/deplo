import type { EnvRow } from "@/components/env/env-rows-editor";
import type { SharedVarDTO } from "@/lib/data/shared-vars/team-view";
import type { TeamEnvironment } from "@/lib/data/environments";
import type { ProjectScope, ScopeId } from "./types";

// initialScopes - the scope boxes a wizard opens with.
export function initialScopes(
  editing: SharedVarDTO | null,
  defaultAppIds?: string[],
): ScopeId[] {
  if (!editing) return defaultAppIds?.length ? ["apps"] : [];
  const out: ScopeId[] = [];
  if (editing.teamIds.length > 0) out.push("team");
  if (editing.projectIds.length > 0 || editing.environmentIds.length > 0)
    out.push("projects");
  if (editing.appIds.length > 0) out.push("apps");
  return out;
}

// initialProjectScopes - the per-project all/some choice a wizard opens with.
export function initialProjectScopes(
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

export const emptyRow = (): EnvRow[] => [{ key: "", value: "" }];
