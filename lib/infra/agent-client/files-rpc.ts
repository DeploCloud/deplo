import "server-only";

import { Metadata } from "@grpc/grpc-js";
import type { FileEntry as PbFileEntry } from "../../agent/gen/agent";
import type {
  AgentConnection,
  AgentFileContent,
  AgentFileEntry,
} from "./connection";
import { FILES_TIMEOUT_MS } from "./deadlines";
import { toAgentError } from "./errors";
import type { AgentChannel } from "./mtls-channel";

export function filesRpc(
  channel: AgentChannel,
): Pick<
  AgentConnection,
  "listFiles" | "readFile" | "writeFile" | "filesExist" | "deleteFile"
> {
  const { client } = channel;
  const filesDeadline = () => ({
    deadline: new Date(Date.now() + FILES_TIMEOUT_MS),
  });
  const mapEntry = (e: PbFileEntry): AgentFileEntry => ({
    path: e.path,
    name: e.name,
    kind: e.kind,
    size: Number(e.size),
    modifiedAt: e.modifiedAt,
  });
  return {
    listFiles(slug: string, path: string) {
      return new Promise<AgentFileEntry[]>((resolve, reject) => {
        client.listFiles(
          { slug, path },
          new Metadata(),
          filesDeadline(),
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve(resp.entries.map(mapEntry)),
        );
      });
    },
    readFile(slug: string, path: string) {
      return new Promise<AgentFileContent>((resolve, reject) => {
        client.readFile(
          { slug, path },
          new Metadata(),
          filesDeadline(),
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({
                  path: resp.path,
                  text: resp.reason ? null : resp.text,
                  size: Number(resp.size),
                  reason: (resp.reason || null) as AgentFileContent["reason"],
                }),
        );
      });
    },
    writeFile(slug: string, path: string, content: string) {
      return new Promise<AgentFileEntry>((resolve, reject) => {
        client.writeFile(
          { slug, path, content },
          new Metadata(),
          filesDeadline(),
          (err, resp) =>
            err || !resp.entry
              ? reject(toAgentError(err ?? new Error("no entry")))
              : resolve(mapEntry(resp.entry)),
        );
      });
    },
    filesExist(slug: string) {
      return new Promise<boolean>((resolve, reject) => {
        client.filesExist(
          { slug },
          new Metadata(),
          filesDeadline(),
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve(resp.exists),
        );
      });
    },
    deleteFile(slug: string, path: string) {
      return new Promise<void>((resolve, reject) => {
        client.deleteFile(
          { slug, path },
          new Metadata(),
          filesDeadline(),
          (err) => (err ? reject(toAgentError(err)) : resolve()),
        );
      });
    },
  };
}
