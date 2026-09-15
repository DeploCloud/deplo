import "server-only";

import {
  Metadata,
  type ClientWritableStream,
  type ServiceError,
} from "@grpc/grpc-js";
import type {
  FilesChunk,
  HostPathChunk,
  ImageChunk,
  StackResult,
  StoreResult,
  VolumeChunk,
} from "../../agent/gen/agent";
import type { AgentConnection, DroppedEntries } from "./connection";
import { VOLUME_COPY_DEADLINE_MS, VOLUME_USAGE_TIMEOUT_MS } from "./deadlines";
import { toAgentError } from "./errors";
import { bytesFrom, type AgentChannel } from "./mtls-channel";
import { pumpClientStream } from "../stream-events";

function droppedFrom(resp: StackResult): DroppedEntries {
  return {
    links: Number(resp.droppedLinks ?? 0),
    special: Number(resp.droppedSpecial ?? 0),
    names: resp.droppedNames ?? [],
  };
}

export function dataCopyRpc(
  channel: AgentChannel,
): Pick<
  AgentConnection,
  | "exportVolume"
  | "volumeUsage"
  | "importVolume"
  | "exportHostPath"
  | "importHostPath"
  | "exportFiles"
  | "importFiles"
  | "exportImage"
  | "importImage"
> {
  const { client } = channel;
  const copyDeadline = () => ({
    deadline: new Date(Date.now() + VOLUME_COPY_DEADLINE_MS),
  });
  return {
    exportVolume(volumeName: string) {
      return (async function* () {
        yield* bytesFrom<VolumeChunk>(
          client.exportVolume({ volumeName }, copyDeadline()),
        );
      })();
    },
    volumeUsage(volumeNames: string[]) {
      return new Promise<Map<string, number>>((resolve, reject) => {
        client.volumeUsage(
          { volumeNames },
          new Metadata(),
          { deadline: new Date(Date.now() + VOLUME_USAGE_TIMEOUT_MS) },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve(
                  new Map(
                    resp.volumes.map((v) => [v.volumeName, Number(v.bytes)]),
                  ),
                ),
        );
      });
    },
    importVolume(
      volumeName: string,
      wipeFirst: boolean,
      chunks: AsyncIterable<Buffer>,
    ) {
      return new Promise<{
        ok: boolean;
        error: string;
        bytesWritten: number;
        sha256: string;
        dropped: DroppedEntries;
      }>((resolve, reject) => {
        const call: ClientWritableStream<VolumeChunk> = client.importVolume(
          new Metadata(),
          copyDeadline(),
          (err: ServiceError | null, resp: StackResult) =>
            err
              ? reject(toAgentError(err))
              : resolve({
                  ok: resp.ok,
                  error: resp.error,
                  bytesWritten: Number(resp.bytesWritten ?? 0),
                  sha256: resp.sha256 ?? "",
                  dropped: droppedFrom(resp),
                }),
        );
        pumpClientStream<VolumeChunk>(
          call,
          { header: { volumeName, wipeFirst } },
          chunks,
          (data) => ({ data }),
          (e) => reject(toAgentError(e)),
        );
      });
    },
    exportHostPath(path: string, allowFile = false) {
      return (async function* () {
        yield* bytesFrom<VolumeChunk>(
          client.exportHostPath({ path, allowFile }, copyDeadline()),
        );
      })();
    },
    importHostPath(
      path: string,
      wipeFirst: boolean,
      chunks: AsyncIterable<Buffer>,
      file = false,
    ) {
      return new Promise<{
        ok: boolean;
        error: string;
        bytesWritten: number;
        sha256: string;
        dropped: DroppedEntries;
      }>((resolve, reject) => {
        const call: ClientWritableStream<HostPathChunk> = client.importHostPath(
          new Metadata(),
          copyDeadline(),
          (err: ServiceError | null, resp: StackResult) =>
            err
              ? reject(toAgentError(err))
              : resolve({
                  ok: resp.ok,
                  error: resp.error,
                  bytesWritten: Number(resp.bytesWritten ?? 0),
                  sha256: resp.sha256 ?? "",
                  dropped: droppedFrom(resp),
                }),
        );
        pumpClientStream<HostPathChunk>(
          call,
          { header: { path, wipeFirst, file } },
          chunks,
          (data) => ({ data }),
          (e) => reject(toAgentError(e)),
        );
      });
    },
    exportFiles(slug: string) {
      return (async function* () {
        yield* bytesFrom<FilesChunk>(
          client.exportFiles({ slug }, copyDeadline()),
        );
      })();
    },
    importFiles(
      slug: string,
      wipeFirst: boolean,
      chunks: AsyncIterable<Buffer>,
    ) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        const call: ClientWritableStream<FilesChunk> = client.importFiles(
          new Metadata(),
          copyDeadline(),
          (err: ServiceError | null, resp: StackResult) =>
            err
              ? reject(toAgentError(err))
              : resolve({ ok: resp.ok, error: resp.error }),
        );
        pumpClientStream<FilesChunk>(
          call,
          { header: { slug, wipeFirst } },
          chunks,
          (data) => ({ data }),
          (e) => reject(toAgentError(e)),
        );
      });
    },
    exportImage(imageRef: string, removeAfter: boolean) {
      return (async function* () {
        yield* bytesFrom<ImageChunk>(
          client.exportImage({ imageRef, removeAfter }, copyDeadline()),
        );
      })();
    },
    importImage(imageRef: string, chunks: AsyncIterable<Buffer>) {
      return new Promise<{ ok: boolean; error: string; bytesWritten: number }>(
        (resolve, reject) => {
          const call: ClientWritableStream<ImageChunk> = client.importImage(
            new Metadata(),
            copyDeadline(),
            (err: ServiceError | null, resp: StoreResult) =>
              err
                ? reject(toAgentError(err))
                : resolve({
                    ok: resp.ok,
                    error: resp.error,
                    bytesWritten: Number(resp.bytesWritten ?? 0),
                  }),
          );
          pumpClientStream<ImageChunk>(
            call,
            { header: { imageRef } },
            chunks,
            (data) => ({ data }),
            (e) => reject(toAgentError(e)),
          );
        },
      );
    },
  };
}
