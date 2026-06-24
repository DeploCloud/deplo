import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { PGlite, types } from "@electric-sql/pglite";

/**
 * Step -1 GATE — throwaway pglite spike (relational-store PLAN §8 / Step -1).
 *
 * Before any schema work, this spike proves an in-process Postgres (pglite) can
 * execute EVERY Postgres feature the relational-store migration leans on. Today
 * the test suite runs pure in-memory with NO SQL at all (lib/db/pg.ts:11-16),
 * so pglite is the candidate test backend once the data layer goes relational.
 *
 *   ALL GREEN  → pglite becomes the test backend under NODE_TEST_CONTEXT.
 *   ANY RED    → fall back to Testcontainers / real Postgres (Docker is already
 *                the product's hard prerequisite).
 *
 * The nine checks below map 1:1 to the Step -1 validation list:
 *   1. partial-unique  (WHERE is_primary, WHERE status='pending')
 *   2. expression unique index  UNIQUE(lower(email))
 *   3. ON CONFLICT … RETURNING
 *   4. bigint identity columns
 *   5. pgEnum  (CREATE TYPE … AS ENUM + a typed column)
 *   6. conditional-rollback tx  (UPDATE … WHERE status='pending' RETURNING → 0
 *      rows → throw → ROLLBACK)
 *   7. the multi-row primary FLIP  SET is_primary = (id = $target)
 *   8. the timestamp type-parser round-trip  (write nowIso() → read canonical T…Z)
 *
 * This file is intentionally a SPIKE: it talks to a raw PGlite instance (not the
 * app's Drizzle client, which doesn't exist yet) and is DELETED once Step 0/1
 * land the real schema + a Drizzle-backed test harness. It exists only to make
 * the GATE decision evidence-backed.
 *
 * NOTE — the in-memory store fallback (lib/db/pg.ts) is unaffected: this is an
 * additive throwaway test that constructs its own PGlite, so the rest of the
 * SQL-free suite keeps running exactly as before.
 */

/**
 * The single choke point the plan installs in lib/db/pg.ts: map node-postgres
 * OID 1184 (timestamptz) and 1114 (timestamp) to canonical ISO `T…Z` strings,
 * so `*_at` columns read back lexicographically-sortable regardless of how they
 * were written. pglite has its OWN parser registry (not node-postgres's global
 * `pg.types`), so the gate must prove the equivalent override works here. A
 * raw timestamptz otherwise renders as a JS Date in pglite (and a space-
 * separated string in node-postgres) — both break the 15+ lexicographic
 * createdAt sorts during the migration window (PLAN §1, §10).
 */
const isoTimestampParser = (v: string | null): string | null =>
  v == null ? null : new Date(v).toISOString();

/** Matches lib/ids.ts:9 — the canonical write-side timestamp. */
const nowIso = () => new Date().toISOString();

let db: PGlite;

before(async () => {
  db = new PGlite({
    parsers: {
      [types.TIMESTAMPTZ]: isoTimestampParser,
      [types.TIMESTAMP]: isoTimestampParser,
    },
  });
  // Reaching `query` proves the WASM engine actually boots in this runner.
  await db.query("select 1");
});

after(async () => {
  await db.close();
});

/* ------------------------------------------------------------------ */
/* 1. Partial-unique indexes                                          */
/* ------------------------------------------------------------------ */

test("partial-unique: only ONE primary domain per project (WHERE is_primary)", async () => {
  await db.exec(`
    create table domains (
      id text primary key,
      project_id text not null,
      is_primary boolean not null default false
    );
    create unique index domains_one_primary
      on domains (project_id) where is_primary;
  `);

  // Two NON-primary rows for the same project coexist (partial predicate skips them).
  await db.query("insert into domains (id, project_id, is_primary) values ($1,$2,$3)", ["d1", "p1", false]);
  await db.query("insert into domains (id, project_id, is_primary) values ($1,$2,$3)", ["d2", "p1", true]);
  await db.query("insert into domains (id, project_id, is_primary) values ($1,$2,$3)", ["d3", "p1", false]);

  // A SECOND primary for the same project violates the partial unique.
  await assert.rejects(
    () => db.query("insert into domains (id, project_id, is_primary) values ($1,$2,$3)", ["d4", "p1", true]),
    /unique|duplicate/i,
    "a second is_primary=true for the same project must be rejected",
  );

  // A primary for a DIFFERENT project is fine.
  await db.query("insert into domains (id, project_id, is_primary) values ($1,$2,$3)", ["d5", "p2", true]);
});

