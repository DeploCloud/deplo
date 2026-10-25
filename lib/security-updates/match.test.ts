import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { InventoryStatus, type WorkloadImage } from "../agent/gen/agent";
import { runWithIdentity } from "../auth/request-context";
import { __resetTestDb, __setTestDb } from "../db/client";
import { activities } from "../db/schema/control-plane/activity";
import { appBuild } from "../db/schema/control-plane/apps";
import {
  imageInventories,
  securityFindings,
  workloadImages,
} from "../db/schema/control-plane/security-updates";
import { makeTestDb, type TestDb } from "../db/test-harness";
import {
  seedApp,
  seedPreview,
  seedServer,
  SERVER_1,
} from "../data/app-graph-test-helpers";
import { seedDatabase } from "../data/backup-test-helpers";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import { saveNotificationChannel } from "../data/notifications";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import {
  captureFetch,
  type FetchCapture,
} from "../notify/fetch-capture-test-helpers";
import { matchWorkloads, storeKev } from "./match";
import { OsvUnavailableError } from "./osv";
import { refreshServer } from "./workloads";

let db: TestDb;
let pg: PGlite;
let capture: FetchCapture | null = null;

const WEB_IMAGE = "sha256:" + "1".repeat(64);
const WEB_IMAGE_2 = "sha256:" + "2".repeat(64);
const PG_IMAGE = "sha256:" + "3".repeat(64);
const HOOK = "https://discord.test/hook";

const MINIMIST = "pkg:npm/minimist@1.2.5";
const OPENSSL =
  "pkg:deb/debian/libssl3@3.0.11-1~deb12u2?distro=debian-12.13&upstream=openssl";
const KERNEL = "pkg:deb/debian/linux-libc-dev@6.1.164-1?upstream=linux";

let workloads: WorkloadImage[] = [];
let packagesOf: Record<string, { purl: string; location: string }[]> = {};
let osvDown = false;

const wl = (o: Partial<WorkloadImage>): WorkloadImage => ({
  projectId: "",
  appId: "",
  service: "web",
  imageRef: "deplo/web:dpl_1",
  imageId: WEB_IMAGE,
  repoDigests: [],
  running: true,
  ...o,
});

const fakeAgent = {
  hello: async () => ({ capabilities: ["image-inventory"] }),
  listWorkloadImages: async () => ({ images: workloads }),
  inventoryImage: async (imageId: string) => ({
    status: InventoryStatus.INVENTORY_STATUS_OK,
    error: "",
    distroId: "debian",
    distroVersion: "12.13",
    workingDir: "/app",
    scannerVersion: "1.54.1",
    durationMs: 1,
    packages: (packagesOf[imageId] ?? []).map((p) => ({
      ...p,
      name: "",
      version: "",
      type: "",
    })),
  }),
  close() {},
} as unknown as AgentConnection;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const RECORDS: Record<string, unknown> = {
  "GHSA-xvch-5gv4-984h": {
    id: "GHSA-xvch-5gv4-984h",
    modified: "m1",
    aliases: ["CVE-2021-44906"],
    database_specific: { severity: "CRITICAL" },
    affected: [
      {
        package: { ecosystem: "npm", name: "minimist" },
        ranges: [
          { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.2.6" }] },
        ],
      },
    ],
  },
  "DEBIAN-CVE-2024-5535": {
    id: "DEBIAN-CVE-2024-5535",
    modified: "m1",
    upstream: ["CVE-2024-5535"],
    affected: [
      {
        package: { ecosystem: "Debian:12", name: "openssl" },
        ranges: [
          {
            type: "ECOSYSTEM",
            events: [{ introduced: "0" }, { fixed: "3.0.15-1~deb12u1" }],
          },
        ],
      },
    ],
  },
  "CVE-2024-5535": {
    id: "CVE-2024-5535",
    severity: [
      {
        type: "CVSS_V3",
        score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:H",
      },
    ],
  },
};

function osv(url: string, body: unknown): Response {
  if (url === HOOK) return new Response(null, { status: 204 });
  if (osvDown) return json({}, 503);
  if (url.endsWith("/querybatch")) {
    const { queries } = body as { queries: { package: { name: string } }[] };
    return json({
      results: queries.map((q) =>
        q.package.name === "minimist"
          ? { vulns: [{ id: "GHSA-xvch-5gv4-984h", modified: "m1" }] }
          : q.package.name === "openssl"
            ? { vulns: [{ id: "DEBIAN-CVE-2024-5535", modified: "m1" }] }
            : {},
      ),
    });
  }
  const id = decodeURIComponent(url.split("/vulns/")[1] ?? "");
  return RECORDS[id] ? json(RECORDS[id]) : json({}, 404);
}

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `truncate table security_findings, workload_images, image_inventory_packages, image_inventories,
       osv_affected, kev_cves, activities, notification_alerts, notification_channels,
       app_previews, apps, databases, servers, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_web", slug: "web" });
  await db
    .update(appBuild)
    .set({ buildMethod: "dockerfile" })
    .where(eq(appBuild.appId, "prj_web"));
  await seedApp(db, { id: "prj_idle", slug: "idle" });
  await db
    .update(appBuild)
    .set({ buildMethod: "dockerfile" })
    .where(eq(appBuild.appId, "prj_idle"));
  await seedPreview(db, { id: "prv_1", appId: "prj_web", prNumber: 7 });
  await seedDatabase(db, { id: "db_main", name: "main" });
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    saveNotificationChannel(null, {
      kind: "discord",
      name: "",
      enabled: true,
      url: HOOK,
      target: "",
      emailFrom: "",
      emailProvider: "resend",
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      alerts: ["security_update_available"],
    }),
  );
  workloads = [
    wl({ projectId: "prj_web" }),
    wl({ projectId: "prj_idle", running: false }),
    wl({ projectId: "prv_1", appId: "prj_web" }),
    wl({
      projectId: "db_main",
      service: "db",
      imageRef: "postgres:16-alpine",
      imageId: PG_IMAGE,
    }),
    wl({ projectId: "prj_gone" }),
  ];
  packagesOf = {
    [WEB_IMAGE]: [
      { purl: MINIMIST, location: "/app/node_modules/minimist/package.json" },
      { purl: OPENSSL, location: "/var/lib/dpkg/status" },
      { purl: KERNEL, location: "/var/lib/dpkg/status" },
    ],
    [PG_IMAGE]: [{ purl: OPENSSL, location: "/var/lib/dpkg/status" }],
  };
  osvDown = false;
  __setAgentConnectorForTest(async () => fakeAgent);
  capture = captureFetch((url) => osv(url, capture!.calls.at(-1)?.body));
});

afterEach(() => {
  capture?.restore();
  capture = null;
});

const hookCalls = () => capture!.calls.filter((c) => c.url === HOOK);
async function settle(): Promise<void> {
  for (let i = 0; i < 50 && hookCalls().length === 0; i++)
    await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 30));
}

async function backfill(now = new Date("2026-10-25T10:00:00Z")) {
  await refreshServer(SERVER_1, now);
  await refreshServer(SERVER_1, now);
}

test("refreshServer records team workloads and reads their images", async () => {
  await backfill();
  const rows = await db.select().from(workloadImages);
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.workloadId}`).sort(),
    ["app:prj_idle", "app:prj_web", "database:db_main", "preview:prv_1"],
    "a container no team owns is never recorded",
  );
  assert.equal(rows.find((r) => r.kind === "preview")?.appId, "prj_web");
  const inv = await db.select().from(imageInventories);
  assert.deepEqual(inv.map((i) => i.imageId).sort(), [WEB_IMAGE, PG_IMAGE]);
});

