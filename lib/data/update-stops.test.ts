import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  captureFetch,
  type FetchCapture,
} from "../notify/fetch-capture-test-helpers";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import { CONTROL_PLANE_UPDATE_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { deploUpdateAlert } from "../notify/maintenance";
import { DEPLO_VERSION } from "../version";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import {
  __resetThisReleaseForTest,
  __setThisReleaseForTest,
} from "./update-stops/decision";
import {
  applyDeploUpdate,
  getUpdateInfo,
  listDeploReleases,
  readUpdateInfo,
  setCanaryReleases,
} from "./updates";

let db: TestDb;
let pg: PGlite;

const ADMIN = "admin1";
const MEMBER = "member2";
const HOST_IP = "192.0.2.77";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetThisReleaseForTest();
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  __resetThisReleaseForTest();
  await pg.exec(
    `${TRUNCATE_IDENTITY} truncate table passed_update_stops, servers restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: ADMIN, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: MEMBER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: ADMIN, teamId: TEAM_A }, fn);
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: MEMBER, teamId: TEAM_A }, fn);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

type Declared = { updateStop?: boolean; requiresStop?: string } | number;

// A mocked GitHub: the newest stable, the published releases, and what each tag's package.json declares.
function github(feed: {
  latest: string;
  published?: string[];
  listed?: string[];
  declares?: Record<string, Declared>;
}): FetchCapture {
  const published = new Set([feed.latest, ...(feed.published ?? [])]);
  const listed = feed.listed ?? [...published];
  return captureFetch((url) => {
    const raw = url.match(
      /raw\.githubusercontent\.com\/.+\/v([^/]+)\/package\.json$/,
    );
    if (raw) {
      const d = feed.declares?.[raw[1]];
      if (typeof d === "number") return new Response("", { status: d });
      return json(
        d ? { name: "deplo", deplo: { agentMin: "0.4.0", ...d } } : {},
      );
    }
    const tag = url.match(/\/releases\/tags\/v([^/?]+)$/);
    if (tag)
      return published.has(tag[1])
        ? json({ tag_name: `v${tag[1]}`, html_url: `u-${tag[1]}` })
        : json({ message: "Not Found" }, 404);
    if (url.includes("/releases/latest"))
      return json({ tag_name: `v${feed.latest}`, html_url: "latest" });
    return json(
      listed.map((v) => ({ tag_name: `v${v}`, prerelease: v.includes("-") })),
    );
  });
}

test("below a stop the newest release requires, Update installs the stop and says why", async () => {
  const capture = github({
    latest: "99.1.0",
    published: ["99.0.0"],
    declares: {
      "99.1.0": { requiresStop: "99.0.0" },
      "99.0.0": { updateStop: true },
    },
  });
  try {
    const info = await asAdmin(getUpdateInfo);
    assert.equal(info.latest, "v99.1.0");
    assert.equal(info.updateAvailable, true);
    assert.equal(info.next, "v99.0.0");
    assert.equal(info.nextIsStop, true);
    assert.equal(
      info.stop?.reason,
      "Deplo v99.1.0 has to come after v99.0.0, so Update installs v99.0.0 first.",
    );
  } finally {
    capture.restore();
  }
});

test("Update installs the stop on the machine Deplo runs on, not the newest release", async () => {
  const prevIp = process.env.DEPLO_SERVER_IP;
  process.env.DEPLO_SERVER_IP = HOST_IP;
  await seedServerRow(db, { id: "srv_host", name: "host", ip: HOST_IP });
  const installed: string[] = [];
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({
          capabilities: [CONTROL_PLANE_UPDATE_CAPABILITY],
        }),
        updateControlPlane: async (req: { version: string }) => {
          installed.push(req.version);
          return { ok: true, logPath: "/var/log/deplo-update.log", error: "" };
        },
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<typeof import("../infra/agent-client/connect").openAgent>
      >,
  );
  const capture = github({
    latest: "99.1.0",
    published: ["99.0.0"],
    declares: { "99.1.0": { requiresStop: "99.0.0" } },
  });
  try {
    const started = await asAdmin(applyDeploUpdate);
    assert.equal(started.version, "99.0.0");
    assert.deepEqual(installed, ["99.0.0"]);
  } finally {
    capture.restore();
    __setAgentConnectorForTest();
    if (prevIp === undefined) delete process.env.DEPLO_SERVER_IP;
    else process.env.DEPLO_SERVER_IP = prevIp;
  }
});

test("a chain of stops is walked back to the oldest one not passed", async () => {
  const capture = github({
    latest: "99.2.0",
    published: ["99.1.0", "99.0.0"],
    declares: {
      "99.2.0": { requiresStop: "99.1.0" },
      "99.1.0": { updateStop: true, requiresStop: "99.0.0" },
      "99.0.0": { updateStop: true },
    },
  });
  try {
    const info = await asAdmin(getUpdateInfo);
    assert.equal(info.next, "v99.0.0");
    assert.equal(info.nextIsStop, true);
    assert.match(
      info.stop?.reason ?? "",
      /Deplo v99\.2\.0 has to come after v99\.0\.0/,
    );
  } finally {
    capture.restore();
  }
});

test("a stop older than the release list is still found by its own tag", async () => {
  const capture = github({
    latest: "99.0.0",
    published: ["99.1.0-canary.40"],
    listed: Array.from({ length: 20 }, (_, i) => `99.1.0-canary.${40 - i}`),
    declares: { "99.1.0-canary.40": { requiresStop: "99.0.0" } },
  });
  try {
    const info = await asAdmin(() => setCanaryReleases(true));
    assert.equal(info.latest, "v99.1.0-canary.40");
    assert.equal(info.next, "v99.0.0");
  } finally {
    capture.restore();
  }
});

test("canary releases follow the same rules: a canary can require a canary stop", async () => {
  const capture = github({
    latest: "99.0.0",
    published: ["99.1.0-canary.2", "99.1.0-canary.1"],
    declares: {
      "99.1.0-canary.2": { requiresStop: "99.1.0-canary.1" },
      "99.1.0-canary.1": { updateStop: true },
    },
  });
  try {
    const info = await asAdmin(() => setCanaryReleases(true));
    assert.equal(info.latest, "v99.1.0-canary.2");
    assert.equal(info.next, "v99.1.0-canary.1");
    assert.equal(info.nextIsStop, true);
  } finally {
    capture.restore();
  }
});

test("a stop that is not published offers nothing rather than the newest", async () => {
  const capture = github({
    latest: "99.1.0",
    declares: { "99.1.0": { requiresStop: "99.0.0" } },
  });
  try {
    const info = await asAdmin(getUpdateInfo);
    assert.equal(info.updateAvailable, false);
    assert.equal(info.next, null);
    assert.match(info.error ?? "", /v99\.0\.0, which is not published/);
  } finally {
    capture.restore();
  }
});

test("when what the newest release needs cannot be read, Update offers nothing", async () => {
  const capture = github({ latest: "99.1.0", declares: { "99.1.0": 503 } });
  try {
    const info = await asAdmin(getUpdateInfo);
    assert.equal(info.latest, "v99.1.0");
    assert.equal(info.updateAvailable, false);
    assert.equal(info.next, null);
    assert.match(info.error ?? "", /Couldn't check what Deplo v99\.1\.0 needs/);
  } finally {
    capture.restore();
  }
});

test("a release that declares nothing is installed directly, as the releases before stops are", async () => {
  const capture = github({ latest: "99.1.0" });
  try {
    const info = await asAdmin(getUpdateInfo);
    assert.equal(info.next, "v99.1.0");
    assert.equal(info.nextIsStop, false);
    assert.equal(info.stop, null);
  } finally {
    capture.restore();
  }
});

test("on the stop, the newer release waits for its conditions, then is offered with nothing to click", async () => {
  let met = false;
  __setThisReleaseForTest({
    updateStop: true,
    condition: async () => ({ met }),
  });
  const capture = github({
    latest: "99.1.0",
    declares: { "99.1.0": { requiresStop: DEPLO_VERSION } },
  });
  try {
    const waiting = await asAdmin(getUpdateInfo);
    assert.equal(waiting.updateAvailable, false);
    assert.equal(waiting.next, null);
    assert.equal(waiting.stop?.waiting, true);
    assert.equal(waiting.stop?.version, `v${DEPLO_VERSION}`);
    assert.equal(
      waiting.stop?.reason,
      `Deplo v99.1.0 becomes available once v${DEPLO_VERSION} has finished getting this instance ready.`,
    );

    met = true;
    const ready = await asAdmin(getUpdateInfo);
    assert.equal(ready.next, "v99.1.0");
    assert.equal(ready.stop, null);

    met = false;
    const later = await asAdmin(getUpdateInfo);
    assert.equal(later.next, "v99.1.0", "passing a stop is never undone");
  } finally {
    capture.restore();
  }
});

test("passing the stop is recorded even before any release requires it", async () => {
  __setThisReleaseForTest({ updateStop: true });
  const quiet = github({ latest: DEPLO_VERSION });
  try {
    await getUpdateInfo();
  } finally {
    quiet.restore();
  }
  __setThisReleaseForTest({
    updateStop: true,
    condition: async () => ({ met: false }),
  });
  const capture = github({
    latest: "99.1.0",
    declares: { "99.1.0": { requiresStop: DEPLO_VERSION } },
  });
  try {
    assert.equal((await getUpdateInfo()).next, "v99.1.0");
  } finally {
    capture.restore();
  }
});

test("an instance past a stop it never passed is told so, and offered nothing", async () => {
  const capture = github({
    latest: "99.1.0",
    declares: { "99.1.0": { requiresStop: "0.0.1" } },
  });
  try {
    const info = await asAdmin(getUpdateInfo);
    assert.equal(info.next, null);
    assert.equal(info.stop?.waiting, false);
    assert.equal(info.stop?.version, "v0.0.1");
    assert.match(info.stop?.reason ?? "", /has to come after v0\.0\.1/);
  } finally {
    capture.restore();
  }
});

test("a member cannot read the update decision, and GitHub is not asked", async () => {
  const capture = github({ latest: "99.1.0" });
  try {
    await assert.rejects(() => asMember(readUpdateInfo));
    assert.equal(capture.calls.length, 0);
    assert.equal((await asAdmin(readUpdateInfo)).next, "v99.1.0");
  } finally {
    capture.restore();
  }
});

test("the update notification names the stop Update installs, and says nothing while it waits", async () => {
  const capture = github({
    latest: "99.1.0",
    published: ["99.0.0"],
    declares: { "99.1.0": { requiresStop: "99.0.0" } },
  });
  try {
    const alert = deploUpdateAlert(await getUpdateInfo());
    assert.equal(alert?.title, "Deplo v99.0.0 is available");
    assert.equal(alert?.dedupe.state, "v99.0.0");
    assert.equal(
      alert?.body,
      "Deplo v99.1.0 has to come after v99.0.0, so Update installs v99.0.0 first.",
    );
  } finally {
    capture.restore();
  }
  __setThisReleaseForTest({
    updateStop: true,
    condition: async () => ({ met: false }),
  });
  const waiting = github({
    latest: "99.1.0",
    declares: { "99.1.0": { requiresStop: DEPLO_VERSION } },
  });
  try {
    assert.equal(deploUpdateAlert(await getUpdateInfo()), null);
  } finally {
    waiting.restore();
  }
});

test("What changed marks only the releases Update brings in, up to the stop", async () => {
  const capture = github({
    latest: "99.1.0",
    published: ["99.0.1", "99.0.0", DEPLO_VERSION],
    declares: { "99.1.0": { requiresStop: "99.0.0" } },
  });
  try {
    const { releases } = await asAdmin(listDeploReleases);
    assert.deepEqual(
      releases.map((r) => [r.tag, r.available]),
      [
        ["v99.1.0", false],
        ["v99.0.1", false],
        ["v99.0.0", true],
        [`v${DEPLO_VERSION}`, false],
      ],
    );
  } finally {
    capture.restore();
  }
});