test("partial-unique: one pending invite per (team,email) (WHERE status='pending')", async () => {
  await db.exec(`
    create table invites (
      id text primary key,
      team_id text not null,
      email text not null,
      status text not null
    );
    create unique index invites_one_pending
      on invites (team_id, email) where status = 'pending';
  `);

  await db.query("insert into invites values ($1,$2,$3,$4)", ["i1", "t1", "a@x.io", "pending"]);

  // A second PENDING invite to the same address on the same team is rejected …
  await assert.rejects(
    () => db.query("insert into invites values ($1,$2,$3,$4)", ["i2", "t1", "a@x.io", "pending"]),
    /unique|duplicate/i,
  );

  // … but a REVOKED/accepted one (status ≠ 'pending') escapes the partial predicate,
  // so the soft-lifecycle history can keep many non-pending rows.
  await db.query("insert into invites values ($1,$2,$3,$4)", ["i3", "t1", "a@x.io", "revoked"]);
  await db.query("insert into invites values ($1,$2,$3,$4)", ["i4", "t1", "a@x.io", "accepted"]);
});

/* ------------------------------------------------------------------ */
/* 2. Expression unique index  UNIQUE(lower(email))                   */
/* ------------------------------------------------------------------ */

test("expression unique: UNIQUE(lower(email)) makes email case-insensitive", async () => {
  await db.exec(`
    create table users (
      id text primary key,
      email text not null
    );
    create unique index users_email_lower on users (lower(email));
  `);

  await db.query("insert into users values ($1,$2)", ["u1", "Alice@Example.com"]);

  // Different byte-string, same lower() → must collide (the app does
  // case-insensitive email checks; the index is what enforces it).
  await assert.rejects(
    () => db.query("insert into users values ($1,$2)", ["u2", "alice@example.com"]),
    /unique|duplicate/i,
  );

  // A genuinely different address is fine.
  await db.query("insert into users values ($1,$2)", ["u3", "bob@example.com"]);

  // And the index is usable for case-insensitive lookup.
  const r = await db.query<{ id: string }>("select id from users where lower(email) = lower($1)", [
    "ALICE@EXAMPLE.COM",
  ]);
  assert.equal(r.rows[0]?.id, "u1");
});

/* ------------------------------------------------------------------ */
/* 3. ON CONFLICT … RETURNING (env-var upsert; lease CAS)             */
/* ------------------------------------------------------------------ */

test("ON CONFLICT … RETURNING: upsert returns the surviving row", async () => {
  await db.exec(`
    create table env_vars (
      id text primary key,
      project_id text not null,
      key text not null,
      value_enc text not null,
      unique (project_id, key)
    );
  `);

  const upsert = (id: string, val: string) =>
    db.query<{ id: string; value_enc: string }>(
      `insert into env_vars (id, project_id, key, value_enc)
       values ($1,'p1','API_KEY',$2)
       on conflict (project_id, key) do update set value_enc = excluded.value_enc
       returning id, value_enc`,
      [id, val],
    );

  const first = await upsert("e1", "v1");
  assert.equal(first.rows[0]?.value_enc, "v1");
  assert.equal(first.rows[0]?.id, "e1");

  // Conflicting insert updates in place; RETURNING shows the new value and the
  // ORIGINAL id (the row was updated, not replaced).
  const second = await upsert("e2", "v2");
  assert.equal(second.rows[0]?.value_enc, "v2");
  assert.equal(second.rows[0]?.id, "e1", "ON CONFLICT updates the existing row, keeping its id");

  const count = await db.query<{ n: number }>("select count(*)::int as n from env_vars");
  assert.equal(count.rows[0]?.n, 1);
});

test("ON CONFLICT DO UPDATE … WHERE: the lease-CAS shape (loser gets 0 rows)", async () => {
  // Mirrors lib/backups/lease.ts acquirePostgres: the conditional ON CONFLICT
  // WHERE means a live foreign owner blocks the update → 0 rows returned.
  await db.exec(`
    create table scheduler_lease (
      name text primary key,
      owner text not null,
      heartbeat_at timestamptz not null default now()
    );
  `);

  const acquire = (owner: string) =>
    db.query<{ owner: string }>(
      `insert into scheduler_lease (name, owner, heartbeat_at)
       values ('L', $1, now())
       on conflict (name) do update
         set owner = excluded.owner, heartbeat_at = now()
         where scheduler_lease.owner = excluded.owner
            or scheduler_lease.heartbeat_at < now() - interval '2 hours'
       returning owner`,
      [owner],
    );

  assert.equal((await acquire("a")).rows[0]?.owner, "a"); // fresh claim
  assert.equal((await acquire("a")).rows[0]?.owner, "a"); // renew (idempotent)
  assert.equal((await acquire("b")).rows.length, 0, "a live foreign owner blocks → 0 rows");
});

