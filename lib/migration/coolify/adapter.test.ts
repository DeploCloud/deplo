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
    // The deploy-ability probe: any answer but 403 means the token may stop.
    "/api/v1/applications/deplo-probe/stop": {
      message: "This endpoint has changed to a POST request.",
    },
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

test("a database's S3 backup schedules ride on its row, named after the store", async (t) => {
  serve(t, {
    "/api/v1/databases/db-1/backups": [
      {
        uuid: "bk-1",
        enabled: true,
        frequency: "0 3 * * *",
        save_s3: true,
        s3_storage_id: 7,
        database_backup_retention_amount_s3: 5,
        database_type: "App\\Models\\StandalonePostgresql",
      },
      {
        uuid: "bk-2",
        enabled: true,
        frequency: "0 4 * * *",
        save_s3: false,
        database_type: "App\\Models\\StandalonePostgresql",
      },
      // Measured on 4.3.16: the route filters by database_id alone, so the mysql
      // that shares the number comes back too. The morph class tells it apart.
      {
        uuid: "bk-9",
        enabled: true,
        frequency: "0 9 * * *",
        save_s3: true,
        s3_storage_id: 7,
        database_type: "App\\Models\\StandaloneMysql",
      },
    ],
    // ...and the store list carries no id, so with one store that is the one.
    "/api/v1/s3-storages": [
      {
        uuid: "s3-7",
        name: "nightly",
        endpoint: "https://s3.test",
        bucket: "b",
      },
    ],
  });
  const row = (await coolifyClient(cred).getService("postgres", "db-1")) as {
    backups?: unknown;
  };
  assert.deepEqual(row.backups, [
    {
      schedule: "0 3 * * *",
      enabled: true,
      keepLatestCount: 5,
      destination: { name: "nightly" },
    },
    {
      schedule: "0 4 * * *",
      enabled: true,
      keepLatestCount: null,
      destination: null,
    },
  ]);
});

// Measured on a two-machine Coolify: read + read:sensitive imported everything and
// then could not stop one service, so every copy failed. Refused at Connect instead.
test("a token that cannot stop a service is refused before anything runs", async (t) => {
  serve(
    t,
    {
      "/api/v1/services/svc-gitea": {
        ...SERVICES[0],
        docker_compose_raw: "services:\n  gitea:\n    image: gitea/gitea\n",
      },
    },
    (path) =>
      path === "/api/v1/applications/deplo-probe/stop"
        ? new Response(
            JSON.stringify({ message: "Missing required permissions: deploy" }),
            { status: 403, headers: { "content-type": "application/json" } },
          )
        : null,
  );
  await assert.rejects(
    () => coolifyClient(cred).assertReadable(),
    /cannot stop a service[\s\S]*deploy ticked FIRST/,
  );
});

