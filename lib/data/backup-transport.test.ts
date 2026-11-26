import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { clusterMembers, clusters } from "../db/schema/control-plane/clusters";
import { servers as serversTable } from "../db/schema/control-plane/servers";
import { seedServerRow } from "./infra-test-helpers";

import type { AgentConnection } from "../infra/agent-client/connection";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import {
  BACKUP_CAPABILITY,
  BACKUP_STORE_CAPABILITY,
  BACKUP_STORE_FETCH_CAPABILITY,
  BACKUP_STORE_MEMBER_CAPABILITY,
  BACKUP_STORE_SEALED_CAPABILITY,
  POSTGRES_ARCHIVE_CAPABILITY,
} from "../infra/agent-client/hello-capabilities";
import { PostgresArchive } from "../agent/gen/agent";
import type { BackupDestination } from "../types/backup";
import { AgentOfflineError } from "../infra/agent-client/errors";
import {
  BACKUP_MEMBER_ARCHIVE_CAPABILITY,
  backupToDestination,
  restoreFromDestination,
} from "./backup-transport";

let db: TestDb;
before(async () => {
  ({ db } = await makeTestDb());
  __setTestDb(db);
});
after(() => {
  __setAgentConnectorForTest();
  __resetTestDb();
});

const hello = async () => ({
  capabilities: [BACKUP_CAPABILITY, BACKUP_STORE_CAPABILITY],
});

// eu, 23 Nov 2026: the destination's disk filled mid-copy and its write ended first. The backup said "the agent
// ended the backup without a result", and the source went on producing with lab-web paused until its stream stalled.
test("a relayed backup the destination stops taking ends the source's copy at once and says why", async () => {
  let ended = false;
  const source = {
    hello,
    close() {},
    backup: async function* () {
      try {
        for (;;) yield { data: Buffer.alloc(64 << 10) };
      } finally {
        ended = true;
      }
    },
  } as unknown as AgentConnection;
  const sink = {
    hello,
    close() {},
    writeStoreFile: async (
      _store: unknown,
      _overwrite: boolean,
      chunks: AsyncIterable<Buffer>,
    ) => {
      for await (const _ of chunks) break;
      return {
        ok: false,
        error: "no space left on device",
        bytesWritten: 0,
        sha256: "",
      };
    },
  } as unknown as AgentConnection;
  __setAgentConnectorForTest(async (id) =>
    id === "srv_src" ? source : id === "srv_dst" ? sink : null,
  );
  const dest = {
    kind: "server",
    serverId: "srv_dst",
    path: "/backups",
  } as BackupDestination;
  const out = await backupToDestination(
    { destination: dest, accessKey: "", secretKey: "", ageIdentity: "" },
    { serverId: "srv_src", kind: "app", project: { slug: "lab-web" } as never },
    "lab-web/1.tar.gz",
  );
  assert.equal(out.ok, false);
  assert.match(
    out.error,
    /the destination server stopped taking the backup: no space left on device/,
  );
  assert.ok(
    ended,
    "the source's copy is ended, so the App it paused runs again",
  );
});

/** An agent's backup call as a link carries it: data until the call is cancelled, then CANCELLED. */
function copying(onEnd: () => void) {
  return (_req: unknown, signal?: AbortSignal) =>
    (async function* () {
      try {
        while (!signal?.aborted) {
          yield { data: Buffer.alloc(16 << 10) };
          await new Promise((r) => setTimeout(r, 5));
        }
        throw new Error("1 CANCELLED: Cancelled on client");
      } finally {
        onEnd();
      }
    })();
}

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`still running after ${ms} ms`)), ms),
    ),
  ]);

