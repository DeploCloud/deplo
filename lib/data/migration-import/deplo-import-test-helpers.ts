import { __resetDeploExportsForTest } from "../../migration/deplo/client";
import type { DeploExport } from "../../migration/deplo/export-shape";
import { __setMigrationFetchForTest } from "../../migration/transport";
import { asOwner } from "./migration-import-test-helpers";
import {
  importMigrationProject,
  type ImportProjectInput,
} from "./project-import";
import { beginMigration } from "./run-lifecycle";
import { getMigrationRun } from "./run-queries";

export const DEPLO_SOURCE = {
  url: "https://old.deplo.test",
  apiKey: "deplo_abcdefghijklmnopqrstuvwxyz",
  kind: "deplo" as const,
};

export type DataRequestBody = Record<string, unknown>;

// A whole other Deplo behind fetch: its export, and whatever the data stream answers per request.
export function fakeDeplo(
  x: DeploExport,
  data: (body: DataRequestBody) => Response = () =>
    new Response("not found", { status: 404 }),
) {
  const asked: DataRequestBody[] = [];
  __resetDeploExportsForTest();
  __setMigrationFetchForTest(
    async (url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}")) as DataRequestBody;
      if (url.endsWith("/api/migration/export")) {
        asked.push(body);
        return data(body);
      }
      const json = (d: unknown) =>
        new Response(JSON.stringify(d), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (String(body.query ?? "").includes("migrationExport"))
        return json({ data: { migrationExport: x } });
      return json({ data: {} });
    },
  );
  return { asked };
}

export async function importDeploProject(projectId: string): Promise<string> {
  const runId = await asOwner(() =>
    beginMigration({ url: DEPLO_SOURCE.url, kind: "deplo" }),
  );
  await asOwner(() =>
    importMigrationProject({ ...DEPLO_SOURCE, runId, projectId }),
  );
  return runId;
}

// Use with openMigrationHarness/resetMigrationHarness; the export's projects are imported by id.
export async function importFromDeplo(
  x: DeploExport,
  projectIds: string[],
  extra: Partial<ImportProjectInput> = {},
): Promise<string> {
  fakeDeplo(x);
  const runId = await asOwner(() => beginMigration(DEPLO_SOURCE));
  for (const projectId of projectIds)
    await asOwner(() =>
      importMigrationProject({ ...DEPLO_SOURCE, ...extra, runId, projectId }),
    );
  return runId;
}

export async function reportLines(runId: string): Promise<string[]> {
  const run = await asOwner(() => getMigrationRun(runId));
  return (run?.items ?? []).map((i) => i.message ?? "");
}
