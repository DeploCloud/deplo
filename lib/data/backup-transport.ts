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
import {
  BackupKind,
  type BackupRequest,
  type RestoreEvent,
  type RestoreRequest,
} from "../agent/gen/agent";
import type { DatabaseDescriptor, ProjectDescriptor } from "../agent/gen/agent";
import type { BackupDestination, BackupTargetKind } from "../types";
import { parseS3Args } from "../backups/s3-args";

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
  /**
   * The artifact's size with its age layer off — what a download delivers, so
   * what its Content-Length must be. Always the SOURCE agent's number, on every
   * shape including a relay: the destination only ever sees ciphertext, so it is
   * the one half of a relay that cannot answer this. 0 from an agent that
   * predates the field, and the run then records null.
   */
  decryptedSizeBytes: number;
  /**
   * Hex sha256 of the artifact as written. Recorded on the run and re-checked
   * before a restore ever acts on those bytes, because an artifact is not
   * trusted input: a bucket object can be replaced by anyone with write access,
   * and a store artifact can be forged by a compromised storage host (age proves
   * confidentiality, not authorship - the recipient is a public key that host is
   * handed on every backup). Empty when an older agent reported none.
   */
  sha256: string;
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
/** Whether this destination carries advanced S3 flags — the soft capability gate
 *  in `connectBackupAgent` warns when the host is too old to apply them. */
function hasS3Args(dest: BackupDestination): boolean {
  return dest.kind === "s3" && parseS3Args(dest.s3ExtraArgs).length > 0;
}

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
      // An encrypted BUCKET destination needs an agent that honours the
      // recipient. One that does not would ignore it and write the archive - the
      // app's whole decrypted env inside it - to the bucket in the clear, under a
      // key ending `.age`. Refusing is the only safe answer to that.
      encryptedS3: dest.kind === "s3" && !!dest.ageRecipient,
      s3Args: hasS3Args(dest),
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
        decryptedSizeBytes: Number(ev.result.decryptedSizeBytes ?? 0),
        sha256: ev.result.sha256 ?? "",
      };
    }
  }
  return (
    result ?? {
      ok: false,
      error: "the agent ended the backup without a result",
      objectKey,
      sizeBytes: 0,
      decryptedSizeBytes: 0,
      sha256: "",
    }
  );
}

/**
 * Why the two halves of a relay disagree, or "" when they don't.
 *
 * The digest is the real check and the byte count is the fallback: an agent from
 * before integrity checking reports no digest, and refusing its backups outright
 * would break a fleet mid-rollout for no gain, so a size match is still accepted
 * there. The message names which check ran, because "your backup is corrupt" and
 * "your backup is short" send an operator to different places.
 */
