import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";

import { buildSeed } from "../../seed";
import {
  defaultNotificationSettings,
  type DeploData,
  type NotificationSettings,
} from "../../types";
import { appSlug } from "../../apps/runtime";
import {
  apiTokens,
  installedApps,
  notificationSettings,
  registries,
  storeMigration,
  teams,
  users,
} from "../schema/control-plane";
import { makeTestDb, type TestDb } from "../test-harness";
import { runBackfill } from "./engine";
import { leafCutSetCopy, reconcileLeaf } from "./cut-sets/leaf";
import { seedIdentityRoots } from "./roots";
import { CUT_SETS, markerExists } from "./markers";
import type { BackfillTx } from "./types";

/**
 * Step 1 backfill-engine test (relational-store PLAN §9 Step 1: "an engine test
 * seeds a `DeploData` doc and runs one cut-set's backfill against pglite,
 * asserting element-granular fidelity + idempotent re-run + fresh-install
 * marks-done-with-zero-rows").
 *
 * It exercises the LEAF cut-set (a) — `apiTokens`, `notificationSettings`,
 * `registries`, `installedApps` — the simplest cut-set, chosen to prove the engine
 * + the pglite test backend end-to-end on the lowest risk (PLAN §3). A fresh
 * pglite per test (migrations replayed) keeps each case isolated.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
});

after(async () => {
  await pg.close();
});

// Each test starts from an empty relational store (truncate the leaf tables +
// roots + markers) so cases don't leak into one another while sharing one pglite.
beforeEach(async () => {
  await pg.exec(`
    truncate table api_tokens, registries, installed_apps,
      notification_settings, store_migration, users, teams restart identity cascade;
  `);
});

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

function settingsFor(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  return { ...defaultNotificationSettings(), ...overrides };
}

/** A realistic leaf-cut-set document: 2 teams, 2 users, and rows in all four leaf collections. */
function leafFixture(): DeploData {
  const d = buildSeed();
  d.teams = [
    { id: "team_a", name: "Alpha", slug: "alpha", plan: "pro", createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "team_b", name: "Beta", slug: "beta", plan: "enterprise", createdAt: "2026-01-02T00:00:00.000Z" },
  ];
  d.users = [
    {
      id: "user_1", email: "Owner@Alpha.io", username: "owner", name: "Owner",
      passwordHash: "scrypt$x", role: "owner", isInstanceAdmin: true,
      avatarColor: "#abc", createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "user_2", email: "dev@beta.io", username: "dev", name: "Dev",
      passwordHash: "scrypt$y", role: "member",
      avatarColor: "#def", createdAt: "2026-01-02T00:00:00.000Z",
    },
  ];
  d.apiTokens = [
    {
      id: "tok_1", teamId: "team_a", userId: "user_1", name: "CI",
      tokenHash: "hash_ci", prefix: "deplo_ci", lastUsedAt: "2026-03-01T00:00:00.000Z",
      createdAt: "2026-02-01T00:00:00.000Z",
    },
    {
      id: "tok_2", teamId: "team_b", userId: "user_2", name: "Deploy",
      tokenHash: "hash_dep", prefix: "deplo_dp", lastUsedAt: null,
      createdAt: "2026-02-02T00:00:00.000Z",
    },
  ];
  d.registries = [
    {
      id: "reg_1", teamId: "team_a", name: "GHCR", type: "ghcr",
      registryUrl: "ghcr.io", username: "alpha", passwordEnc: "enc_pw",
      createdAt: "2026-02-03T00:00:00.000Z",
    },
  ];
  d.installedApps = [
    {
      id: "app_1", teamId: "team_a", catalogId: "mcp", slug: "mcp__alpha",
      version: "1.0.0", createdAt: "2026-02-04T00:00:00.000Z",
    },
    // Legacy empty-slug row: the backfill must derive appSlug(catalogId, teamSlug).
    {
      id: "app_2", teamId: "team_b", catalogId: "mcp", slug: "",
      version: "1.0.0", createdAt: "2026-02-05T00:00:00.000Z",
    },
  ];
  d.notificationSettings = {
    team_a: settingsFor({
      channels: {
        push: { enabled: true },
        email: { enabled: true, address: "alerts@alpha.io" },
        discord: { enabled: false, webhookUrl: "" },
        webhook: { enabled: true, url: "https://hook.alpha.io" },
      },
    }),
    // team_b deliberately has NO entry → must stay absent (falls back to default).
  };
  return d;
}

