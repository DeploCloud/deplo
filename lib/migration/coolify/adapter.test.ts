import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coolifyClient,
  stopDeadlineMs,
  __resetCoolifyIndexForTest,
} from "./adapter";
import { __resetCoolifyRateLimitForTest } from "./client";
import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
} from "../transport";

/**
 * The Coolify adapter against a routed fake API. Every route here answers the
 * shape the real 4.x API answers with, which is the whole point: the three
 * defects below were all a field or an endpoint the adapter read wrongly.
 */

const cred = {
  kind: "coolify" as const,
  baseUrl: "https://coolify.test",
  apiKey: "3|abcdefghijklmnopqrstuvwxyz012345",
};

/** The panel's own machine plus a second one, exactly as Coolify lists them. */
const SERVERS = [
  { id: 0, uuid: "srv-panel", name: "localhost", ip: "host.docker.internal" },
  { id: 2, uuid: "srv-remote", name: "second", ip: "10.0.0.2" },
];

const SERVICES = [
  {
    uuid: "svc-gitea",
    name: "gitea",
    environment_id: 1,
    status: "running:healthy",
  },
];

const DATABASES = [
  {
    uuid: "db-1",
    name: "pg",
    environment_id: 1,
    // The column the API actually answers with. `type` is absent.
    database_type: "standalone-postgresql",
    postgres_user: "u",
    postgres_password: "p",
    postgres_db: "d",
    image: "postgres:16",
  },
];