// eu, 24 Nov 2026: a canceled relayed backup went on copying for 2 minutes and nearly filled eu-1. A link's
// connection closes nothing, so the cancel now ends each call: the source's copy and the destination's write.
test("a canceled relayed backup stops on both servers at once", async () => {
  let sourceEnded = false;
  let sinkStopped = false;
  const source = {
    hello,
    close() {},
    backup: copying(() => (sourceEnded = true)),
  } as unknown as AgentConnection;
  const sink = {
    hello,
    close() {},
    writeStoreFile: async (
      _store: unknown,
      _overwrite: boolean,
      chunks: AsyncIterable<Buffer>,
      signal?: AbortSignal,
    ) => {
      try {
        for await (const chunk of chunks) if (signal?.aborted || !chunk) break;
      } catch {
        // the source's end reaches the pump as an error
      }
      sinkStopped = !!signal?.aborted;
      throw new Error("1 CANCELLED: Cancelled on client");
    },
  } as unknown as AgentConnection;
  __setAgentConnectorForTest(async (id) =>
    id === "srv_src" ? source : id === "srv_dst" ? sink : null,
  );
  const abort = new AbortController();
  const run = backupToDestination(
    {
      destination: {
        kind: "server",
        serverId: "srv_dst",
        path: "/backups",
      } as BackupDestination,
      accessKey: "",
      secretKey: "",
      ageIdentity: "",
    },
    { serverId: "srv_src", kind: "app", project: { slug: "lab-web" } as never },
    "lab-web/2.tar.gz",
    abort.signal,
  );
  setTimeout(() => abort.abort(), 50);
  await within(run, 2000).catch((e: Error) => {
    if (/still running/.test(e.message)) throw e;
  });
  assert.ok(sourceEnded, "the source's copy must end");
  assert.ok(sinkStopped, "the destination's write must be cancelled");
});

test("a canceled backup written by its own server stops its call at once", async () => {
  let ended = false;
  const conn = {
    hello,
    close() {},
    backup: copying(() => (ended = true)),
  } as unknown as AgentConnection;
  __setAgentConnectorForTest(async () => conn);
  const abort = new AbortController();
  const run = backupToDestination(
    {
      destination: {
        kind: "server",
        serverId: "srv_src",
        path: "/backups",
      } as BackupDestination,
      accessKey: "",
      secretKey: "",
      ageIdentity: "",
    },
    { serverId: "srv_src", kind: "app", project: { slug: "lab-web" } as never },
    "lab-web/3.tar.gz",
    abort.signal,
  );
  setTimeout(() => abort.abort(), 50);
  await within(run, 2000).catch((e: Error) => {
    if (/still running/.test(e.message)) throw e;
  });
  assert.ok(ended, "the copy must end");
});

// eu, 24 Nov 2026: a failed relayed backup left its 184-byte age header kept on the destination as a whole backup.
test("a relayed backup is sealed with the source's own size and digest", async () => {
  let sealed: { sizeBytes: number; sha256: string } | undefined;
  const source = {
    hello,
    close() {},
    backup: async function* () {
      yield { data: Buffer.from("age-encryption.org/v1") };
      yield { result: { ok: true, sizeBytes: 21, sha256: "ab12" } };
    },
  } as unknown as AgentConnection;
  const sink = {
    hello: async () => ({
      capabilities: [
        BACKUP_CAPABILITY,
        BACKUP_STORE_CAPABILITY,
        BACKUP_STORE_SEALED_CAPABILITY,
      ],
    }),
    close() {},
    storeDelete: async () => ({ ok: true }),
    writeStoreFile: async (
      _store: unknown,
      _overwrite: boolean,
      chunks: AsyncIterable<Buffer>,
      _signal: AbortSignal,
      sealedBy?: () => { sizeBytes: number; sha256: string },
    ) => {
      for await (const _ of chunks);
      sealed = sealedBy?.();
      return { ok: true, error: "", bytesWritten: 21, sha256: "ab12" };
    },
  } as unknown as AgentConnection;
  __setAgentConnectorForTest(async (id) =>
    id === "srv_src" ? source : id === "srv_dst" ? sink : null,
  );
  const out = await backupToDestination(
    {
      destination: {
        kind: "server",
        serverId: "srv_dst",
        path: "/backups",
      } as BackupDestination,
      accessKey: "",
      secretKey: "",
      ageIdentity: "",
    },
    { serverId: "srv_src", kind: "app", project: { slug: "lab-web" } as never },
    "lab-web/1.tar.gz",
  );
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(sealed, { sizeBytes: 21, sha256: "ab12" });
});

