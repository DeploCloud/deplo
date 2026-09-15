import "server-only";

import type { AgentConnection } from "../infra/agent-client/connection";
import { mapBackupUnsupported } from "../infra/agent-client/errors";
import { connectBackupAgent } from "../infra/agent-client/preflight";
import {
  destinationServerId,
  s3TargetFor,
  storeTargetFor,
  type DestinationWithSecrets,
} from "./destinations/credentials";
import {
  BackupKind,
  type BackupRequest,
  type RestoreEvent,
  type RestoreRequest,
} from "../agent/gen/agent";
import type { DatabaseDescriptor, ProjectDescriptor } from "../agent/gen/agent";
import type { BackupDestination, BackupTargetKind } from "../types/backup";
import { parseS3Args } from "../backups/s3-args";

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
  decryptedSizeBytes: number;
  sha256: string;
}

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

function hasS3Args(dest: BackupDestination): boolean {
  return dest.kind === "s3" && parseS3Args(dest.s3ExtraArgs).length > 0;
}

export async function backupToDestination(
  creds: DestinationWithSecrets,
  target: TransportTarget,
  objectKey: string,
  signal?: AbortSignal,
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

  if (dest.kind === "s3" || destServer === target.serverId) {
    const conn = await connectBackupAgent(target.serverId, {
      store: dest.kind === "server",
      // An agent ignoring the recipient would write the app's decrypted env to the bucket in the clear.
      encryptedS3: dest.kind === "s3" && !!dest.ageRecipient,
      s3Args: hasS3Args(dest),
    });
    const release = abortWith(signal, conn);
    try {
      return await consumeBackup(conn, req, objectKey);
    } finally {
      release();
      conn.close();
    }
  }

  return relayBackup(creds, target, objectKey, destServer, req, signal);
}

function abortWith(
  signal: AbortSignal | undefined,
  ...conns: { close: () => void }[]
): () => void {
  if (!signal) return () => {};
  const stop = () => {
    for (const c of conns) c.close();
  };
  if (signal.aborted) {
    stop();
    return () => {};
  }
  signal.addEventListener("abort", stop, { once: true });
  return () => signal.removeEventListener("abort", stop);
}

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
  signal?: AbortSignal,
): Promise<BackupOutcome> {
  const dest = creds.destination;
  // store: true though the SOURCE writes nothing: stream_out rides the same backup-store capability.
  const src = await connectBackupAgent(target.serverId, { store: true });
  let sink: AgentConnection | null = null;
  let release = abortWith(signal, src);
  try {
    sink = await connectBackupAgent(destServer, { store: true });
    release();
    release = abortWith(signal, src, sink);
    const source: { result: BackupOutcome | null } = { result: null };

    const bytes = (async function* () {
      for await (const ev of src.backup({
        ...base,
        streamOut: true,
        s3: undefined,
      })) {
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
      landed = await sink.writeStoreFile(
        storeTargetFor(dest, objectKey),
        false,
        bytes,
      );
    } catch (e) {
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
    const mismatch = digestMismatch(produced, landed);
    if (mismatch) {
      try {
        // Unlike every other failure here, this one already committed a file on the destination.
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
      decryptedSizeBytes: produced.decryptedSizeBytes,
      sha256: landed.sha256 || produced.sha256,
    };
  } finally {
    release();
    sink?.close();
    src.close();
  }
}

export async function restoreFromDestination(
  creds: DestinationWithSecrets,
  target: TransportTarget,
  objectKey: string,
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
      store:
        dest.kind === "server" ? storeTargetFor(dest, objectKey) : undefined,
      ageIdentity: creds.ageIdentity,
      expectedSha256,
    };
    const conn = await connectBackupAgent(target.serverId, {
      store: dest.kind === "server",
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
    const bytes = src.readStoreFile({ store: storeTargetFor(dest, objectKey) });
    return await consumeRestore(
      workload.restoreFrom(
        {
          kind: wireKind(target.kind),
          database: target.database,
          project: target.project,
          ageIdentity: creds.ageIdentity,
          expectedSha256,
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

export async function openUploadRestore(
  target: TransportTarget,
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
        untrustedConfig: true,
      },
      chunks,
    ),
    close: () => conn.close(),
  };
}

async function consumeRestore(
  events: AsyncGenerator<
    { result?: { ok: boolean; error: string } },
    void,
    unknown
  >,
): Promise<{ ok: boolean; error: string }> {
  let result: { ok: boolean; error: string } | null = null;
  for await (const ev of events) {
    if (ev.result) result = { ok: ev.result.ok, error: ev.result.error };
  }
  return (
    result ?? {
      ok: false,
      error: "the agent ended the restore without a result",
    }
  );
}

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
            ? await conn.storeDelete(
                storeTargetFor(dest, t.key),
                t.prefix ?? false,
              )
            : await conn.s3Delete(s3TargetFor(creds, t.key), t.prefix ?? false),
        );
      } catch (e) {
        const mapped = mapBackupUnsupported(e);
        if (mapped.name.startsWith("AgentBackup")) throw mapped;
        out.push({ ok: false, error: mapped.message, deleted: 0 });
      }
    }
    return out;
  } finally {
    conn.close();
  }
}

export async function openArtifactDownload(
  creds: DestinationWithSecrets,
  viaServerId: string,
  objectKey: string,
  expectedSha256 = "",
): Promise<{
  chunks: AsyncGenerator<Buffer, void, unknown>;
  close: () => void;
}> {
  const dest = creds.destination;
  const store = dest.kind === "server";
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
