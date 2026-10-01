import { test } from "node:test";
import assert from "node:assert/strict";

import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
} from "../transport";
import { SELF_PANEL_REFUSAL } from "../self";
import { deploClient } from "./adapter";
import { __resetDeploExportsForTest } from "./client";
import { deploExport } from "./deplo-test-helpers";
import type { DeploExport } from "./export-shape";
import { instanceFingerprint } from "./instance";

const cred = {
  kind: "deplo" as const,
  baseUrl: "https://old.example",
  apiKey: "deplo_abcdefghijklmnopqrstuvwxyz",
};

interface Seen {
  url: string;
  body: Record<string, unknown>;
}

function serve(
  t: { after: (fn: () => void) => void },
  x: DeploExport,
  opts: {
    running?: () => number;
    stream?: (body: Record<string, unknown>) => Response;
  } = {},
): Seen[] {
  t.after(__resetMigrationFetchForTest);
  t.after(__resetDeploExportsForTest);
  __resetDeploExportsForTest();
  const seen: Seen[] = [];
  __setMigrationFetchForTest(async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    seen.push({ url, body });
    if (url.endsWith("/api/migration/export"))
      return opts.stream?.(body) ?? new Response(null, { status: 204 });
    const query = String(body.query ?? "");
    const json = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (query.includes("migrationExport")) return json({ migrationExport: x });
    if (query.includes("runtime"))
      return json({
        runtime: { running: opts.running?.() ?? 1, unreachable: false },
      });
    return json({
      stopApp: { id: "x" },
      startApp: { id: "x" },
      setDatabaseRunning: { id: "x" },
    });
  });
  return seen;
}

test("connecting a Deplo to itself is refused before anything is read", async (t) => {
  serve(t, deploExport({ instance: instanceFingerprint() }));
  await assert.rejects(deploClient(cred).assertReadable(), (e: Error) => {
    assert.equal(e.message, SELF_PANEL_REFUSAL);
    return true;
  });
});

test("a token that cannot stop what it moves is refused at Connect", async (t) => {
  serve(t, deploExport({ canControl: { apps: true, databases: false } }));
  await assert.rejects(
    deploClient(cred).assertReadable(),
    /lacks Start & stop databases/,
  );
});

test("a newer export version asks for this Deplo to be updated", async (t) => {
  serve(t, deploExport({ version: 99 }));
  await assert.rejects(
    deploClient(cred).listProjects(),
    /newer than this one\. Update this Deplo/,
  );
});

test("a Deplo source lists no machines, so nothing is installed on them", async (t) => {
  serve(t, deploExport());
  const client = deploClient(cred);
  assert.deepEqual(await client.listServers(), []);
  assert.ok(client.dataExport);
  assert.equal(client.displayName, "Deplo at old.example");
});

test("the runtime names the volumes the old Deplo keeps on its host", async (t) => {
  serve(t, deploExport(), { running: () => 0 });
  const runtime = await deploClient(cred).serviceRuntime({
    kind: "postgres",
    id: "db_main",
    appName: "main",
    declaredVolumes: [],
    declaredBindMounts: [],
    composeFile: null,
  });
  assert.deepEqual(
    runtime.volumes.map((v) => v.name),
    ["deplo-db-main_db-main-data"],
  );
  assert.equal(runtime.running, false);
  assert.match(runtime.notes.join(" "), /already stopped/);
});

test("stopping waits until the old Deplo says it is down", async (t) => {
  let polls = 0;
  const seen = serve(t, deploExport(), {
    running: () => (++polls < 2 ? 1 : 0),
  });
  await deploClient(cred).stopService("application", "prj_web");
  assert.ok(seen.some((s) => String(s.body.query).includes("stopApp")));
  assert.equal(polls, 2);
});

test("a volume the old Deplo does not have reads as NOT_FOUND, like an agent's", async (t) => {
  serve(t, deploExport(), {
    stream: () =>
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
  });
  const it = deploClient(cred)
    .dataExport!.exportVolume({ kind: "postgres", id: "db_main" }, "gone")
    [Symbol.asyncIterator]();
  await assert.rejects(it.next(), (e: Error & { code?: number }) => {
    assert.equal(e.code, 5);
    return true;
  });
});

test("a volume streams through as the bytes the old Deplo sent", async (t) => {
  const seen = serve(t, deploExport(), {
    stream: () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
  });
  const chunks: Buffer[] = [];
  for await (const c of deploClient(cred).dataExport!.exportVolume(
    { kind: "postgres", id: "db_main" },
    "deplo-db-main_db-main-data",
  ))
    chunks.push(c);
  assert.deepEqual([...Buffer.concat(chunks)], [1, 2, 3]);
  const asked = seen.find((s) => s.url.endsWith("/api/migration/export"));
  assert.deepEqual(asked?.body, {
    kind: "database",
    id: "db_main",
    volume: "deplo-db-main_db-main-data",
  });
});