/* ------------------------------------------------------------------ */
/* 4. bigint identity columns (seq / id ordering)                     */
/* ------------------------------------------------------------------ */

test("bigint identity: GENERATED ALWAYS AS IDENTITY yields a monotone seq", async () => {
  await db.exec(`
    create table activities (
      seq bigint generated always as identity primary key,
      team_id text not null,
      created_at timestamptz not null
    );
  `);

  // Insert three rows in the SAME millisecond — the timestamp ties, seq breaks it.
  const sameMs = "2026-06-24T00:00:00.000Z";
  for (const t of ["t1", "t2", "t3"]) {
    await db.query("insert into activities (team_id, created_at) values ($1,$2)", [t, sameMs]);
  }

  const r = await db.query<{ seq: string; team_id: string }>(
    "select seq, team_id from activities order by created_at desc, seq desc",
  );
  // seq is a bigint → node/pg surfaces it as a string; assert strict monotonic order.
  const seqs = r.rows.map((x) => Number(x.seq));
  assert.deepEqual(seqs, [3, 2, 1], "ORDER BY created_at DESC, seq DESC is total even on a ms tie");
  assert.deepEqual(
    r.rows.map((x) => x.team_id),
    ["t3", "t2", "t1"],
  );

  // IDENTITY rejects a manual value unless OVERRIDING SYSTEM VALUE — proving it's
  // truly generated (the backfill assigns seq in source-array order via override).
  await db.query(
    "insert into activities (seq, team_id, created_at) overriding system value values ($1,$2,$3)",
    [100, "backfilled", sameMs],
  );
  const top = await db.query<{ seq: string }>("select seq from activities order by seq desc limit 1");
  assert.equal(Number(top.rows[0]?.seq), 100, "OVERRIDING SYSTEM VALUE lets backfill set seq explicitly");
});

/* ------------------------------------------------------------------ */
/* 5. pgEnum  (CREATE TYPE … AS ENUM + typed column)                  */
/* ------------------------------------------------------------------ */

test("pgEnum: a typed enum column accepts members and rejects strangers", async () => {
  await db.exec(`
    create type deployment_log_level as enum ('info', 'warn', 'error');
    create table deployment_logs (
      id bigint generated always as identity primary key,
      deployment_id text not null,
      level deployment_log_level not null,
      line text not null
    );
  `);

  await db.query("insert into deployment_logs (deployment_id, level, line) values ($1,$2,$3)", [
    "dep1",
    "info",
    "hello",
  ]);
  await db.query("insert into deployment_logs (deployment_id, level, line) values ($1,$2,$3)", [
    "dep1",
    "error",
    "boom",
  ]);

  await assert.rejects(
    () =>
      db.query("insert into deployment_logs (deployment_id, level, line) values ($1,$2,$3)", [
        "dep1",
        "debug", // not a member — must be coerced at backfill, never inserted raw
        "x",
      ]),
    /invalid input value for enum|deployment_log_level/i,
  );
});

/* ------------------------------------------------------------------ */
/* 6. Conditional-rollback transaction                                */
/*    (registration-link single-use; double-submit loser throws)      */
/* ------------------------------------------------------------------ */

test("conditional-rollback tx: UPDATE…WHERE status='pending' RETURNING 0 rows → throw → ROLLBACK", async () => {
  await db.exec(`
    create table registration_links (
      id text primary key,
      status text not null,
      expires_at timestamptz not null,
      used_by_username text
    );
    create table reg_users (id2 text primary key, username text not null);
  `);
  const future = "2999-01-01T00:00:00.000Z";
  await db.query("insert into registration_links values ($1,'pending',$2,null)", ["rl1", future]);

  // The createAccountWithTeam critical section (PLAN §1 "THE hard one"): consume
  // the link as a CONDITIONAL UPDATE inside the tx; 0 rows ⇒ the loser of a
  // double-submit throws and the whole tx rolls back (no half-created user).
  const consume = async (username: string) => {
    await db.transaction(async (tx) => {
      const consumed = await tx.query<{ id: string }>(
        `update registration_links
           set status = 'used', used_by_username = $2
         where id = $1 and status = 'pending' and expires_at >= now()
         returning id`,
        ["rl1", username],
      );
      if (consumed.rows.length === 0) {
        throw new Error("registration link already used or expired");
      }
      await tx.query("insert into reg_users (id2, username) values ($1,$2)", [
        `u_${username}`,
        username,
      ]);
    });
  };

  // First submit wins.
  await consume("alice");

  // Second submit: the UPDATE matches 0 rows (status is now 'used') → throws →
  // the speculative user insert is rolled back.
  await assert.rejects(() => consume("bob"), /already used or expired/);

  const users = await db.query<{ username: string }>("select username from reg_users");
  assert.deepEqual(
    users.rows.map((u) => u.username),
    ["alice"],
    "exactly one user is created; the loser's insert rolled back",
  );

  const link = await db.query<{ status: string; used_by_username: string }>(
    "select status, used_by_username from registration_links where id='rl1'",
  );
  assert.equal(link.rows[0]?.status, "used");
  assert.equal(link.rows[0]?.used_by_username, "alice");
});

