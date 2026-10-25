import "server-only";

import { reachesWholeTeam } from "../../membership";
import { listApps } from "../apps/listing";
import { listDatabases } from "../databases/rows";
import { databaseSecurityCounts } from "./read";

export interface SecuritySubject {
  kind: "app" | "database";
  id: string;
  name: string;
  count: number;
  exploited: number;
}

// Every app and database of the active team with security updates to apply, most urgent first.
export async function securityUpdatesOverview(): Promise<SecuritySubject[]> {
  const apps = await listApps();
  const out: SecuritySubject[] = apps
    .filter((a) => a.securityUpdates?.count)
    .map((a) => ({
      kind: "app",
      id: a.id,
      name: a.name,
      ...a.securityUpdates!,
    }));
  if (await reachesWholeTeam()) {
    const dbs = await listDatabases();
    const counts = await databaseSecurityCounts(dbs.map((d) => d.id));
    for (const d of dbs) {
      const c = counts.get(d.id);
      if (c) out.push({ kind: "database", id: d.id, name: d.name, ...c });
    }
  }
  return out.sort((a, b) => b.exploited - a.exploited || b.count - a.count);
}
