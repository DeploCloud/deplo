import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { type PGlite, types } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import { makeEmptyTestPg } from "./test-harness";
import { isoTimestampParser } from "./timestamp-parser";
import { schema } from "./schema";
import { __setTestDb, __resetTestDb } from "./client";
import { getServerById } from "../data/servers/roster";

// Every server links in (ADR-0040): the pin alone says who enrolled, and the port stays for a rollback.
const T0 = "2026-01-01T00:00:00.000Z";
const MIG_DIR = path.join(process.cwd(), "lib", "db", "migrations");
// Deplo 0.6.0's last migration: the installer rolls a failed update back onto this database.
const PREVIOUS_RELEASE_LAST = 204;

let pg: PGlite;
let previousBefore: Map<string, string | null>;

// How 0.6.0 reads a server's agent: its full row, and an agent only where a port is stored.
async function readAsPreviousRelease(): Promise<Map<string, string | null>> {
  const snapshot = JSON.parse(
    readFileSync(
      path.join(MIG_DIR, "meta", `0${PREVIOUS_RELEASE_LAST}_snapshot.json`),
      "utf8",
    ),
  );
  const columns = Object.keys(snapshot.tables["public.servers"].columns);
  const { rows } = await pg.query<Record<string, unknown>>(
    `select ${columns.map((c) => `"${c}"`).join(", ")} from servers order by id`,
  );
  return new Map(
    rows.map((r) => [
      r.id as string,
      r.agent_port === null
        ? null
        : ((r.agent_cert_fingerprint as string | null) ?? ""),
    ]),
  );
}

async function applyFile(file: string): Promise<void> {
  const sql = readFileSync(path.join(MIG_DIR, file), "utf8");
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const s = chunk.trim();
    if (s) await pg.exec(s);
  }
}

before(async () => {
  pg = await makeEmptyTestPg({
    parsers: {
      [types.TIMESTAMPTZ]: isoTimestampParser,
      [types.TIMESTAMP]: isoTimestampParser,
    },
  });
  const files = readdirSync(MIG_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const n = (f: string) => Number(f.slice(0, 4));
  for (const f of files.filter((f) => n(f) <= PREVIOUS_RELEASE_LAST))
    await applyFile(f);

  const row = (id: string, port: string, fingerprint: string) =>
    `('${id}','${id}','10.0.0.${id.length}','remote','online','10.0.0.${id.length}','27',true,1,1,1,${port},${fingerprint},'pem','0.5.1','${T0}')`;
  await pg.exec(`
    insert into servers (id, name, host, type, status, ip, docker_version, traefik_enabled,
      cpu_cores, memory_mb, disk_gb, agent_port, agent_cert_fingerprint, agent_cert_pem,
      agent_version, created_at)
    values ${[
      row("srv_enrolled", "9443", "'fp_enrolled'"),
      row("srv_removed", "9443", "''"),
      row("srv_waiting", "null", "null"),
      row("srv_port_only", "9443", "null"),
      row("srv_pin_only", "null", "'fp_pin_only'"),
    ].join(",")};`);

  previousBefore = await readAsPreviousRelease();
  for (const f of files.filter((f) => n(f) > PREVIOUS_RELEASE_LAST))
    await applyFile(f);
  __setTestDb(drizzle(pg, { schema }));
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

test("the agent port column stays, for a Deplo rolled back to 0.6.0", async () => {
  const { rows } = await pg.query(
    `select 1 from information_schema.columns where table_name = 'servers' and column_name = 'agent_port'`,
  );
  assert.equal(rows.length, 1);
});

test("a Deplo rolled back to 0.6.0 reads every server's agent as it did", async () => {
  const after = await readAsPreviousRelease();
  assert.deepEqual([...after], [...previousBefore]);
  assert.equal(after.get("srv_enrolled"), "fp_enrolled");
});

test("every server keeps its agent: enrolled, trust withdrawn, or none yet", async () => {
  const agentOf = async (id: string) => (await getServerById(id))?.agent;
  assert.equal((await agentOf("srv_enrolled"))?.certFingerprint, "fp_enrolled");
  assert.equal((await agentOf("srv_removed"))?.certFingerprint, "");
  assert.equal(await agentOf("srv_waiting"), undefined);
  // A port with no pin read as an agent whose trust was withdrawn; a pin with no port as none.
  assert.equal((await agentOf("srv_port_only"))?.certFingerprint, "");
  assert.equal(await agentOf("srv_pin_only"), undefined);
});