/**
 * Insert every leaf row CORRECTLY (so the count checks pass) but with the
 * notification_settings `emailAddress` tampered to NOT match the source doc — a
 * value drift no DB constraint would catch. Used to prove reconcileLeaf's
 * element-granular round-trip assert fires, not just the DB's FK/CHECK/UNIQUE.
 */
async function seedThenWrongSettings(tx: BackfillTx, data: DeploData): Promise<void> {
  await seedIdentityRoots(tx, data);
  const teamSlugById = new Map(data.teams.map((t) => [t.id, t.slug] as const));
  await tx.insert(apiTokens).values(
    data.apiTokens.map((t) => ({
      id: t.id, teamId: t.teamId, userId: t.userId, name: t.name,
      tokenHash: t.tokenHash, prefix: t.prefix, lastUsedAt: t.lastUsedAt,
      createdAt: t.createdAt,
    })),
  );
  await tx.insert(registries).values(
    data.registries.map((r) => ({
      id: r.id, teamId: r.teamId, name: r.name, type: r.type,
      registryUrl: r.registryUrl, username: r.username, passwordEnc: r.passwordEnc,
      createdAt: r.createdAt,
    })),
  );
  await tx.insert(installedApps).values(
    data.installedApps.map((a) => ({
      id: a.id, teamId: a.teamId, catalogId: a.catalogId,
      slug: a.slug || appSlug(a.catalogId, teamSlugById.get(a.teamId) ?? ""),
      version: a.version, createdAt: a.createdAt,
    })),
  );
  const [teamId, s] = Object.entries(data.notificationSettings)[0]!;
  await tx.insert(notificationSettings).values({
    teamId,
    pushEnabled: s.channels.push.enabled,
    emailEnabled: s.channels.email.enabled,
    emailAddress: "TAMPERED@evil.io", // ← drift from the source
    discordEnabled: s.channels.discord.enabled,
    discordWebhookUrl: s.channels.discord.webhookUrl,
    webhookEnabled: s.channels.webhook.enabled,
    webhookUrl: s.channels.webhook.url,
    deploymentFailed: s.events.deployment_failed,
    deploymentSucceeded: s.events.deployment_succeeded,
    serverOffline: s.events.server_offline,
    highResourceUsage: s.events.high_resource_usage,
    updateAvailable: s.events.update_available,
  });
}

/* ------------------------------------------------------------------ */
/* Element-granular fidelity                                            */
/* ------------------------------------------------------------------ */

test("leaf backfill: copies every leaf row with field-level fidelity", async () => {
  const d = leafFixture();
  await runBackfill(db, CUT_SETS.leaf, d, leafCutSetCopy);

  // Roots seeded so the leaf FKs resolve.
  assert.equal((await db.select({ n: count() }).from(teams))[0]!.n, 2);
  assert.equal((await db.select({ n: count() }).from(users))[0]!.n, 2);

  // api_tokens — field-for-field.
  const tokens = await db.select().from(apiTokens).orderBy(apiTokens.id);
  assert.equal(tokens.length, 2);
  assert.deepEqual(
    { id: tokens[0]!.id, teamId: tokens[0]!.teamId, userId: tokens[0]!.userId, tokenHash: tokens[0]!.tokenHash, lastUsedAt: tokens[0]!.lastUsedAt, createdAt: tokens[0]!.createdAt },
    { id: "tok_1", teamId: "team_a", userId: "user_1", tokenHash: "hash_ci", lastUsedAt: "2026-03-01T00:00:00.000Z", createdAt: "2026-02-01T00:00:00.000Z" },
  );
  assert.equal(tokens[1]!.lastUsedAt, null, "null lastUsedAt round-trips as null");

  // registries.
  const regs = await db.select().from(registries);
  assert.equal(regs.length, 1);
  assert.equal(regs[0]!.passwordEnc, "enc_pw", "secret stored as-is");

  // installed_apps — including the derived slug for the legacy empty-slug row.
  const apps = await db.select().from(installedApps).orderBy(installedApps.id);
  assert.equal(apps[0]!.slug, "mcp__alpha", "existing slug preserved");
  assert.equal(apps[1]!.slug, appSlug("mcp", "beta"), "empty slug derived from catalogId + teamSlug");

  // notification_settings — only the present key, channels + events round-trip.
  const settings = await db.select().from(notificationSettings);
  assert.equal(settings.length, 1, "team_b stays absent (default at read)");
  const a = settings[0]!;
  assert.equal(a.teamId, "team_a");
  assert.equal(a.pushEnabled, true);
  assert.equal(a.emailEnabled, true);
  assert.equal(a.emailAddress, "alerts@alpha.io");
  assert.equal(a.webhookEnabled, true);
  assert.equal(a.webhookUrl, "https://hook.alpha.io");
  // events default: failed/offline/usage/update true, succeeded false.
  assert.equal(a.deploymentFailed, true);
  assert.equal(a.deploymentSucceeded, false);
  assert.equal(a.updateAvailable, true);

  // Marker written.
  assert.equal(await markerExists(db, CUT_SETS.leaf), true);
});

