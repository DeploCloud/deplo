import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { captureFetch } from "../notify/fetch-capture-test-helpers";
import { DEPLO_VERSION } from "../version";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import {
  applyDeploUpdate,
  getUpdateInfo,
  listDeploReleases,
  setCanaryReleases,
} from "./updates";

let db: TestDb;
let pg: PGlite;

const ADMIN = "admin1";
const MEMBER = "member2";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_IDENTITY);
  await seedIdentity(db, {
    users: [
      { id: ADMIN, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: MEMBER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
});

const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

test("drafts are dropped and the running version is the one marked installed", async () => {
  const capture = captureFetch(() =>
    json([
      {
        tag_name: "v9.9.9",
        name: "Next",
        html_url: "u1",
        body: "soon",
        draft: true,
      },
      { tag_name: "v9.0.0", name: "Nine", html_url: "u2", body: "notes" },
      { tag_name: `v${DEPLO_VERSION}`, html_url: "u3", body: "" },
    ]),
  );
  try {
    const { releases, error } = await asUser(ADMIN, listDeploReleases);
    assert.equal(error, undefined);
    assert.deepEqual(
      releases.map((r) => r.tag),
      ["v9.0.0", `v${DEPLO_VERSION}`],
    );
    assert.equal(releases[0].current, false);
    assert.equal(releases[1].current, true);
    assert.equal(releases[1].name, `v${DEPLO_VERSION}`);
  } finally {
    capture.restore();
  }
});

test("a refusal from GitHub is reported, not served as an empty changelog", async () => {
  const capture = captureFetch(
    () => new Response("rate limited", { status: 403 }),
  );
  try {
    const { releases, error } = await asUser(ADMIN, listDeploReleases);
    assert.deepEqual(releases, []);
    assert.match(error ?? "", /403/);
  } finally {
    capture.restore();
  }
});

test("no releases published yet is empty WITHOUT an error", async () => {
  const capture = captureFetch(() => new Response("", { status: 404 }));
  try {
    const { releases, error } = await asUser(ADMIN, listDeploReleases);
    assert.deepEqual(releases, []);
    assert.equal(error, undefined);
  } finally {
    capture.restore();
  }
});

test("a member cannot read the instance's changelog", async () => {
  const capture = captureFetch(() => json([]));
  try {
    await assert.rejects(() => asUser(MEMBER, listDeploReleases));
    assert.equal(capture.calls.length, 0);
  } finally {
    capture.restore();
  }
});

test("a member cannot start an update of the instance", async () => {
  const capture = captureFetch(() => json({ tag_name: "v99.0.0" }));
  try {
    await assert.rejects(() => asUser(MEMBER, applyDeploUpdate));
    assert.equal(capture.calls.length, 0);
  } finally {
    capture.restore();
  }
});

test("an instance already on the newest release is not updated", async () => {
  const capture = captureFetch(() => json({ tag_name: `v${DEPLO_VERSION}` }));
  try {
    await assert.rejects(
      () => asUser(ADMIN, applyDeploUpdate),
      /newest release/,
    );
  } finally {
    capture.restore();
  }
});

test("without the panel's own machine as a server there is nobody to ask", async () => {
  const capture = captureFetch(() =>
    json({ tag_name: "v99.0.0", html_url: "u" }),
  );
  try {
    await assert.rejects(
      () => asUser(ADMIN, applyDeploUpdate),
      /not one of its servers/,
    );
  } finally {
    capture.restore();
  }
});

test("the changelog carries every release's notes whole, and marks the ones still to install", async () => {
  const long = "x".repeat(10_000);
  const body = `Intro.\n\n## What's Changed\n* feat: a by @someone\n\n${long}`;
  const capture = captureFetch(() =>
    json([
      { tag_name: "v99.0.0", html_url: "u1", body },
      { tag_name: `v${DEPLO_VERSION}`, html_url: "u2", body: "  now  " },
    ]),
  );
  try {
    const { releases } = await asUser(ADMIN, listDeploReleases);
    assert.equal(releases[0]!.body, body, "nothing is cut, not even the list");
    assert.equal(releases[1]!.body, "now");
    assert.deepEqual(
      releases.map((r) => [r.tag, r.available, r.current]),
      [
        ["v99.0.0", true, false],
        [`v${DEPLO_VERSION}`, false, true],
      ],
    );
  } finally {
    capture.restore();
  }
});

const CANARY = "v99.1.0-canary.3";

function releaseFeed(url: string): Response {
  if (url.includes("/releases/latest"))
    return json({ tag_name: "v99.0.0", html_url: "stable" });
  return json([
    { tag_name: CANARY, html_url: "canary", body: "early", prerelease: true },
    { tag_name: "v99.0.0", html_url: "stable", body: "notes" },
    { tag_name: `v${DEPLO_VERSION}-canary.1`, body: "", prerelease: true },
  ]);
}

test("stable: only stable releases are updates, and canaries stay out of What changed", async () => {
  const capture = captureFetch(releaseFeed);
  try {
    const info = await asUser(ADMIN, getUpdateInfo);
    assert.equal(info.canary, false);
    assert.equal(info.latest, "v99.0.0");
    assert.equal(info.updateAvailable, true);
    const { releases } = await asUser(ADMIN, listDeploReleases);
    assert.deepEqual(
      releases.map((r) => r.tag),
      ["v99.0.0"],
    );
  } finally {
    capture.restore();
  }
});

test("canary: the newest release of all is the update, and What changed lists it", async () => {
  const capture = captureFetch(releaseFeed);
  try {
    const info = await asUser(ADMIN, () => setCanaryReleases(true));
    assert.equal(info.canary, true);
    assert.equal(info.latest, CANARY);
    assert.equal(info.updateAvailable, true);
    const { releases } = await asUser(ADMIN, listDeploReleases);
    assert.deepEqual(
      releases.map((r) => [r.tag, r.prerelease]),
      [
        [CANARY, true],
        ["v99.0.0", false],
        [`v${DEPLO_VERSION}-canary.1`, true],
      ],
    );
  } finally {
    capture.restore();
  }
});

test("switching channel installs nothing; switching back finds the latest stable again", async () => {
  const capture = captureFetch(releaseFeed);
  try {
    await asUser(ADMIN, () => setCanaryReleases(true));
    const back = await asUser(ADMIN, () => setCanaryReleases(false));
    assert.equal(back.canary, false);
    assert.equal(back.latest, "v99.0.0");
    assert.ok(
      capture.calls.every((c) => c.method === "GET"),
      "the switch only reads the release list",
    );
  } finally {
    capture.restore();
  }
});

test("a member cannot switch the instance to canary releases", async () => {
  const capture = captureFetch(releaseFeed);
  try {
    await assert.rejects(() => asUser(MEMBER, () => setCanaryReleases(true)));
    assert.equal((await asUser(ADMIN, getUpdateInfo)).canary, false);
  } finally {
    capture.restore();
  }
});
