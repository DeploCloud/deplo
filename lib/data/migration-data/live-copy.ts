import "server-only";

import { DeploTooOldError } from "../../migration/deplo/client";
import { errorMessage } from "../../utils";
import { BackupKind } from "../../agent/gen/agent";
import { mapBackupUnsupported } from "../../infra/agent-client/errors";
import { connectBackupAgent } from "../../infra/agent-client/preflight";
import {
  CopyAbortedError,
  isCopyAborted,
  type OnBytes,
} from "../volume-migration";
import { resolveTarget } from "../backups/target-descriptor";

import { startAndVerifyDatabase } from "./database-verify";
import type { Landed } from "./landed-targets";

export type DumpSource = (recipient: string) => AsyncIterable<Buffer>;

// The source dumps through its engine and encrypts to a key only this side holds, so a running database still arrives whole.
export async function restoreDumpInto(
  landed: Landed,
  teamId: string,
  dump: DumpSource,
  opts: { onBytes?: OnBytes; signal?: AbortSignal } = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const up = await startAndVerifyDatabase(landed, teamId, false);
  if (!up.ok)
    return {
      ok: false,
      message: `${landed.targetName} would not come up to take the copy: ${up.message}`,
    };

  const age = await import("age-encryption");
  const identity = await age.generateX25519Identity();
  const recipient = await age.identityToRecipient(identity);
  const target = await resolveTarget(teamId, "database", landed.targetId, null);

  let conn: Awaited<ReturnType<typeof connectBackupAgent>>;
  try {
    conn = await connectBackupAgent(target.serverId, { store: true });
  } catch (e) {
    return { ok: false, message: (mapBackupUnsupported(e) as Error).message };
  }
  const stop = () => conn.close();
  opts.signal?.addEventListener("abort", stop, { once: true });
  let dumpFailed: unknown = null;
  const counted = (async function* () {
    try {
      for await (const chunk of dump(recipient)) {
        opts.onBytes?.(chunk.length);
        yield chunk;
      }
    } catch (e) {
      dumpFailed = e;
      throw e;
    }
  })();
  const failed = (why: string) => ({
    ok: false as const,
    message: dumpFailed
      ? dumpRefusal(dumpFailed)
      : `the copy of ${landed.targetName} did not restore (${why})`,
  });
  try {
    let result: { ok: boolean; error: string } | null = null;
    for await (const ev of conn.restoreFrom(
      {
        kind: BackupKind.BACKUP_KIND_DATABASE,
        database: target.database,
        ageIdentity: identity,
        expectedSha256: "",
        untrustedConfig: false,
      },
      counted,
    ))
      if (ev.result) result = { ok: ev.result.ok, error: ev.result.error };
    if (result?.ok && !dumpFailed) return { ok: true };
    return failed(result?.error || "it ended without a result");
  } catch (e) {
    if (isCopyAborted(e)) throw e;
    if (opts.signal?.aborted) throw new CopyAbortedError();
    return failed(e instanceof Error ? e.message : "it failed");
  } finally {
    opts.signal?.removeEventListener("abort", stop);
    conn.close();
  }
}

function dumpRefusal(e: unknown): string {
  if (e instanceof DeploTooOldError)
    return `${e.message}. Update it, or run the copy again without that option.`;
  return `{panel} could not hand over a copy of it (${errorMessage(e, String(e))})`;
}
