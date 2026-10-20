import { __setMigrationFetchForTest } from "../../migration/transport";
import { __resetDeploExportsForTest } from "../../migration/deplo/client";
import type { DeploExport } from "../../migration/deplo/export-shape";
import { beginMigration } from "./run-lifecycle";
import { importMigrationProject } from "./project-import";
import { asOwner } from "./migration-import-test-helpers";

// A whole import from another Deplo: a fake panel serving `migrationExport`, then the real importer.
export const DEPLO_SOURCE = {
  url: "https://old.deplo.test",
  apiKey: "deplo_abcdefghijklmnopqrstuvwxyz",
  kind: "deplo" as const,
};

export function serveDeploExport(exp: DeploExport): void {
  __resetDeploExportsForTest();
  __setMigrationFetchForTest(
    async (_url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
      };
      const data = String(body.query ?? "").includes("migrationExport")
        ? { migrationExport: exp }
        : {};
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
}

export async function importFromDeplo(projectId: string): Promise<string> {
  const runId = await asOwner(() =>
    beginMigration({ url: DEPLO_SOURCE.url, kind: "deplo" }),
  );
  await asOwner(() =>
    importMigrationProject({ ...DEPLO_SOURCE, runId, projectId }),
  );
  return runId;
}