/* ------------------------------------------------------------------ */
/* 7. The multi-row primary FLIP  SET is_primary = (id = $target)     */
/* ------------------------------------------------------------------ */

test("primary flip: one UPDATE makes exactly the target primary, atomically", async () => {
  await db.exec(`
    create table flip_domains (
      id text primary key,
      project_id text not null,
      is_primary boolean not null default false
    );
    create unique index flip_one_primary
      on flip_domains (project_id) where is_primary;
  `);
  await db.query("insert into flip_domains values ('a','p1',true)");
  await db.query("insert into flip_domains values ('b','p1',false)");
  await db.query("insert into flip_domains values ('c','p1',false)");
  // A domain on another project must be untouched by the flip.
  await db.query("insert into flip_domains values ('z','p2',true)");

  // setPrimaryDomain becomes ONE statement: clears the old primary and sets the
  // new one in a single atomic UPDATE — the partial-unique index can never be
  // transiently violated mid-statement.
  await db.query(
    "update flip_domains set is_primary = (id = $1) where project_id = $2",
    ["c", "p1"],
  );

  const primaries = await db.query<{ id: string }>(
    "select id from flip_domains where project_id='p1' and is_primary order by id",
  );
  assert.deepEqual(primaries.rows.map((r) => r.id), ["c"], "exactly the target is primary");

  const other = await db.query<{ id: string }>(
    "select id from flip_domains where project_id='p2' and is_primary",
  );
  assert.deepEqual(other.rows.map((r) => r.id), ["z"], "other projects untouched");
});

/* ------------------------------------------------------------------ */
/* 8. Timestamp type-parser round-trip                                */
/*    write nowIso() → read canonical lexicographically-sortable T…Z  */
/* ------------------------------------------------------------------ */

test("timestamp parser: timestamptz round-trips to canonical ISO T…Z (sortable)", async () => {
  await db.exec(`
    create table stamped (
      id text primary key,
      created_at timestamptz not null
    );
  `);

  // Write exactly what nowIso() / the app writes — an ISO 8601 'T…Z' string.
  const written = nowIso();
  await db.query("insert into stamped values ($1,$2)", ["s1", written]);

  const r = await db.query<{ created_at: string }>("select created_at from stamped where id='s1'");
  const readBack = r.rows[0]?.created_at;

  // The parser MUST return a string (not a Date), in canonical ISO form, so a
  // lexicographic createdAt sort is correct. Without the parser, pglite returns
  // a JS Date and node-postgres returns a space-separated '…+00' string — both
  // break the 15+ lexicographic sorts across the migration window.
  assert.equal(typeof readBack, "string", "the OID-1184 parser yields a string, not a Date");
  assert.match(
    readBack!,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "read-back is canonical ISO 'YYYY-MM-DDTHH:MM:SS.sssZ'",
  );
  assert.equal(readBack, written, "byte-for-byte equal to the original nowIso() write");

  // The decisive property: a mix of legacy-'T' writes and fresh writes still
  // sorts correctly, because EVERY read is canonicalised to the same 'T…Z' form.
  await db.query("insert into stamped values ($1,$2)", ["s0", "2020-01-01T00:00:00.000Z"]);
  await db.query("insert into stamped values ($1,$2)", ["s2", "2030-01-01T00:00:00.000Z"]);
  const ordered = await db.query<{ id: string }>(
    "select id from stamped order by created_at asc",
  );
  assert.deepEqual(
    ordered.rows.map((x) => x.id),
    ["s0", "s1", "s2"],
    "lexicographic createdAt ordering holds across mixed-origin timestamps",
  );
});
