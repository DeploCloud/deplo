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
