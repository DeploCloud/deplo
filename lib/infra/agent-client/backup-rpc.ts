import "server-only";

import {
  Metadata,
  type ClientWritableStream,
  type ServiceError,
} from "@grpc/grpc-js";
import type {
  BackupRequest,
  RestoreChunk,
  RestoreChunk_Header,
  RestoreEvent,
  RestoreRequest,
  S3Target,
  StoreChunk,
  StoreResult,
  StoreTarget,
} from "../../agent/gen/agent";
import { pumpClientStream, streamEvents } from "../stream-events";
import type { AgentConnection } from "./connection";
import {
  BACKUP_DEADLINE_MS,
  S3_OP_DEADLINE_MS,
  STREAM_BYTES_PAUSE_ABOVE,
} from "./deadlines";
import { toAgentError } from "./errors";
import { bytesFrom, type AgentChannel } from "./mtls-channel";

// backupRpc - dump/restore to S3 (ADR-0007) and to a store on a server's disk.
export function backupRpc(
  channel: AgentChannel,
): Pick<
  AgentConnection,
  | "backup"
  | "restore"
  | "s3Check"
  | "s3Delete"
  | "storeCheck"
  | "storeDelete"
  | "readStoreFile"
  | "writeStoreFile"
  | "restoreFrom"
> {
  const { client } = channel;
  const backupDeadline = () => ({
    deadline: new Date(Date.now() + BACKUP_DEADLINE_MS),
  });
  const s3Deadline = () => ({
    deadline: new Date(Date.now() + S3_OP_DEADLINE_MS),
  });
  return {
    backup(req: BackupRequest) {
      return streamEvents(
        client.backup(req, backupDeadline()),
        // BOUNDED, like every other stream that can carry bytes. Harmless for the ordinary
        // log-line shape, where the consumer drains in a tight loop and the bound is never
        // reached.
        { normalise: toAgentError, pauseAbove: STREAM_BYTES_PAUSE_ABOVE },
      );
    },
    restore(req: RestoreRequest) {
      return streamEvents(client.restore(req, backupDeadline()), {
        normalise: toAgentError,
      });
    },
    s3Check(s3: S3Target) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.s3Check({ s3 }, new Metadata(), s3Deadline(), (err, resp) =>
          err
            ? reject(toAgentError(err))
            : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    s3Delete(s3: S3Target, prefix = false) {
      return new Promise<{ ok: boolean; error: string; deleted: number }>(
        (resolve, reject) => {
          client.s3Delete(
            { s3, prefix },
            new Metadata(),
            s3Deadline(),
            (err, resp) =>
              err
                ? reject(toAgentError(err))
                : resolve({
                    ok: resp.ok,
                    error: resp.error,
                    deleted: resp.deleted,
                  }),
          );
        },
      );
    },
    storeCheck(store: StoreTarget) {
      return new Promise<{
        ok: boolean;
        error: string;
        freeBytes: number;
        totalBytes: number;
        root: string;
      }>((resolve, reject) => {
        client.s3Check({ store }, new Metadata(), s3Deadline(), (err, resp) =>
          err
            ? reject(toAgentError(err))
            : resolve({
                ok: resp.ok,
                error: resp.error,
                freeBytes: resp.freeBytes,
                totalBytes: resp.totalBytes,
                root: resp.root,
              }),
        );
      });
    },
    storeDelete(store: StoreTarget, prefix = false) {
      return new Promise<{ ok: boolean; error: string; deleted: number }>(
        (resolve, reject) => {
          client.s3Delete(
            { store, prefix },
            new Metadata(),
            s3Deadline(),
            (err, resp) =>
              err
                ? reject(toAgentError(err))
                : resolve({
                    ok: resp.ok,
                    error: resp.error,
                    deleted: resp.deleted,
                  }),
          );
        },
      );
    },
    readStoreFile(
      target: { store?: StoreTarget; s3?: S3Target },
      ageIdentity = "",
      expectedSha256 = "",
    ) {
      // An artifact is exactly the kind of stream an unbounded queue turns into an OOM.
      return (async function* () {
        yield* bytesFrom<StoreChunk>(
          client.readStoreFile(
            { ...target, ageIdentity, expectedSha256 },
            backupDeadline(),
          ),
        );
      })();
    },
    writeStoreFile(
      store: StoreTarget,
      overwrite: boolean,
      chunks: AsyncIterable<Buffer>,
    ) {
      // Header frame first, then data frames, honouring write backpressure so a slow
      // destination disk cannot make the relay buffer the whole artifact here.
      return new Promise<{
        ok: boolean;
        error: string;
        bytesWritten: number;
        sha256: string;
      }>((resolve, reject) => {
        const call: ClientWritableStream<StoreChunk> = client.writeStoreFile(
          new Metadata(),
          backupDeadline(),
          (err: ServiceError | null, resp: StoreResult) =>
            err
              ? reject(toAgentError(err))
              : resolve({
                  ok: resp.ok,
                  error: resp.error,
                  bytesWritten: resp.bytesWritten,
                  sha256: resp.sha256,
                }),
        );
        pumpClientStream<StoreChunk>(
          call,
          { header: { store, overwrite } },
          chunks,
          (data) => ({ data }),
          // Normalised like every other rejection here, so a transport drop
          // mid-relay surfaces as AgentUnreachableError rather than a raw
          // ServiceError the data layer would not recognise.
          (e) => reject(toAgentError(e)),
        );
      });
    },
    restoreFrom(header: RestoreChunk_Header, chunks: AsyncIterable<Buffer>) {
      // The only BIDI call in the client: bytes go up while progress comes down.
      const call = client.restoreFrom(backupDeadline());
      pumpClientStream<RestoreChunk>(
        call,
        { header },
        chunks,
        (data) => ({ data }),
        // A write-side failure surfaces on the read side too (the agent sees the
        // stream break and ends), so it needs no separate rejection path here.
        () => {},
      );
      return streamEvents<RestoreEvent>(call, { normalise: toAgentError });
    },
  };
}