function serve(
  t: { after: (fn: () => void) => void },
  over: Record<string, unknown> = {},
  onCall?: (path: string) => Response | null,
): string[] {
  const seen: string[] = [];
  const routes: Record<string, unknown> = {
    "/api/v1/servers": SERVERS,
    "/api/v1/servers/srv-panel/resources": [{ uuid: "svc-local" }],
    "/api/v1/servers/srv-remote/resources": [
      { uuid: "svc-gitea" },
      { uuid: "db-1" },
    ],
    "/api/v1/services": SERVICES,
    "/api/v1/applications": [],
    "/api/v1/databases": DATABASES,
    "/api/v1/projects": [{ uuid: "prj-1", name: "acme" }],
    "/api/v1/projects/prj-1/environments": [
      { id: 1, uuid: "env-1", name: "production" },
    ],
    "/api/v1/projects/prj-1/envs": [],
    "/api/v1/projects/prj-1/environments/production/envs": [],
    "/api/v1/services/svc-gitea": SERVICES[0],
    "/api/v1/services/svc-gitea/envs": [{ key: "A", value: "1" }],
    "/api/v1/services/svc-gitea/storages": {
      persistent_storages: [
        { uuid: "s1", name: "gitea-data", mount_path: "/data" },
      ],
    },
    "/api/v1/databases/db-1": DATABASES[0],
    "/api/v1/databases/db-1/envs": [],
    "/api/v1/databases/db-1/storages": {},
    ...over,
  };
  __setMigrationFetchForTest(async (url) => {
    const path = new URL(url).pathname;
    seen.push(path);
    const forced = onCall?.(path);
    if (forced) return forced;
    const body = routes[path];
    if (body === undefined)
      return new Response(JSON.stringify({ message: "Not found." }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  t.after(__resetMigrationFetchForTest);
  t.after(__resetCoolifyRateLimitForTest);
  t.after(__resetCoolifyIndexForTest);
  __resetCoolifyIndexForTest();
  __resetCoolifyRateLimitForTest();
  return seen;
}

// A flat 30 seconds was a two-container service on a panel that was also
// building: the stop had worked, the wait had not.
test("the stop deadline grows with the stack", () => {
  assert.equal(stopDeadlineMs(0), 50_000);
  assert.equal(stopDeadlineMs(1), 50_000);
  assert.equal(stopDeadlineMs(2), 70_000);
  assert.equal(stopDeadlineMs(5), 130_000);
  assert.equal(stopDeadlineMs(8), 180_000);
  assert.equal(stopDeadlineMs(40), 180_000, "capped at three minutes");
});

test("a database is found, because the engine lives on `database_type`", async (t) => {
  serve(t);
  const [project] = await coolifyClient(cred).listProjects();
  const env = project.environments![0];
  assert.deepEqual(
    (env.postgres ?? []).map((d) => d.name),
    ["pg"],
    "reading `type` alone dropped every database with no note at all",
  );
});

test("a resource carries the machine it runs on, not the panel's own host", async (t) => {
  serve(t);
  const detail = await coolifyClient(cred).getService("compose", "svc-gitea");
  assert.equal(
    detail.serverId,
    "srv-remote",
    "left empty, the data phase asked the panel's host for a volume on the second machine",
  );
  const db = await coolifyClient(cred).getService("postgres", "db-1");
  assert.equal(db.serverId, "srv-remote");
});

test("what runs on the panel's own machine keeps the empty key", async (t) => {
  serve(t, {
    "/api/v1/servers/srv-panel/resources": [{ uuid: "svc-gitea" }],
    "/api/v1/servers/srv-remote/resources": [],
  });
  const detail = await coolifyClient(cred).getService("compose", "svc-gitea");
  assert.equal(detail.serverId, "");
});

test("a rate limit while probing a service is raised, never read as `not a service`", async (t) => {
  // The probe used to treat EVERY failure as "this is an application", which sent
  // the cutover's stop to applications/{uuid}/stop -> 404 -> data not copied.
  let hits = 0;
  serve(t, { "/api/v1/services": [] }, (path) => {
    if (path !== "/api/v1/services/svc-gitea") return null;
    hits++;
    return new Response(JSON.stringify({ message: "Too many attempts." }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
  });
  await assert.rejects(
    () => coolifyClient(cred).getService("compose", "svc-gitea"),
    /rate limiting/i,
  );
  assert.ok(hits > 0);
});

test("a service the index has not seen is still settled by one probe", async (t) => {
  // A 404 IS proof: it is the one answer that means "not a service".
  serve(t, { "/api/v1/services": [], "/api/v1/applications/svc-gitea": {} });
  const detail = await coolifyClient(cred).getService("compose", "svc-gitea");
  assert.equal((detail as { composeId?: string }).composeId, "svc-gitea");
});

test("the resource index is read once, not once per service", async (t) => {
  const seen = serve(t);
  const client = coolifyClient(cred);
  await client.getService("compose", "svc-gitea");
  await client.getService("compose", "svc-gitea");
  await client.getService("postgres", "db-1");
  assert.equal(
    seen.filter((p) => p === "/api/v1/servers").length,
    1,
    "the server join is per SCAN, not per resource",
  );
});

test("a shared-variable level the panel refuses is a note, not a silence", async (t) => {
  // An older panel has no `envs` endpoint at that level. Answering `[]` there made
  // a whole set of shared variables disappear with nothing said about it.
  serve(t, {}, (path) =>
    path === "/api/v1/projects/prj-1/envs"
      ? new Response(JSON.stringify({ message: "Not found." }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      : null,
  );
  const [project] = await coolifyClient(cred).listProjects();
  assert.match(
    (project.platformNotes ?? []).join("\n"),
    /would not answer for the project "acme" shared variables/,
  );
  // The tree still comes back whole - one level refusing is not a failed scan.
  assert.equal(project.environments?.length, 1);
});

test("the server level is read for the machine a resource runs on", async (t) => {
  const seen = serve(t, {
    "/api/v1/servers/srv-remote/envs": [{ key: "SERVER_WIDE", value: "s" }],
  });
  const blob = await coolifyClient(cred).serverSharedEnv("srv-remote");
  assert.equal(blob, "SERVER_WIDE=s");
  assert.ok(seen.includes("/api/v1/servers/srv-remote/envs"));
  // The panel's OWN host is keyed "" everywhere else in the importer.
  assert.equal(await coolifyClient(cred).serverSharedEnv("nope"), null);
});

test("a token that cannot read a compose file is refused before anything runs", async (t) => {
  // A service is DEFINED by its compose, so one that hands over none is the same
  // missing scope showing up somewhere the env probe cannot see it - and the
  // failure it made downstream read as a git problem.
  serve(t, {
    "/api/v1/services/svc-gitea": { uuid: "svc-gitea", name: "gitea" },
  });
  await assert.rejects(
    () => coolifyClient(cred).assertReadable(),
    /read:sensitive/,
  );
});

test("a compose the panel DOES hand over settles the token", async (t) => {
  serve(t, {
    "/api/v1/services/svc-gitea": {
      ...SERVICES[0],
      docker_compose_raw: "services:\n  gitea:\n    image: gitea/gitea\n",
    },
  });
  await coolifyClient(cred).assertReadable();
});
