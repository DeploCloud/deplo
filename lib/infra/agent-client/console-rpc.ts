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

// consoleRpc - what the console and the log viewer speak: container state, live
// output, an interactive shell.
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

  // Adapt a LogChunk server-stream into the output-only AttachHandle the logs
  // session registry consumes, so lib/logs/session.ts works UNCHANGED for a
  // remote backing.
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
    // A stream FAILURE is not a clean end: the agent can refuse the container (no such
    // container / not this app's), or the host can drop mid-follow. A cancel we asked
    // for (close()) is filtered by the `closed` guard above.
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
      write() {
        /* logs are read-only */
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          stream.cancel();
        } catch {
          /* already gone */
        }
        client.close();
      },
    };
  }

  // Adapt a bidi attach stream into a full-duplex AttachHandle. The FIRST frame
  // (AttachOpen) is sent by the factory before the handle is returned.
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
        } catch {
          /* stream gone; ignore */
        }
      },
      resize(cols: number, rows: number) {
        if (closed) return;
        try {
          // A tty-only AttachInput frame; the agent applies it to the pty. On a
          // pipe-backed (non-tty) attach the agent ignores it - harmless.
          stream.write({ resize: { cols, rows } });
        } catch {
          /* stream gone; ignore */
        }
      },
      close() {
        if (closed) return;
        closed = true;
        try {
          stream.cancel();
        } catch {
          /* already gone */
        }
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
    // Absent from an older agent: protobuf leaves them at "" / 0, which the
    // runtime probe reads as "this agent cannot tell me" and falls back.
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
            // 0 is the proto default and the agent's "unset", so an omitted window produces the
            // exact request this sent before the fields existed.
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
      // The agent requires AttachOpen as the FIRST frame.
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
