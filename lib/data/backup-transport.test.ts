import { test, after } from "node:test";
import assert from "node:assert/strict";

import type { AgentConnection } from "../infra/agent-client/connection";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import {
  BACKUP_CAPABILITY,
  BACKUP_STORE_CAPABILITY,
} from "../infra/agent-client/hello-capabilities";
import type { BackupDestination } from "../types/backup";
import { backupToDestination } from "./backup-transport";

after(() => __setAgentConnectorForTest());

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
