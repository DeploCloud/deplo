import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { apps as appsTable } from "../db/schema/control-plane";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { seedServer, TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { createApp, updateAppLogo } from "./apps";

/**
 * An app's icon wears a contrast plate only while it is the TEMPLATE's icon.
 * The column is also the provenance, so a logo the user set has to clear it -
 * otherwise their upload inherits a plate nobody asked for.
 */

let db: TestDb;
let pg: PGlite;

const COMPOSE = "services:\n  web:\n    image: nginx:1.27\n";

/** A 32x32 image of one colour, as the data-URI an app actually stores. */
async function dataUri(fill: number[]): Promise<string> {
  const raw = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < raw.length; i += 4) raw.set(fill, i);
  const png = await sharp(raw, { raw: { width: 32, height: 32, channels: 4 } })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const newApp = (extra: Record<string, unknown>) =>
  createApp({
    name: "shop",
    source: "compose",
    repo: null,
    compose: COMPOSE,
    deploy: false,
    ...extra,
  });

const toneOf = async (id: string) =>
  (
    await db
      .select({ tone: appsTable.logoTone })
      .from(appsTable)
      .where(eq(appsTable.id, id))
  )[0]?.tone ?? null;

test("a template's monochrome logo is stored with the plate it needs", async () => {
  const logo = await dataUri([0, 0, 0, 255]);
  const app = await asUser1(() => newApp({ logo, logoFromTemplate: true }));
  assert.equal(await toneOf(app.id), "dark");
});

test("the same logo from anywhere else gets no plate", async () => {
  // An import carries an icon from another platform: not a template's, so it is
  // drawn exactly as it arrived.
  const logo = await dataUri([0, 0, 0, 255]);
  const app = await asUser1(() => newApp({ logo }));
  assert.equal(await toneOf(app.id), null);
});

test("a coloured template logo needs no plate", async () => {
  const logo = await dataUri([59, 130, 246, 255]);
  const app = await asUser1(() => newApp({ logo, logoFromTemplate: true }));
  assert.equal(await toneOf(app.id), null);
});

test("uploading a logo drops the template's plate", async () => {
  const logo = await dataUri([0, 0, 0, 255]);
  const app = await asUser1(() => newApp({ logo, logoFromTemplate: true }));
  assert.equal(await toneOf(app.id), "dark");
  const mine = await dataUri([255, 255, 255, 255]);
  await asUser1(() => updateAppLogo(app.id, mine));
  assert.equal(await toneOf(app.id), null);
});
