import "server-only";

import {
  connectBackupAgent,
  mapBackupUnsupported,
  type AgentConnection,
} from "../infra/agent-client";
import {
  destinationServerId,
  s3TargetFor,
  storeTargetFor,
  type DestinationWithSecrets,
} from "./destinations";
import { BackupKind, type BackupRequest, type RestoreRequest } from "../agent/gen/agent";
import type { DatabaseDescriptor, ProjectDescriptor } from "../agent/gen/agent";
import type { BackupTargetKind } from "../types";

/**
 * HOW bytes get to and from a destination — the one place that knows there are
 * three shapes, so `executeBackup` and `restoreBackup` stay about WHAT is being
 * backed up rather than about topology.
 *
 * The three shapes, and why:
 *
 *  1. **S3.** One RPC on the workload's own host. The agent holds the S3 client,
 *     so the artifact goes straight from the dump to the bucket.
 *  2. **A store on the workload's own host.** Also one RPC. This is the common
 *     case — "keep a copy on this VPS" — and it must not pay for a network round
 *     trip it does not need.
 *  3. **A store on ANOTHER host.** Agents are a star: one can neither dial nor
 *     trust a peer, so the control plane relays, exactly as it already does for
 *     ExportVolume → ImportVolume on a server move. The source produces the
 *     artifact as data frames; the destination writes them.
 *
 * The relay never sees plaintext: encryption happens in the SOURCE agent's
 * pipeline, next to gzip, so what crosses this process is already ciphertext.
 * The identity that could read it is only ever sent on a restore or a download.
 */

/** What a backup needs to know about its target, independent of destination. */
export interface TransportTarget {
  serverId: string;
  kind: BackupTargetKind;
  database?: DatabaseDescriptor;
  project?: ProjectDescriptor;
}

export interface BackupOutcome {
  ok: boolean;
  error: string;
  objectKey: string;
  sizeBytes: number;
}

/**
 * Thrown out of the relay's byte generator to CANCEL the destination write
 * rather than end it cleanly. Never surfaces to a caller — {@link relayBackup}
 * catches it and reports the source's own failure instead.
 */
class RelayAborted extends Error {
  constructor() {
    super("the source ended the backup without a usable artifact");
    this.name = "RelayAborted";
  }
}

function wireKind(kind: BackupTargetKind): BackupKind {
  return kind === "database"
    ? BackupKind.BACKUP_KIND_DATABASE
    : BackupKind.BACKUP_KIND_PROJECT;
}

/**
 * Run a backup to wherever the destination says, and report what landed.
 *
 * `sizeBytes` is deliberately the DESTINATION's count on a relay, not the
 * source's: on a filesystem there is no ETag, so the only durable proof of the
 * transfer is what the receiving agent fsynced. The two are also cross-checked —
 * a mismatch fails the run rather than recording a backup that is not there.
 */
export async function backupToDestination(
  creds: DestinationWithSecrets,
  target: TransportTarget,
  objectKey: string,
): Promise<BackupOutcome> {
  const dest = creds.destination;
  const destServer = destinationServerId(dest, target.serverId);
  const req: BackupRequest = {
    kind: wireKind(target.kind),
    database: target.database,
    project: target.project,
    s3: dest.kind === "s3" ? s3TargetFor(creds, objectKey) : undefined,
    store: dest.kind === "server" ? storeTargetFor(dest, objectKey) : undefined,
    ageRecipient: dest.ageRecipient ?? "",
    streamOut: false,
  };

  // Shapes 1 and 2: the destination is reachable from the workload's own host.
  if (dest.kind === "s3" || destServer === target.serverId) {
    const conn = await connectBackupAgent(target.serverId, {
      store: dest.kind === "server",
    });
    try {
      return await consumeBackup(conn, req, objectKey);
    } finally {
      conn.close();
    }
  }

  // Shape 3: relay. Two connections, one pipe, backpressure end to end.
  return relayBackup(creds, target, objectKey, destServer, req);
}

/** Drain a Backup stream and fold its terminal result into a {@link BackupOutcome}. */
async function consumeBackup(
  conn: AgentConnection,
  req: BackupRequest,
  objectKey: string,
): Promise<BackupOutcome> {
  let result: BackupOutcome | null = null;
  for await (const ev of conn.backup(req)) {
    if (ev.result) {
      result = {
        ok: ev.result.ok,
        error: ev.result.error,
        objectKey: ev.result.objectKey || objectKey,
        sizeBytes: Number(ev.result.sizeBytes ?? 0),
      };
    }
  }
  return (
    result ?? {
      ok: false,
      error: "the agent ended the backup without a result",
      objectKey,
      sizeBytes: 0,
    }
  );
}

