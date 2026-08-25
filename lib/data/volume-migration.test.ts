import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { AgentConnection } from "../infra/agent-client";
import { copyVolumeBetween } from "./volume-migration";

/**
 * The byte relay, on its own.
 *
 * This is the one function in the repo that can destroy data while reporting
 * success, and for a long time it did: `docker run -v <name>:/v` CREATES a missing
 * volume, so exporting from the wrong host produced a valid EMPTY archive, and the
 * destination was wiped before the first frame arrived. Every Dokploy import and
 * every server move ran through here, and nothing counted a byte.
 *
 * So the invariants are pinned here rather than only at the callers: an empty
 * source is not a copy, a destination is not opened until the source has proven
 * itself, and a truncated or altered arrival is a failure.
 */

/** A gzipped tar of an empty directory - what a missing volume exports. */
const EMPTY = Buffer.alloc(45, 0);
const REAL = Buffer.alloc(200_000, 3);

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
