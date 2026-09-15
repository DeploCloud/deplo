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

export interface SourceService {
  kind: "application" | "compose" | SourceDbKind;
  id: string;
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

export function loadService(
  c: SourceCredential,
  svc: SourceService,
): Promise<SourceApplication | SourceCompose | SourceDatabase> {
  return sourceClient(c).getService(svc.kind, svc.id);
}

export async function nameOfService(
  c: SourceCredential,
  svc: SourceService,
): Promise<string> {
  if (svc.name?.trim()) return svc.name;
  return loadService(c, svc)
    .then((d) => nameOf(d, svc))
    .catch(() => svc.id);
}

export function truncateName(name: string): string {
  const MAX = 60;
  const trimmed = name.trim();
  if (trimmed.length <= MAX) return trimmed;
  const cut = trimmed.slice(0, MAX);
  const lastBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("-"));
  return (lastBreak >= MAX - 12 ? cut.slice(0, lastBreak) : cut).trim();
}

export function nameOf(
  detail: { name?: string | null } | null,
  svc: SourceService,
): string {
  return serviceDisplayName(detail, svc.name || svc.id);
}