test("a full match stores findings with the team's own fix, records Activity and alerts once", async () => {
  await storeKev(["CVE-1999-0001"]);
  await backfill();
  await matchWorkloads("full", new Date("2026-10-25T10:05:00Z"));

  const web = await db
    .select()
    .from(securityFindings)
    .where(eq(securityFindings.workloadId, "prj_web"));
  assert.deepEqual(
    web.map((f) => `${f.packageName}:${f.level}:${f.fix}`).sort(),
    ["minimist:critical:code", "openssl:critical:rebuild"],
    "kernel headers are never matched",
  );
  const pgFindings = await db
    .select()
    .from(securityFindings)
    .where(eq(securityFindings.workloadId, "db_main"));
  assert.deepEqual(
    pgFindings.map((f) => f.fix),
    ["none"],
    "a vendor image with no newer build has no fix the team can apply",
  );

  const acts = await db.select().from(activities);
  assert.deepEqual(acts.map((a) => a.message).sort(), [
    "Found 2 security updates in prj_idle",
    "Found 2 security updates in prj_web",
  ]);
  await settle();
  assert.equal(
    hookCalls().length,
    1,
    "one alert, for the running app; never for stopped apps or previews",
  );
  assert.match(
    JSON.stringify(hookCalls()[0].body),
    /Security updates for prj_web/,
  );

  await matchWorkloads("full", new Date("2026-10-25T16:10:00Z"));
  await settle();
  assert.equal(hookCalls().length, 1, "a finding alerts once");
  assert.equal(
    (await db.select().from(activities)).length,
    2,
    "nothing new, nothing recorded",
  );
});

test("an exploited flaw alerts even without a fix", async () => {
  await storeKev(["CVE-2024-5535"]);
  workloads = [workloads[3]];
  await backfill();
  await matchWorkloads("full", new Date("2026-10-25T10:05:00Z"));
  const [f] = await db.select().from(securityFindings);
  assert.equal(f.level, "exploited");
  await settle();
  assert.equal(hookCalls().length, 1);
  assert.match(JSON.stringify(hookCalls()[0].body), /already used in attacks/);
});

test("OSV down: matching throws and every finding stays as it was", async () => {
  await backfill();
  await matchWorkloads("full", new Date("2026-10-25T10:05:00Z"));
  await settle();
  const beforeRows = await db.select().from(securityFindings);
  osvDown = true;
  await assert.rejects(
    matchWorkloads("full", new Date("2026-10-25T16:10:00Z")),
    OsvUnavailableError,
  );
  assert.equal(
    (await db.select().from(securityFindings)).length,
    beforeRows.length,
  );
});

test("a new image without the flaw resolves it on the light pass", async () => {
  await backfill();
  await matchWorkloads("full", new Date("2026-10-25T10:05:00Z"));
  await settle();
  workloads[0] = wl({ projectId: "prj_web", imageId: WEB_IMAGE_2 });
  packagesOf[WEB_IMAGE_2] = [
    { purl: OPENSSL, location: "/var/lib/dpkg/status" },
  ];
  await backfill(new Date("2026-10-25T11:00:00Z"));
  const res = await matchWorkloads("light", new Date("2026-10-25T11:01:00Z"));
  assert.equal(
    res.workloads,
    1,
    "the light pass only reads the changed workload",
  );
  const web = await db
    .select()
    .from(securityFindings)
    .where(eq(securityFindings.workloadId, "prj_web"));
  assert.deepEqual(
    web.map((f) => f.packageName),
    ["openssl"],
  );
  const msgs = (await db.select().from(activities)).map((a) => a.message);
  assert.ok(
    msgs.includes("1 security update in prj_web is fixed"),
    msgs.join(" | "),
  );
});
