import { __resetDeploExportsForTest } from "../../migration/deplo/client";
import type { DeploExport } from "../../migration/deplo/export-shape";
import { __setMigrationFetchForTest } from "../../migration/transport";
import { asOwner } from "./migration-import-test-helpers";
import { importMigrationProject } from "./project-import";
import { beginMigration } from "./run-lifecycle";

export const DEPLO_SOURCE = {
  url: "https://old.deplo.test",
  apiKey: "deplo_abcdefghijklmnopqrstuvwxyz",
  kind: "deplo" as const,
};

// Another Deplo that answers only its export: enough for the config phase.
export function fakeDeplo(x: DeploExport) {
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
    const data = String(body.query ?? "").includes("migrationExport")
      ? { migrationExport: x }
      : {};
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

// Use with openMigrationHarness/resetMigrationHarness; the export's projects are imported by id.
export async function importFromDeplo(
  x: DeploExport,
  projectIds: string[],
): Promise<string> {
  __resetDeploExportsForTest();
  __setMigrationFetchForTest(fakeDeplo(x));
  const runId = await asOwner(() => beginMigration(DEPLO_SOURCE));
  for (const projectId of projectIds)
    await asOwner(() =>
      importMigrationProject({ ...DEPLO_SOURCE, runId, projectId }),
    );
  return runId;
}