function digestMismatch(
  produced: BackupOutcome,
  landed: { bytesWritten: number; sha256: string },
): string {
  if (produced.sha256 && landed.sha256) {
    return produced.sha256.toLowerCase() === landed.sha256.toLowerCase()
      ? ""
      : `The backup arrived corrupted: what the source produced does not match ` +
          `what the destination server stored. Nothing was kept.`;
  }
  return landed.bytesWritten === produced.sizeBytes
    ? ""
    : `The backup arrived incomplete: ${produced.sizeBytes} bytes were sent ` +
        `but ${landed.bytesWritten} landed.`;
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
            decryptedSizeBytes: Number(ev.result.decryptedSizeBytes ?? 0),
            sha256: ev.result.sha256 ?? "",
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
          decryptedSizeBytes: 0,
          sha256: "",
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
        decryptedSizeBytes: 0,
        sha256: "",
      };
    }
    if (!produced.ok) return produced;
    if (!landed.ok) {
      return {
        ok: false,
        error: landed.error || "the destination server rejected the backup",
        objectKey,
        sizeBytes: 0,
        decryptedSizeBytes: 0,
        sha256: "",
      };
    }
    // Both halves must agree, and the CONTENT is what has to agree — not just how
    // much of it there was. Both agents hash what they handled precisely so this
    // comparison can be made; comparing byte counts alone was the check the
    // protocol was designed for and the one that never got written, and a count
    // survives every way an artifact can arrive wrong except the shortest one.
    const mismatch = digestMismatch(produced, landed);
    if (mismatch) {
      // Unlike every other failure above, THIS one has already committed a file:
      // the destination wrote what it received and renamed it onto the real key.
      // Remove it here, because nothing downstream will — retention only deletes
      // artifacts of SUCCESSFUL runs, and the sweep only sees `.partial` files.
      try {
        await sink.storeDelete(storeTargetFor(dest, objectKey));
      } catch (e) {
        console.warn(
          `[backups] corrupt artifact ${objectKey} could not be removed: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return {
        ok: false,
        error: mismatch,
        objectKey,
        sizeBytes: 0,
        decryptedSizeBytes: 0,
        sha256: "",
      };
    }
    return {
      ok: true,
      error: "",
      objectKey,
      sizeBytes: landed.bytesWritten,
      // The SOURCE's, unlike the two above: the destination was handed
      // ciphertext and never saw the artifact inside it, so it has no opinion on
      // how big that is.
      decryptedSizeBytes: produced.decryptedSizeBytes,
      // The DESTINATION's digest is the one recorded: it is what that disk
      // actually fsynced, and it is what a later restore reads back.
      sha256: landed.sha256 || produced.sha256,
    };
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
  /** The digest recorded when this artifact was written. The agent refuses an
   *  artifact that no longer hashes to it. Empty for a run taken before
   *  integrity checking shipped, which skips the check rather than making every
   *  existing restore point unusable. */
  expectedSha256 = "",
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
      // The identity travels on BOTH kinds now that a bucket artifact is
      // encrypted too. Empty on a destination created before that, whose objects
      // are plaintext — the agent then skips the age layer.
      ageIdentity: creds.ageIdentity,
      expectedSha256,
    };
    const conn = await connectBackupAgent(target.serverId, {
      store: dest.kind === "server",
      // Same gate on the way back: an agent that ignores the identity would feed
      // ciphertext to gunzip and report something about a corrupt archive.
      encryptedS3: dest.kind === "s3" && !!dest.ageRecipient,
      s3Args: hasS3Args(dest),
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
    const bytes = src.readStoreFile({ store: storeTargetFor(dest, objectKey) });
    return await consumeRestore(
      workload.restoreFrom(
        {
          kind: wireKind(target.kind),
          database: target.database,
          project: target.project,
          ageIdentity: creds.ageIdentity,
          expectedSha256,
          // FALSE, and deliberately: this artifact is one Deplo wrote, carried
          // between two hosts of its own fleet, with the digest to prove it. Its
          // configuration snapshot is the whole point of restoring from it.
          untrustedConfig: false,
        },
        bytes,
      ),
    );
  } finally {
    workload?.close();
    src.close();
  }
}

/**
 * Restore from an artifact that has no destination at all: the operator is
 * uploading it, and the bytes arrive from their browser.
 *
 * The FOURTH shape, and the only one whose source is outside the fleet. It is
 * the cross-host branch above with the source agent removed - same RPC, same
 * capability gate, same reason (staging the artifact on the host being restored
 * would need a full artifact's worth of free space on exactly the machine that
 * is already in trouble).
 *
 * `expectedSha256` is empty and CANNOT be otherwise: nobody recorded a digest
 * for these bytes, and hashing what we were just handed would prove nothing.
 * The agent knows what that means - for an app it keeps the control plane's own
 * stack configuration instead of the archive's, which is the right answer for an
 * artifact that arrived as untrusted input.
 *
 * Returns the LIVE event stream (the caller relays it to the browser) plus the
 * connection's `close` - the caller owns both, exactly like
 * {@link openArtifactDownload}.
 */
export async function openUploadRestore(
  target: TransportTarget,
  /** The identity the artifact is encrypted to: the operator's recovery key, or
   *  an ephemeral one when the control plane wrapped a plaintext upload. */
  ageIdentity: string,
  chunks: AsyncIterable<Buffer>,
): Promise<{
  events: AsyncGenerator<RestoreEvent, void, unknown>;
  close: () => void;
}> {
  const conn = await connectBackupAgent(target.serverId, {
    store: true,
    untrustedConfig: true,
  });
  return {
    events: conn.restoreFrom(
      {
        kind: wireKind(target.kind),
        database: target.database,
        project: target.project,
        ageIdentity,
        expectedSha256: "",
        // The bytes came from outside the fleet, so nothing in them configures
        // what comes back up: only the DATA is restored. Without this the agent
        // would fall back to the archive's compose/env whenever this side sent
        // none, which is the uploader choosing what `docker compose up` runs.
        untrustedConfig: true,
      },
      chunks,
    ),
    close: () => conn.close(),
  };
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
  const conn = await connectBackupAgent(serverId, {
    store: dest.kind === "server",
    s3Args: hasS3Args(dest),
  });
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
 * BOTH destination kinds, and that is the point. A bucket artifact used to be
 * refused here, on the reasoning that the operator could fetch the object with
 * their own S3 credentials and decrypt it themselves. That is a shell answer to
 * a panel question, and it made the Download button dead for anyone whose
 * backups live in a bucket - which is the default shape of a destination someone
 * brings from outside the fleet.
 *
 * The agent decrypts, not the control plane, because age is a STREAM — the agent
 * does it chunk by chunk at constant memory, while doing it here would mean
 * holding a multi-GB artifact to accomplish the same thing. It is NOT
 * decompressed: the file the user wants is the .tar.gz / .dump.gz itself.
 */
export async function openArtifactDownload(
  creds: DestinationWithSecrets,
  /** Which agent fetches it: the destination's own host for a store, and a host
   *  that can dial the bucket for S3 (see {@link destinationServerId}). */
  viaServerId: string,
  objectKey: string,
  /** The digest recorded for this artifact. A STORE artifact is hashed before a
   *  byte leaves, so a replaced file is refused outright; a BUCKET object can
   *  only be hashed as it goes past, so a mismatch ends the stream in an error
   *  after bytes have arrived. Both refuse; only one can refuse in time. */
  expectedSha256 = "",
): Promise<{ chunks: AsyncGenerator<Buffer, void, unknown>; close: () => void }> {
  const dest = creds.destination;
  const store = dest.kind === "server";
  // The agent decrypts on the way out (that is what `ageIdentity` asks for), so
  // what reaches the browser is the .tar.gz / .dump.gz itself. An old S3
  // destination has no keypair and its objects really are plaintext: the identity
  // is empty and the agent skips the age layer, exactly as a restore does.
  const conn = await connectBackupAgent(viaServerId, {
    store,
    s3Read: !store,
  });
  return {
    chunks: conn.readStoreFile(
      store
        ? { store: storeTargetFor(dest, objectKey) }
        : { s3: s3TargetFor(creds, objectKey) },
      creds.ageIdentity,
      expectedSha256,
    ),
    close: () => conn.close(),
  };
}
