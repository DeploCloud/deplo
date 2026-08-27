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
import { listDeploReleases } from "./updates";

/**
 * The changelog is remote input rendered inside the panel: a draft nobody
 * published must not appear, and a GitHub that says no must say so rather than
 * read as "there are no releases".
 */

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
    // A release published without a title still needs one to click on.
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
    // Refused before the call went out, not after.
    assert.equal(capture.calls.length, 0);
  } finally {
    capture.restore();
  }
});