test("a token that may stop passes the readiness check", async (t) => {
  serve(t, {
    "/api/v1/services/svc-gitea": {
      ...SERVICES[0],
      docker_compose_raw: "services:\n  gitea:\n    image: gitea/gitea\n",
    },
  });
  await coolifyClient(cred).assertReadable();
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

test("backing out starts the service again, on the group it belongs to", async (t) => {
  const seen = serve(t, {
    "/api/v1/services/svc-gitea/start": { message: "queued" },
  });
  // A Coolify one-click service arrives as kind `compose`; the group is settled
  // from the service list, the same way the stop settles it.
  await coolifyClient(cred).startService("compose", "svc-gitea");
  assert.ok(
    seen.includes("/api/v1/services/svc-gitea/start"),
    `no start was posted; calls were ${seen.join(", ")}`,
  );
  // Measured on a real Coolify: `status` still reads `exited` minutes after the
  // container is back, so a start that waited on it would invent a failure.
  assert.ok(
    !seen.some(
      (p) => p.endsWith("/start") && p !== "/api/v1/services/svc-gitea/start",
    ),
  );
});

test("a database is started on its own group, not the services one", async (t) => {
  const seen = serve(t, {
    "/api/v1/databases/db-1/start": { message: "queued" },
  });
  await coolifyClient(cred).startService("postgres", "db-1");
  assert.ok(
    seen.includes("/api/v1/databases/db-1/start"),
    `no database start was posted; calls were ${seen.join(", ")}`,
  );
});

test("a stack's config file on a real host path is carried by the data phase", async (t) => {
  serve(t, {
    "/api/v1/services/svc-gitea/storages": {
      file_storages: [
        {
          uuid: "f1",
          fs_path: "/srv/mx/single.conf",
          mount_path: "/etc/app/single.conf",
          content: "a = 1",
        },
      ],
    },
  });
  const state = await coolifyClient(cred).serviceRuntime({
    kind: "compose",
    id: "svc-gitea",
    appName: "gitea",
    declaredVolumes: [],
    declaredBindMounts: [],
    composeFile: null,
  });
  // Without this the file landed mounted and EMPTY, with no report line at all.
  assert.deepEqual(state.hostMounts, [
    { hostPath: "/srv/mx/single.conf", mountPath: "/etc/app/single.conf" },
  ]);
});

/**
 * Coolify renames EVERY compose volume to `<uuid>_<key>` and honours neither
 * `external: true` nor a pinned `name:` - verified against 4.3.14, whose rendered
 * `docker_compose` mounts its own volume and leaves the pinned declaration
 * dangling. So the storage row is the truth, and the volume the author named -
 * which their data may well be in - is data this stack never had. Copying it
 * would carry a stranger's bytes; saying nothing read as Deplo losing theirs.
 */
test("a volume the panel renamed out from under the compose is named, not copied", async (t) => {
  serve(t, {
    "/api/v1/services/svc-gitea/storages": {
      persistent_storages: [
        { uuid: "s1", name: "svc-gitea_r9data", mount_path: "/data/r9" },
        { uuid: "s2", name: "svc-gitea_r9ext", mount_path: "/data/ext" },
      ],
    },
  });
  const state = await coolifyClient(cred).serviceRuntime({
    kind: "compose",
    id: "svc-gitea",
    appName: "gitea",
    declaredVolumes: [],
    declaredBindMounts: [],
    composeFile: [
      "services:",
      "  core:",
      "    image: alpine",
      "    volumes:",
      "      - r9data:/data/r9",
      "      - r9ext:/data/ext",
      "volumes:",
      "  r9data:",
      "  r9ext:",
      "    external: true",
      "    name: r9-cool-external",
    ].join("\n"),
  });
  assert.deepEqual(state.volumes, [
    { name: "svc-gitea_r9data", mountPath: "/data/r9" },
    { name: "svc-gitea_r9ext", mountPath: "/data/ext" },
  ]);
  assert.deepEqual(state.notes, [
    'The compose file mounts "r9-cool-external" at /data/ext, but {panel} ignored that and gave gitea a volume of its own there - so whatever is in "r9-cool-external" was never this stack\'s data, and Deplo does not copy it.',
  ]);
});

test("a pinned volume nothing in the stack mounts is not worth a line", async (t) => {
  serve(t);
  const state = await coolifyClient(cred).serviceRuntime({
    kind: "compose",
    id: "svc-gitea",
    appName: "gitea",
    declaredVolumes: [],
    declaredBindMounts: [],
    composeFile: [
      "services:",
      "  core:",
      "    image: alpine",
      "    volumes:",
      "      - gitea-data:/data",
      "volumes:",
      "  gitea-data:",
      "  leftover:",
      "    external: true",
    ].join("\n"),
  });
  assert.deepEqual(state.volumes, [{ name: "gitea-data", mountPath: "/data" }]);
  assert.deepEqual(state.notes, []);
});

// A Coolify token is bound to the team it was minted in: `/v1/teams` is filtered
// down to that one team, so the panel cannot even count the others. Answering
// `null` rather than `[]` is what makes the wizard ask instead of claiming
// nothing is missing.
test("the token's own team is named, and the others cannot be", async (t) => {
  serve(t, { "/api/v1/team": { id: 4, name: "Acme Corp" } });

  const src = coolifyClient(cred);
  assert.deepEqual(await src.sourceTeam(), { id: "4", name: "Acme Corp" });
  assert.equal(await src.otherTeams(), null);
});