// eu, 24 Nov 2026: the destination's link was cut mid-send and the run read "This server is offline", naming none.
test("a server lost mid-send is the one named, source or destination", async () => {
  const unavailable = () =>
    Object.assign(new Error("14 UNAVAILABLE: the link ended"), { code: 14 });
  const dest = {
    destination: {
      kind: "server",
      serverId: "srv_dst",
      path: "/backups",
    } as BackupDestination,
    accessKey: "",
    secretKey: "",
    ageIdentity: "",
  };
  for (const lost of ["srv_src", "srv_dst"]) {
    const source = {
      hello,
      close() {},
      backup: async function* () {
        yield { data: Buffer.from("age-encryption.org/v1") };
        if (lost === "srv_src") throw unavailable();
        await new Promise((r) => setTimeout(r, 50));
      },
    } as unknown as AgentConnection;
    const sink = {
      hello,
      close() {},
      writeStoreFile: async (
        _store: unknown,
        _overwrite: boolean,
        chunks: AsyncIterable<Buffer>,
      ) => {
        for await (const _ of chunks)
          if (lost === "srv_dst") throw unavailable();
        return { ok: true, error: "", bytesWritten: 0, sha256: "" };
      },
    } as unknown as AgentConnection;
    __setAgentConnectorForTest(async (id) =>
      id === "srv_src" ? source : id === "srv_dst" ? sink : null,
    );
    await assert.rejects(
      backupToDestination(
        dest,
        {
          serverId: "srv_src",
          kind: "app",
          project: { slug: "lab-web" } as never,
        },
        "lab-web/1.tar.gz",
      ),
      (e: unknown) => e instanceof AgentOfflineError && e.serverId === lost,
    );
  }
});

/** srv_src and srv_dst as members of one cluster, each with its agent's certificate. */
async function members() {
  const AT = "2026-11-24T00:00:00.000Z";
  for (const [id, fp] of [
    ["srv_src", "a"],
    ["srv_dst", "b"],
  ] as const) {
    await seedServerRow(db, { id, name: id });
    await db
      .update(serversTable)
      .set({ agentCertFingerprint: fp.repeat(64) })
      .where(eq(serversTable.id, id));
  }
  await db.insert(clusters).values({ id: "clu_eu", name: "eu", createdAt: AT });
  await db.insert(clusterMembers).values(
    ["srv_src", "srv_dst"].map((serverId) => ({
      serverId,
      clusterId: "clu_eu",
      joinedAt: AT,
    })),
  );
}

const memberHello = async () => ({
  capabilities: [
    BACKUP_CAPABILITY,
    BACKUP_STORE_CAPABILITY,
    BACKUP_STORE_MEMBER_CAPABILITY,
  ],
});

const toDst = {
  destination: {
    kind: "server",
    serverId: "srv_dst",
    path: "/backups",
  } as BackupDestination,
  accessKey: "",
  secretKey: "",
  ageIdentity: "",
};

// eu, 24 Nov 2026: a 600 MB backup from eu-3 to eu-4 went through Deplo, crossing the lab's uplink twice.
test("a backup between two members of one cluster goes between them, never through Deplo", async () => {
  await members();
  const expected: unknown[] = [];
  let relayed = false;
  let asked: { memberFingerprint?: string; streamOut?: boolean } = {};
  const source = {
    hello: memberHello,
    close() {},
    backup: async function* (req: typeof asked) {
      asked = req;
      yield {
        result: { ok: true, sizeBytes: 21, sha256: "ab12", path: "direct" },
      };
    },
  } as unknown as AgentConnection;
  const sink = {
    hello: memberHello,
    close() {},
    expectClusterBackup: async (store: unknown, from: string) =>
      void expected.push({ store, from }),
    writeStoreFile: async () => {
      relayed = true;
      return { ok: true, error: "", bytesWritten: 0, sha256: "" };
    },
  } as unknown as AgentConnection;
  __setAgentConnectorForTest(async (id) =>
    id === "srv_src" ? source : id === "srv_dst" ? sink : null,
  );
  const out = await backupToDestination(
    toDst,
    { serverId: "srv_src", kind: "app", project: { slug: "lab-web" } as never },
    "lab-web/1.tar.gz",
  );
  assert.equal(out.ok, true, out.error);
  assert.equal(out.path, "direct");
  assert.equal(relayed, false, "Deplo carried no byte of it");
  assert.equal(asked.memberFingerprint, "b".repeat(64));
  assert.deepEqual(expected, [
    {
      store: { root: "/backups", objectKey: "lab-web/1.tar.gz" },
      from: "a".repeat(64),
    },
  ]);
});

