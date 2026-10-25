import "server-only";

import { reachesWholeTeam } from "../../membership";
import {
  securitySubjects,
  type SecuritySubject,
} from "../../security-updates/subjects";
import { listApps } from "../apps/listing";
import { listDatabases } from "../databases/rows";
import { databaseSecurityCounts } from "./read";

export type { SecuritySubject };

// Every app and database of the active team with security updates to apply, most urgent first.
export async function securityUpdatesOverview(): Promise<SecuritySubject[]> {
  const apps = await listApps();
  const dbs = (await reachesWholeTeam()) ? await listDatabases() : [];
  return securitySubjects(
    apps,
    dbs,
    await databaseSecurityCounts(dbs.map((d) => d.id)),
  );
}