/* ------------------------------------------------------------------ */
/* Legacy normalization (stamps teamId / userId before exploding)      */
/* ------------------------------------------------------------------ */

test("leaf backfill: legacy rows missing teamId/userId are stamped, not FK-violated", async () => {
  // A pre-multi-team / pre-principal document: leaf rows carry NO teamId/userId
  // (migrate() stamps them on read but never persists). The backfill must run the
  // same normalization before exploding, or the NOT-NULL FK insert fails and the
  // instance becomes un-migratable.
  const d = buildSeed();
  d.teams = [
    { id: "team_a", name: "Alpha", slug: "alpha", plan: "pro", createdAt: "2026-01-01T00:00:00.000Z" },
  ];
  d.users = [
    {
      id: "user_1", email: "owner@alpha.io", username: "owner", name: "Owner",
      passwordHash: "h", role: "owner", avatarColor: "#abc",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  // Legacy shapes: no teamId on the token/registry, no userId on the token.
  d.apiTokens = [
    {
      id: "tok_legacy", name: "CI", tokenHash: "h", prefix: "p", lastUsedAt: null,
      createdAt: "2026-02-01T00:00:00.000Z",
    } as unknown as (typeof d.apiTokens)[number],
  ];
  d.registries = [
    {
      id: "reg_legacy", name: "GHCR", type: "ghcr", registryUrl: "ghcr.io",
      username: "u", passwordEnc: "e", createdAt: "2026-02-02T00:00:00.000Z",
    } as unknown as (typeof d.registries)[number],
  ];

  await runBackfill(db, CUT_SETS.leaf, d, leafCutSetCopy);

  // Stamped to the first team; token's userId resolved to the team owner.
  const tok = await db.select().from(apiTokens).where(eq(apiTokens.id, "tok_legacy"));
  assert.equal(tok[0]!.teamId, "team_a", "legacy token teamId stamped to first team");
  assert.equal(tok[0]!.userId, "user_1", "legacy token userId resolved to the owner");
  const reg = await db.select().from(registries).where(eq(registries.id, "reg_legacy"));
  assert.equal(reg[0]!.teamId, "team_a", "legacy registry teamId stamped to first team");
  assert.equal(await markerExists(db, CUT_SETS.leaf), true);
});

/* ------------------------------------------------------------------ */
/* Idempotent re-run                                                   */
/* ------------------------------------------------------------------ */

test("leaf backfill: a second run is a no-op (marker gates it)", async () => {
  const d = leafFixture();
  await runBackfill(db, CUT_SETS.leaf, d, leafCutSetCopy);
  // Re-run with the SAME doc: if the copy ran again it would insert duplicate ids
  // and throw on the PK; the marker must short-circuit it instead.
  await runBackfill(db, CUT_SETS.leaf, d, leafCutSetCopy);

  assert.equal((await db.select({ n: count() }).from(apiTokens))[0]!.n, 2);
  assert.equal((await db.select({ n: count() }).from(installedApps))[0]!.n, 2);
  // Exactly one marker row.
  assert.equal((await db.select({ n: count() }).from(storeMigration))[0]!.n, 1);
});

/* ------------------------------------------------------------------ */
/* Fresh install — marks done with zero rows                           */
/* ------------------------------------------------------------------ */

test("leaf backfill: a fresh install marks done with zero copied rows", async () => {
  const empty = buildSeed(); // no teams/users/leaf rows at all
  await runBackfill(db, CUT_SETS.leaf, empty, leafCutSetCopy);

  assert.equal(await markerExists(db, CUT_SETS.leaf), true, "marker written even with nothing to copy");
  assert.equal((await db.select({ n: count() }).from(apiTokens))[0]!.n, 0);
  assert.equal((await db.select({ n: count() }).from(notificationSettings))[0]!.n, 0);

  // And it then no-ops on the next boot.
  await runBackfill(db, CUT_SETS.leaf, empty, leafCutSetCopy);
  assert.equal((await db.select({ n: count() }).from(storeMigration))[0]!.n, 1);
});

/* ------------------------------------------------------------------ */
/* Reconcile mismatch → full rollback, no marker                       */
/* ------------------------------------------------------------------ */

test("leaf backfill: a failed copy rolls back the whole tx and leaves no marker", async () => {
  // A doc whose api_token points at a missing user: the NOT-NULL user_id FK
  // aborts the INSERT, which must roll back the WHOLE engine transaction (the
  // already-inserted teams/users/registries too) and leave no marker.
  const broken = leafFixture();
  broken.apiTokens[0]!.userId = "user_missing";

  await assert.rejects(() => runBackfill(db, CUT_SETS.leaf, broken, leafCutSetCopy));

  // Nothing committed: no leaf rows, no roots, no marker (so the next boot retries).
  assert.equal((await db.select({ n: count() }).from(apiTokens))[0]!.n, 0);
  assert.equal((await db.select({ n: count() }).from(registries))[0]!.n, 0);
  assert.equal((await db.select({ n: count() }).from(teams))[0]!.n, 0);
  assert.equal(await markerExists(db, CUT_SETS.leaf), false);
});

test("leaf reconcile: an element-granular drift the DB would NOT catch aborts the copy", async () => {
  // Insert the roots + a notification_settings row whose values were tampered so
  // they DON'T match the source doc — a drift no FK/CHECK/UNIQUE would catch.
  // reconcileLeaf must still flag it (proving the element-granular assert is real,
  // not a restatement of DB constraints), aborting the engine's tx.
  const d = leafFixture();
  const tamperingCopy = async (tx: Parameters<typeof leafCutSetCopy>[0], data: DeploData) => {
    await seedThenWrongSettings(tx, data);
    await reconcileLeaf(tx, data); // must throw on the value drift
  };

  await assert.rejects(
    () => runBackfill(db, CUT_SETS.leaf, d, tamperingCopy),
    /reconcile mismatch/,
  );
  assert.equal((await db.select({ n: count() }).from(notificationSettings))[0]!.n, 0, "rolled back");
  assert.equal(await markerExists(db, CUT_SETS.leaf), false);
});

/* ------------------------------------------------------------------ */
/* Timestamp fidelity through the Drizzle codec                        */
/* ------------------------------------------------------------------ */

test("leaf backfill: *_at columns read back as canonical ISO strings (sortable)", async () => {
  const d = leafFixture();
  await runBackfill(db, CUT_SETS.leaf, d, leafCutSetCopy);

  const tokens = await db.select().from(apiTokens).orderBy(apiTokens.createdAt);
  assert.equal(typeof tokens[0]!.createdAt, "string", "isoTimestamptz surfaces a string, not a Date");
  assert.match(tokens[0]!.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // Insertion order (tok_1 before tok_2) matches createdAt ascending.
  assert.deepEqual(tokens.map((t) => t.id), ["tok_1", "tok_2"]);
  // Byte-for-byte: the stored ISO string equals what the source doc carried.
  assert.equal(
    tokens.find((t) => t.id === "tok_1")!.createdAt,
    "2026-02-01T00:00:00.000Z",
  );
});
