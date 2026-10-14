import { test } from "node:test";
import assert from "node:assert/strict";

import type { BackupRequest, RestoreRequest } from "../../agent/gen/agent";
import { backupRpc } from "./backup-rpc";
import { BACKUP_DEADLINE_MS, RESTORE_DEADLINE_MS } from "./deadlines";
import type { AgentChannel } from "./mtls-channel";

const MINUTE = 60_000;

// The agent downloads and checks an artifact before applying it, so a restore gets the longer deadline.
test("restore calls get the restore deadline, backups keep theirs", () => {
  const seen: Record<string, number> = {};
  const call = (name: string) => (_req: unknown, opts: { deadline: Date }) => {
    seen[name] = opts.deadline.getTime() - Date.now();
    return { on() {}, cancel() {}, write() {}, end() {} };
  };
  const rpc = backupRpc({
    client: {
      backup: call("backup"),
      restore: call("restore"),
      restoreFrom: (opts: { deadline: Date }) =>
        call("restoreFrom")(null, opts),
    },
  } as unknown as AgentChannel);
  rpc.backup({} as BackupRequest);
  rpc.restore({} as RestoreRequest);
  rpc.restoreFrom({} as never, (async function* () {})());
  assert.ok(Math.abs(seen.backup - BACKUP_DEADLINE_MS) < MINUTE);
  assert.ok(Math.abs(seen.restore - RESTORE_DEADLINE_MS) < MINUTE);
  assert.ok(Math.abs(seen.restoreFrom - RESTORE_DEADLINE_MS) < MINUTE);
  assert.ok(RESTORE_DEADLINE_MS > BACKUP_DEADLINE_MS);
});
