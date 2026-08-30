import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { AgentConnection } from "../infra/agent-client";
import { EMPTY_TAR_GZ, tarGz } from "../test/tar-fixture";
import { copyVolumeBetween } from "./volume-migration";

/**
 * The byte relay, on its own. The fixtures are REAL gzipped tars: emptiness is
 * read from the archive's entries, so a stand-in buffer would prove nothing.
 */

const EMPTY = EMPTY_TAR_GZ;
const REAL = tarGz([["./blob", Buffer.alloc(200_000, 3)]]);
/** Ten bytes. Under any size threshold, and somebody's redis dump. */
const TINY = tarGz([["./dump.rdb", Buffer.from("0123456789")]]);

interface FakeSource {
  conn: AgentConnection;
  exports: string[];
}

function source(content: Record<string, Buffer | Buffer[]>): FakeSource {
  const exports: string[] = [];
  const conn = {
    async *exportVolume(name: string) {
      exports.push(name);
      const held = content[name] ?? EMPTY;
      for (const chunk of Array.isArray(held) ? held : [held]) yield chunk;
    },
  } as unknown as AgentConnection;
  return { conn, exports };
}

interface FakeDest {
  conn: AgentConnection;
  calls: string[];
  received: Record<string, Buffer>;
}

function dest(
  answer: (received: Buffer) => {
    ok: boolean;
    error: string;
    bytesWritten?: number;
    sha256?: string;
  } = () => ({ ok: true, error: "" }),
): FakeDest {
  const calls: string[] = [];
  const received: Record<string, Buffer> = {};
  const conn = {
    async importVolume(
      name: string,
      wipeFirst: boolean,
      chunks: AsyncIterable<Buffer>,
    ) {
      calls.push(`import:${name}:${wipeFirst ? "wipe" : "merge"}`);
      const parts: Buffer[] = [];
      for await (const c of chunks) parts.push(c);
      received[name] = Buffer.concat(parts);
      return answer(received[name]);
    },
  } as unknown as AgentConnection;
  return { conn, calls, received };
}

test("an empty source is not a copy, and the destination is never opened", async () => {
  const from = source({});
  const to = dest();

  const res = await copyVolumeBetween(from.conn, to.conn, "gone", "target");

  assert.equal(res.empty, true);
  assert.equal(res.bytes, 0);
  assert.deepEqual(
    to.calls,
    [],
    "a wipe-first import must not even be attempted for a source with nothing in it",
  );
});

test("a volume holding one small file is copied, not called empty", async () => {
  const from = source({ data: TINY });
  const to = dest();

  const res = await copyVolumeBetween(from.conn, to.conn, "data", "target");

  assert.equal(
    res.empty,
    false,
    "ten bytes of somebody's database is not nothing",
  );
  assert.equal(res.bytes, TINY.length);
  assert.deepEqual(to.calls, ["import:target:wipe"]);
});

test("a real volume arrives byte for byte, and the copy says how much", async () => {
  const from = source({ data: REAL });
  const to = dest();

  const res = await copyVolumeBetween(from.conn, to.conn, "data", "target");

  assert.equal(res.empty, false);
  assert.equal(res.bytes, REAL.length);
  assert.equal(res.sha256, createHash("sha256").update(REAL).digest("hex"));
  assert.deepEqual(to.received.target, REAL);
  assert.deepEqual(to.calls, ["import:target:wipe"]);
});

test("progress is reported as the bytes cross, and a throwing listener cannot fail the copy", async () => {
  const from = source({ data: [REAL, REAL] });
  const to = dest();
  const seen: number[] = [];

  const res = await copyVolumeBetween(
    from.conn,
    to.conn,
    "data",
    "data",
    (n) => {
      seen.push(n);
      // The caller writes its progress line from here. If that write can take the
      // copy down with it, the counter is worse than no counter at all.
      throw new Error("the progress line blew up");
    },
  );

  assert.equal(res.bytes, REAL.length * 2);
  assert.deepEqual(
    seen,
    [REAL.length, REAL.length],
    "one report per relayed chunk, sized, and only for the copy - not the probe",
  );
});

test("the probe reads a chunk and no more, then the copy re-reads the whole volume", async () => {
  const from = source({ data: [REAL, REAL] });
  const to = dest();

  await copyVolumeBetween(from.conn, to.conn, "data");

  // Twice on purpose: the probe cancels its stream after the first chunk, which is
  // what makes it cost one chunk rather than a second full transfer.
  assert.deepEqual(from.exports, ["data", "data"]);
  assert.equal(to.received.data.length, REAL.length * 2);
});

test("an agent too old to report a byte count is not treated as having written none", async () => {
  const from = source({ data: REAL });
  // What every agent below the version answers: zero and empty string.
  const to = dest(() => ({ ok: true, error: "", bytesWritten: 0, sha256: "" }));

  const res = await copyVolumeBetween(from.conn, to.conn, "data");

  assert.equal(res.bytes, REAL.length);
  assert.equal(res.empty, false);
});

test("a destination that writes fewer bytes than were sent is a failure", async () => {
  const from = source({ data: REAL });
  const to = dest((b) => ({
    ok: true,
    error: "",
    bytesWritten: b.length - 10,
  }));

  await assert.rejects(
    () => copyVolumeBetween(from.conn, to.conn, "data"),
    /truncated/,
  );
});

test("a destination whose digest disagrees is a failure", async () => {
  const from = source({ data: REAL });
  const to = dest(() => ({ ok: true, error: "", sha256: "0".repeat(64) }));

  await assert.rejects(
    () => copyVolumeBetween(from.conn, to.conn, "data"),
    /arrived corrupted/,
  );
});

test("a source that stops answering after the probe never reads as success", async () => {
  let first = true;
  const conn = {
    async *exportVolume() {
      // Full the first time (the probe), empty the second (the copy itself) - the
      // volume was removed underneath us between the two reads.
      if (first) {
        first = false;
        yield REAL;
        return;
      }
      yield EMPTY;
    },
  } as unknown as AgentConnection;
  const to = dest();

  await assert.rejects(
    () => copyVolumeBetween(conn, to.conn, "data"),
    /nothing was copied/,
  );
});

test("a destination that refuses is surfaced, not swallowed", async () => {
  const from = source({ data: REAL });
  const to = dest(() => ({ ok: false, error: "no space left on device" }));

  await assert.rejects(
    () => copyVolumeBetween(from.conn, to.conn, "data"),
    /no space left on device/,
  );
});

test("a volume that is not on that host is told apart from an empty one", async () => {
  const conn = {
    async *exportVolume(name: string) {
      if (name === "gone")
        throw Object.assign(new Error(`5 NOT_FOUND: no such volume: ${name}`), {
          code: 5,
        });
      yield EMPTY;
    },
  } as unknown as AgentConnection;
  const to = dest();

  const absent = await copyVolumeBetween(conn, to.conn, "gone", "target");
  // Nothing to copy either way, but only one of the two means "this workload
  // never ran here" - and the callers that tear the SOURCE down read that flag.
  assert.equal(absent.empty, true);
  assert.equal(absent.missing, true);

  const empty = await copyVolumeBetween(conn, to.conn, "there", "target");
  assert.equal(empty.empty, true);
  assert.equal(empty.missing, undefined);
  assert.deepEqual(to.calls, [], "neither one may wipe the destination");
});