test("a backup Deplo relays only when no path joins the two members, and it says so", async () => {
  const calls: string[] = [];
  const source = {
    hello: memberHello,
    close() {},
    backup: async function* (req: { memberFingerprint?: string }) {
      if (req.memberFingerprint) {
        calls.push("member");
        yield { result: { ok: false, error: "no path", path: "none" } };
        return;
      }
      calls.push("relay");
      yield { data: Buffer.from("age-encryption.org/v1") };
      yield { result: { ok: true, sizeBytes: 21, sha256: "ab12" } };
    },
  } as unknown as AgentConnection;
  const sink = {
    hello: memberHello,
    close() {},
    expectClusterBackup: async () => {},
    writeStoreFile: async (
      _store: unknown,
      _overwrite: boolean,
      chunks: AsyncIterable<Buffer>,
    ) => {
      for await (const _ of chunks);
      return { ok: true, error: "", bytesWritten: 21, sha256: "ab12" };
    },
  } as unknown as AgentConnection;
  __setAgentConnectorForTest(async (id) =>
    id === "srv_src" ? source : id === "srv_dst" ? sink : null,
  );
  const out = await backupToDestination(
    toDst,
    { serverId: "srv_src", kind: "app", project: { slug: "lab-web" } as never },
    "lab-web/2.tar.gz",
  );
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(calls, ["member", "relay"]);
  assert.equal(out.path, "relay");
});

// c44: lab-db's 6.5 MB base backup went through Deplo in 86 s, between two members of one cluster.
test("a Postgres base backup between two members goes between them once the source can send one that way", async () => {
  await seededMembers();
  for (const archiveToo of [false, true]) {
    const calls: string[] = [];
    const caps = [
      BACKUP_CAPABILITY,
      BACKUP_STORE_CAPABILITY,
      BACKUP_STORE_MEMBER_CAPABILITY,
      POSTGRES_ARCHIVE_CAPABILITY,
      ...(archiveToo ? [BACKUP_MEMBER_ARCHIVE_CAPABILITY] : []),
    ];
    const source = {
      hello: async () => ({ capabilities: caps }),
      close() {},
      backup: async function* (req: { memberFingerprint?: string }) {
        calls.push(req.memberFingerprint ? "member" : "relay");
        if (!req.memberFingerprint)
          yield { data: Buffer.from("age-encryption.org/v1") };
        yield {
          result: {
            ok: true,
            sizeBytes: 21,
            sha256: "ab12",
            ...(req.memberFingerprint ? { path: "direct" } : {}),
          },
        };
      },
    } as unknown as AgentConnection;
    const sink = {
      hello: memberHello,
      close() {},
      expectClusterBackup: async () => {},
      writeStoreFile: async (
        _store: unknown,
        _overwrite: boolean,
        chunks: AsyncIterable<Buffer>,
      ) => {
        for await (const _ of chunks);
        return { ok: true, error: "", bytesWritten: 21, sha256: "ab12" };
      },
    } as unknown as AgentConnection;
    __setAgentConnectorForTest(async (id) =>
      id === "srv_src" ? source : id === "srv_dst" ? sink : null,
    );
    const out = await backupToDestination(
      toDst,
      {
        serverId: "srv_src",
        kind: "database",
        database: { dbType: "postgres" } as never,
        archive: PostgresArchive.POSTGRES_ARCHIVE_BASE,
      },
      "db/1.base.tar.gz.age",
    );
    assert.equal(out.ok, true, out.error);
    assert.deepEqual(calls, [archiveToo ? "member" : "relay"]);
    assert.equal(out.path, archiveToo ? "direct" : "relay");
  }
});

const fetchHello = async () => ({
  capabilities: [
    BACKUP_CAPABILITY,
    BACKUP_STORE_CAPABILITY,
    BACKUP_STORE_FETCH_CAPABILITY,
  ],
});

/** The two members, unless a test before seeded them. */
async function seededMembers() {
  const seeded = await db
    .select()
    .from(clusters)
    .where(eq(clusters.id, "clu_eu"));
  if (seeded.length === 0) await members();
}

