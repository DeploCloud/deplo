import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import sharp from "sharp";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { apps } from "../db/schema/control-plane/apps";
import { runWithIdentity } from "../auth/request-context";
import { logoSrc, logoVersion, withLogoSrc } from "../apps/logo-src";
import { shrinkLogo } from "../apps/logo-shrink";
import { seedIdentity, TEAM_A, TEAM_B } from "./identity-test-helpers";
import {
  TRUNCATE_PROJECT_GRAPH,
  seedApp,
  seedServer,
} from "./app-graph-test-helpers";
import { decodeLogo, readLogoImage, shrinkStoredLogos } from "./logos";

let db: TestDb;
let pg: PGlite;
const OWNER = "u_owner";
const STRANGER = "u_stranger";
const APP = "prj_web";

// Noise does not compress, so the PNG is heavy the way a real uploaded photo is.
async function bigPng(edge = 512): Promise<string> {
  const raw = Buffer.alloc(edge * edge * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  const png = await sharp(raw, {
    raw: { width: edge, height: edge, channels: 3 },
  })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

const SMALL_SVG = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>',
).toString("base64")}`;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(
    `truncate table membership_capabilities, memberships, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      { id: STRANGER, teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: APP, teamId: TEAM_A, slug: "web" });
});

test("a page carries an uploaded logo as a URL that changes with the image", async () => {
  const png = await bigPng(16);
  const src = logoSrc("app", APP, png)!;
  assert.equal(src, `/api/logo/app/${APP}?v=${logoVersion(png)}`);
  assert.notEqual(logoSrc("app", APP, SMALL_SVG), src);
  assert.equal(
    logoSrc("app", APP, "/templates/nginx.webp"),
    "/templates/nginx.webp",
  );
  assert.equal(logoSrc("app", APP, null), null);
  assert.deepEqual(withLogoSrc("app", [{ id: APP, logo: null }]), [
    { id: APP, logo: null },
  ]);
});

test("a logo is decoded only for an image type a logo may have", () => {
  assert.equal(decodeLogo(SMALL_SVG)?.type, "image/svg+xml");
  const html = `data:text/html;base64,${Buffer.from("<script>").toString("base64")}`;
  assert.equal(decodeLogo(html), null);
});

test("a raster logo is shrunk to 128 px WebP, a small SVG stays vector", async () => {
  const png = await bigPng();
  const out = await shrinkLogo(png);
  assert.match(out, /^data:image\/webp;base64,/);
  assert.ok(out.length < png.length / 4);
  const meta = await sharp(decodeLogo(out)!.bytes).metadata();
  assert.ok(meta.width! <= 128 && meta.height! <= 128);
  assert.equal(await shrinkLogo(SMALL_SVG), SMALL_SVG);
  assert.equal(
    await shrinkLogo("/templates/nginx.webp"),
    "/templates/nginx.webp",
  );
});

test("the boot sweep shrinks stored logos once and leaves the rest", async () => {
  const png = await bigPng();
  await db.update(apps).set({ logo: png }).where(eq(apps.id, APP));
  assert.equal(await shrinkStoredLogos(), 1);
  const [row] = await db.select({ logo: apps.logo }).from(apps);
  assert.match(row!.logo!, /^data:image\/webp;base64,/);
  assert.equal(await shrinkStoredLogos(), 0);
});

test("a logo loads for the App's own team and nobody else", async () => {
  await db.update(apps).set({ logo: SMALL_SVG }).where(eq(apps.id, APP));
  const mine = await runWithIdentity({ userId: OWNER, teamId: TEAM_A }, () =>
    readLogoImage("app", APP),
  );
  assert.equal(mine?.type, "image/svg+xml");
  const theirs = await runWithIdentity(
    { userId: STRANGER, teamId: TEAM_B },
    () => readLogoImage("app", APP),
  );
  assert.equal(theirs, null);
});
