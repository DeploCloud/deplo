import "server-only";

import {
  Metadata,
  type ClientDuplexStream,
  type ClientReadableStream,
} from "@grpc/grpc-js";
import type {
  AttachInput,
  AttachOutput,
  ConsoleInstance as PbConsoleInstance,
  LogChunk,
} from "../../agent/gen/agent";
import type { AttachHandle } from "../docker";
import type {
  AgentConnection,
  AgentConsoleInstance,
  AgentExecResult,
  FollowLogsOptions,
} from "./connection";
import { CONSOLE_TIMEOUT_MS, STREAM_DEADLINE_MS } from "./deadlines";
import { logsFailureReason, toAgentError } from "./errors";
import type { AgentChannel } from "./mtls-channel";

export function consoleRpc(
  channel: AgentChannel,
): Pick<
  AgentConnection,
  "inspect" | "followLogs" | "attach" | "listInstances" | "exec" | "shellLabel"
> {
  const { client } = channel;
  const consoleDeadline = () => ({
    deadline: new Date(Date.now() + CONSOLE_TIMEOUT_MS),
  });

  function logsHandle(stream: ClientReadableStream<LogChunk>): AttachHandle {
    const subs = new Set<(c: Buffer) => void>();
    let pending: Buffer[] | null = [];
    let exitCb: ((error?: string) => void) | null = null;
    let closed = false;
    const fanout = (buf: Buffer) => {
      if (subs.size === 0 && pending) {
        pending.push(buf);
        return;
      }
      for (const s of subs) s(buf);
    };
    stream.on("data", (c: LogChunk) => fanout(Buffer.from(c.data)));
    const end = (error?: string) => {
      if (closed) return;
      exitCb?.(error);
    };
    stream.on("end", () => end());
    stream.on("error", (e: Error) => end(logsFailureReason(e)));
    return {
      onData(cb) {
        subs.add(cb);
        if (pending) {
          const p = pending;
          pending = null;
          for (const c of p) cb(c);
        }
        return () => subs.delete(cb);
      },
      onExit(cb) {
        exitCb = cb;
      },
      write() {},
      close() {
        if (closed) return;
        closed = true;
        try {
          stream.cancel();
        } catch {}
        client.close();
      },
    };
  }

  function attachHandle(
    stream: ClientDuplexStream<AttachInput, AttachOutput>,
  ): AttachHandle {
    const subs = new Set<(c: Buffer) => void>();
    let pending: Buffer[] | null = [];
    let exitCb: (() => void) | null = null;
    let closed = false;
    stream.on("data", (o: AttachOutput) => {
      if (o.data && o.data.length) {
        const buf = Buffer.from(o.data);
        if (subs.size === 0 && pending) pending.push(buf);
        else for (const s of subs) s(buf);
      } else if (o.exit) {
        exitCb?.();
      }
    });
    const end = () => {
      if (closed) return;
      exitCb?.();
    };
    stream.on("end", end);
    stream.on("error", end);
    return {
      onData(cb) {
        subs.add(cb);
        if (pending) {
          const p = pending;
          pending = null;
          for (const c of p) cb(c);
        }
        return () => subs.delete(cb);
      },
      onExit(cb) {
        exitCb = cb;
      },
      write(data: string) {
        if (closed) return;
        try {
          stream.write({ data: Buffer.from(data, "utf8") });
        } catch {}
      },
      resize(cols: number, rows: number) {
        if (closed) return;
        try {
          stream.write({ resize: { cols, rows } });
        } catch {}
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          stream.cancel();
        } catch {}
        client.close();
      },
    };
  }

  const mapInstance = (i: PbConsoleInstance): AgentConsoleInstance => ({
    name: i.name,
    service: i.service,
    image: i.image,
    running: i.running,
    exposed: i.exposed,
    user: i.user,
    workdir: i.workdir,
    openStdin: i.openStdin,
    tty: i.tty,
    state: i.state,
    health: i.health,
    restartCount: i.restartCount,
    startedAtUnix: Number(i.startedAtUnix ?? 0),
  });

  return {
    inspect(slug: string) {
      return new Promise<{ exists: boolean; running: boolean; state: string }>(
        (resolve, reject) => {
          client.inspect(
            { slug },
            new Metadata(),
            consoleDeadline(),
            (err, resp) =>
              err
                ? reject(toAgentError(err))
                : resolve({
                    exists: resp.exists,
                    running: resp.running,
                    state: resp.state,
                  }),
          );
        },
      );
    },
    followLogs(
      appId: string,
      container: string,
      tail: number,
      opts: FollowLogsOptions = {},
    ) {
      return logsHandle(
        client.followLogs(
          {
            projectId: appId,
            container,
            tail,
            sinceUnix: opts.sinceUnix ?? 0,
            untilUnix: opts.untilUnix ?? 0,
            timestamps: opts.timestamps ?? false,
          },
          { deadline: new Date(Date.now() + STREAM_DEADLINE_MS) },
        ),
      );
    },
    attach(
      appId: string,
      container: string,
      tty: boolean,
      cols: number,
      rows: number,
    ) {
      const stream = client.attach({
        deadline: new Date(Date.now() + STREAM_DEADLINE_MS),
      });
      stream.write({ open: { projectId: appId, container, tty, cols, rows } });
      return attachHandle(stream);
    },
    listInstances(appId: string, slug: string, exposeService: string) {
      return new Promise<AgentConsoleInstance[]>((resolve, reject) => {
        client.listInstances(
          { projectId: appId, slug, exposeService },
          new Metadata(),
          consoleDeadline(),
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve(resp.instances.map(mapInstance)),
        );
      });
    },
    exec(appId: string, container: string, command: string, image: string) {
      return new Promise<AgentExecResult>((resolve, reject) => {
        client.exec(
          { projectId: appId, container, command, image },
          new Metadata(),
          consoleDeadline(),
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({
                  stdout: resp.stdout,
                  stderr: resp.stderr,
                  code: resp.code,
                  rawMode: resp.rawMode,
                }),
        );
      });
    },
    shellLabel(appId: string, container: string, image: string) {
      return new Promise<string>((resolve, reject) => {
        client.shellLabel(
          { projectId: appId, container, image },
          new Metadata(),
          consoleDeadline(),
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve(resp.label),
        );
      });
    },
  };
}