// c38: lab-r's backup kept on eu-1 was restored onto eu-3 through Deplo: the file read from eu-1 and streamed to eu-3.
test("a restore from a backup another member keeps reads it from that member, never through Deplo", async () => {
  await seededMembers();
  const expected: unknown[] = [];
  let relayed = false;
  let asked: { memberFingerprint?: string; store?: unknown } = {};
  const workload = {
    hello: fetchHello,
    close() {},
    restore: async function* (req: typeof asked) {
      asked = req;
      yield { result: { ok: true, error: "", path: "direct" } };
    },
    restoreFrom: async function* () {
      relayed = true;
      yield { result: { ok: true, error: "" } };
    },
  } as unknown as AgentConnection;
  const holder = {
    hello: fetchHello,
    close() {},
    expectClusterFetch: async (store: unknown, reader: string) =>
      void expected.push({ store, reader }),
    readStoreFile: () => {
      relayed = true;
      return (async function* () {})();
    },
  } as unknown as AgentConnection;
  __setAgentConnectorForTest(async (id) =>
    id === "srv_src" ? workload : id === "srv_dst" ? holder : null,
  );
  const out = await restoreFromDestination(
    { ...toDst, ageIdentity: "AGE-SECRET-KEY-1X" },
    { serverId: "srv_src", kind: "app", project: { slug: "lab-r" } as never },
    "lab-r/1.tar.gz.age",
    "ab12",
  );
  assert.equal(out.ok, true, out.error);
  assert.equal(out.path, "direct");
  assert.equal(relayed, false, "Deplo carried no byte of it");
  assert.equal(asked.memberFingerprint, "b".repeat(64));
  assert.deepEqual(expected, [
    {
      store: { root: "/backups", objectKey: "lab-r/1.tar.gz.age" },
      reader: "a".repeat(64),
    },
  ]);
});

test("a restore Deplo relays only when no path joins the two members, and it says so", async () => {
  await seededMembers();
  const calls: string[] = [];
  const workload = {
    hello: fetchHello,
    close() {},
    restore: async function* () {
      calls.push("member");
      yield { result: { ok: false, error: "no path", path: "none" } };
    },
    restoreFrom: async function* (_h: unknown, chunks: AsyncIterable<Buffer>) {
      calls.push("relay");
      for await (const _ of chunks);
      yield { result: { ok: true, error: "" } };
    },
  } as unknown as AgentConnection;
  const holder = {
    hello: fetchHello,
    close() {},
    expectClusterFetch: async () => {},
    readStoreFile: () =>
      (async function* () {
        yield Buffer.from("age-encryption.org/v1");
      })(),
  } as unknown as AgentConnection;
  __setAgentConnectorForTest(async (id) =>
    id === "srv_src" ? workload : id === "srv_dst" ? holder : null,
  );
  const out = await restoreFromDestination(
    { ...toDst, ageIdentity: "AGE-SECRET-KEY-1X" },
    { serverId: "srv_src", kind: "app", project: { slug: "lab-r" } as never },
    "lab-r/2.tar.gz.age",
  );
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(calls, ["member", "relay"]);
  assert.equal(out.path, "relay");
});

// c46: lab-pg's base backup came back through Deplo, between two members of one cluster.
test("a restore of a Postgres base backup another member keeps reads it from that member", async () => {
  await seededMembers();
  let relayed = false;
  let asked: { memberFingerprint?: string } = {};
  const workload = {
    hello: async () => ({
      capabilities: [
        ...(await fetchHello()).capabilities,
        POSTGRES_ARCHIVE_CAPABILITY,
      ],
    }),
    close() {},
    restore: async function* (req: typeof asked) {
      asked = req;
      yield { result: { ok: true, error: "", path: "direct" } };
    },
    restoreFrom: async function* () {
      relayed = true;
      yield { result: { ok: true, error: "" } };
    },
  } as unknown as AgentConnection;
  const holder = {
    hello: fetchHello,
    close() {},
    expectClusterFetch: async () => {},
    readStoreFile: () => {
      relayed = true;
      return (async function* () {})();
    },
  } as unknown as AgentConnection;
  __setAgentConnectorForTest(async (id) =>
    id === "srv_src" ? workload : id === "srv_dst" ? holder : null,
  );
  const out = await restoreFromDestination(
    { ...toDst, ageIdentity: "AGE-SECRET-KEY-1X" },
    {
      serverId: "srv_src",
      kind: "database",
      database: { dbType: "postgres" } as never,
    },
    "db/1.base.tar.gz.age",
  );
  assert.equal(out.ok, true, out.error);
  assert.equal(out.path, "direct");
  assert.equal(relayed, false, "Deplo carried no byte of it");
  assert.equal(asked.memberFingerprint, "b".repeat(64));
});