async function relayBackup(
  creds: DestinationWithSecrets,
  target: TransportTarget,
  objectKey: string,
  destServer: string,
  base: BackupRequest,
): Promise<BackupOutcome> {
  const dest = creds.destination;
  // `store: true` even though the SOURCE writes nothing: `stream_out` is part of
  // the same `backup-store` capability, and an agent that predates it passes a
  // `"backup"`-only preflight and then answers in-band ("backup request missing
  // S3 target") rather than UNIMPLEMENTED — so mapBackupUnsupported never fires
  // and the operator is told their bucket is misconfigured when what they
  // actually need is an agent update. Exactly the mid-rollout state this ships
  // into.
  const src = await connectBackupAgent(target.serverId, { store: true });
  let sink: AgentConnection | null = null;
  try {
    sink = await connectBackupAgent(destServer, { store: true });
    // A box rather than a bare `let`: the assignment happens inside the
    // generator's closure, which TypeScript cannot see, so a `let` would narrow
    // to `never` at every read below.
    const source: { result: BackupOutcome | null } = { result: null };

    // The generator yields ONLY data frames; the terminal result is captured on
    // the side. writeStoreFile consumes it to completion, so by the time it
    // resolves the source stream has ended and `source.result` is set.
    //
    // It THROWS on a bad terminal result rather than ending cleanly, and that is
    // the whole difference between a failed backup and a corrupt one. A mid-dump
    // failure arrives as BackupResult{ok:false} on a stream that then closes
    // NORMALLY; ending the generator there makes pumpClientStream call `end()`,
    // the destination sees io.EOF, and it fsyncs and renames the partial bytes
    // onto the real key. Nothing would ever remove that file: it is no longer a
    // `.partial` for the sweep to find, and retention skips failed runs on the
    // premise that they own no object. Throwing cancels the call instead, so the
    // destination's write dies with its temp file.
    const bytes = (async function* () {
      for await (const ev of src.backup({ ...base, streamOut: true, s3: undefined })) {
        if (ev.result) {
          source.result = {
            ok: ev.result.ok,
            error: ev.result.error,
            objectKey,
            sizeBytes: Number(ev.result.sizeBytes ?? 0),
          };
          if (!ev.result.ok) throw new RelayAborted();
          continue;
        }
        if (ev.data && ev.data.length) yield Buffer.from(ev.data);
      }
      if (!source.result) throw new RelayAborted();
    })();

    let landed: Awaited<ReturnType<AgentConnection["writeStoreFile"]>>;
    try {
      landed = await sink.writeStoreFile(storeTargetFor(dest, objectKey), false, bytes);
    } catch (e) {
      // Our own abort: report the SOURCE's reason, which is the one that
      // explains anything. Any other error is a genuine transport failure.
      if (!(e instanceof RelayAborted)) throw e;
      return (
        source.result ?? {
          ok: false,
          error: "the agent ended the backup without a result",
          objectKey,
          sizeBytes: 0,
        }
      );
    }

    const produced = source.result;
    if (!produced) {
      return {
        ok: false,
        error: "the agent ended the backup without a result",
        objectKey,
        sizeBytes: 0,
      };
    }
    if (!produced.ok) return produced;
    if (!landed.ok) {
      return {
        ok: false,
        error: landed.error || "the destination server rejected the backup",
        objectKey,
        sizeBytes: 0,
      };
    }
    // Both halves must agree. They can only differ if bytes were lost in the
    // relay, and a backup that is quietly short is worse than one that failed.
    //
    // Unlike every other failure above, THIS one has already committed a file:
    // the destination wrote what it received and renamed it onto the real key.
    // Remove it here, because nothing downstream will — retention only deletes
    // artifacts of SUCCESSFUL runs, and the sweep only sees `.partial` files.
    if (landed.bytesWritten !== produced.sizeBytes) {
      try {
        await sink.storeDelete(storeTargetFor(dest, objectKey));
      } catch (e) {
        console.warn(
          `[backups] short artifact ${objectKey} could not be removed: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return {
        ok: false,
        error:
          `The backup arrived incomplete: ${produced.sizeBytes} bytes were sent ` +
          `but ${landed.bytesWritten} landed.`,
        objectKey,
        sizeBytes: 0,
      };
    }
    return { ok: true, error: "", objectKey, sizeBytes: landed.bytesWritten };
  } finally {
    sink?.close();
    src.close();
  }
}

/**
 * Restore from wherever the artifact lives.
 *
 * Same three shapes. The cross-host one uses RestoreFrom (bidi) rather than
 * staging the artifact on the host being restored: staging would need a full
 * artifact's worth of free space on exactly the machine that is already in
 * trouble, plus cleanup that has to survive an agent restart.
 */
export async function restoreFromDestination(
  creds: DestinationWithSecrets,
  target: TransportTarget,
  objectKey: string,
): Promise<{ ok: boolean; error: string }> {
  const dest = creds.destination;
  const destServer = destinationServerId(dest, target.serverId);

  if (dest.kind === "s3" || destServer === target.serverId) {
    const req: RestoreRequest = {
      kind: wireKind(target.kind),
      database: target.database,
      project: target.project,
      s3: dest.kind === "s3" ? s3TargetFor(creds, objectKey) : undefined,
      store: dest.kind === "server" ? storeTargetFor(dest, objectKey) : undefined,
      ageIdentity: dest.kind === "server" ? creds.ageIdentity : "",
    };
    const conn = await connectBackupAgent(target.serverId, {
      store: dest.kind === "server",
    });
    try {
      return await consumeRestore(conn.restore(req));
    } finally {
      conn.close();
    }
  }

  const src = await connectBackupAgent(destServer, { store: true });
  let workload: AgentConnection | null = null;
  try {
    workload = await connectBackupAgent(target.serverId, { store: true });
    // Verbatim (no identity here): the ciphertext crosses this process and is
    // decrypted inside the workload's agent, which is the only place that needs
    // to see plaintext.
    const bytes = src.readStoreFile(storeTargetFor(dest, objectKey));
    return await consumeRestore(
      workload.restoreFrom(
        {
          kind: wireKind(target.kind),
          database: target.database,
          project: target.project,
          ageIdentity: creds.ageIdentity,
        },
        bytes,
      ),
    );
  } finally {
    workload?.close();
    src.close();
  }
}

async function consumeRestore(
  events: AsyncGenerator<{ result?: { ok: boolean; error: string } }, void, unknown>,
): Promise<{ ok: boolean; error: string }> {
  let result: { ok: boolean; error: string } | null = null;
  for await (const ev of events) {
    if (ev.result) result = { ok: ev.result.ok, error: ev.result.error };
  }
  return result ?? { ok: false, error: "the agent ended the restore without a result" };
}

/**
 * Delete an artifact (or a target's whole folder) from a destination.
 *
 * Routes to the DESTINATION's server for a store and to the workload's for S3 —
 * the distinction retention and delete-with-artifacts would otherwise get wrong,
 * silently: dialing the app's host for an artifact that lives on another one
 * returns "no such file", which either leaks the artifact or blocks the delete.
 */
export async function deleteFromDestination(
  creds: DestinationWithSecrets,
  targetServerId: string,
  key: string,
  prefix = false,
): Promise<{ ok: boolean; error: string; deleted: number }> {
  const [only] = await deleteManyFromDestination(creds, targetServerId, [
    { key, prefix },
  ]);
  return only!;
}

/**
 * Delete SEVERAL artifacts over ONE connection — what retention does.
 *
 * A prune can retire up to MAX_RUNS_PER_TARGET artifacts at once, and each dial
 * issues a fresh control-plane client certificate; opening fifty of them to
 * delete fifty files is pure overhead. Each key still gets its own result, so a
 * transient failure on one keeps that run's record for the next prune instead of
 * sinking the whole sweep.
 */
export async function deleteManyFromDestination(
  creds: DestinationWithSecrets,
  targetServerId: string,
  targets: { key: string; prefix?: boolean }[],
): Promise<{ ok: boolean; error: string; deleted: number }[]> {
  if (targets.length === 0) return [];
  const dest = creds.destination;
  const serverId = destinationServerId(dest, targetServerId);
  const conn = await connectBackupAgent(serverId, { store: dest.kind === "server" });
  try {
    const out: { ok: boolean; error: string; deleted: number }[] = [];
    for (const t of targets) {
      try {
        out.push(
          dest.kind === "server"
            ? await conn.storeDelete(storeTargetFor(dest, t.key), t.prefix ?? false)
            : await conn.s3Delete(s3TargetFor(creds, t.key), t.prefix ?? false),
        );
      } catch (e) {
        const mapped = mapBackupUnsupported(e);
        // An agent that cannot serve the verb at all will fail every key the same
        // way — surface it rather than logging it fifty times.
        if (mapped.name.startsWith("AgentBackup")) throw mapped;
        out.push({ ok: false, error: mapped.message, deleted: 0 });
      }
    }
    return out;
  } finally {
    conn.close();
  }
}

/**
 * Stream one artifact out DECRYPTED, for the download route.
 *
 * Store destinations only: an S3 artifact would mean pulling it out of the
 * bucket and back through here, doubling the transfer to serve a file the user
 * can already fetch from their own bucket.
 *
 * The agent decrypts, not the control plane, because age is a STREAM — the agent
 * does it chunk by chunk at constant memory, while doing it here would mean
 * holding a multi-GB artifact to accomplish the same thing. It is NOT
 * decompressed: the file the user wants is the .tar.gz / .dump.gz itself.
 */
export async function openArtifactDownload(
  creds: DestinationWithSecrets,
  objectKey: string,
): Promise<{ chunks: AsyncGenerator<Buffer, void, unknown>; close: () => void }> {
  const dest = creds.destination;
  if (dest.kind !== "server" || !dest.serverId)
    throw new Error("Only backups stored on a server can be downloaded");
  const conn = await connectBackupAgent(dest.serverId, { store: true });
  return {
    chunks: conn.readStoreFile(storeTargetFor(dest, objectKey), creds.ageIdentity),
    close: () => conn.close(),
  };
}
