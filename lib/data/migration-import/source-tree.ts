import "server-only";

import { serviceDisplayName } from "../../migration/dokploy/client";
import { sourceClient } from "../../migration/source";
import type { SourceCredential } from "../../migration/source";
import { SOURCE_DB_KINDS, type SourceDbKind } from "../../migration/model";
import type {
  SourceApplication,
  SourceCompose,
  SourceDatabase,
  SourceEnvironment,
} from "../../migration/model";

// SourceService - one source service as `project.all` gives it: an id, a kind,
// and whatever else happened to be projected.
export interface SourceService {
  kind: "application" | "compose" | SourceDbKind;
  id: string;
  // From the tree when it was there; the authority is the detail row.
  name: string;
  serverId: string;
}

export function servicesOf(env: SourceEnvironment): SourceService[] {
  const out: SourceService[] = [];
  for (const a of env.applications ?? [])
    out.push({
      kind: "application",
      id: a.applicationId,
      name: a.name?.trim() ?? "",
      serverId: a.serverId ?? "",
    });
  for (const c of env.compose ?? [])
    out.push({
      kind: "compose",
      id: c.composeId,
      name: c.name?.trim() ?? "",
      serverId: c.serverId ?? "",
    });
  for (const kind of SOURCE_DB_KINDS)
    for (const row of (env[kind] ?? []) as SourceDatabase[]) {
      const id = row[`${kind}Id`];
      if (typeof id !== "string") continue;
      out.push({
        kind,
        id,
        name: row.name?.trim() ?? "",
        serverId: row.serverId ?? "",
      });
    }
  return out;
}

// The detail call for one service - the only shape difference between kinds.
export function loadService(
  c: SourceCredential,
  svc: SourceService,
): Promise<SourceApplication | SourceCompose | SourceDatabase> {
  return sourceClient(c).getService(svc.kind, svc.id);
}

// What to call a service Deplo will NOT import: worth one detail call, since the
// tree carries no name for a database and an id names nothing to anybody.
export async function nameOfService(
  c: SourceCredential,
  svc: SourceService,
): Promise<string> {
  if (svc.name?.trim()) return svc.name;
  return loadService(c, svc)
    .then((d) => nameOf(d, svc))
    .catch(() => svc.id);
}

// Deplo's own name cap, applied here rather than being hit as an error. Trimmed on
// a word boundary when there is one in reach, so it still reads as a name.
export function truncateName(name: string): string {
  const MAX = 60;
  const trimmed = name.trim();
  if (trimmed.length <= MAX) return trimmed;
  const cut = trimmed.slice(0, MAX);
  const lastBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("-"));
  return (lastBreak >= MAX - 12 ? cut.slice(0, lastBreak) : cut).trim();
}

// What to call a service: its detail row's name, the tree's, or its id.
export function nameOf(
  detail: { name?: string | null } | null,
  svc: SourceService,
): string {
  return serviceDisplayName(detail, svc.name || svc.id);
}
