import type { AttachHandle } from "../attach/types";
import type {
  AgentConnection,
  FollowLogsOptions,
} from "../infra/agent-client/connection";
import { connectAgent } from "../infra/agent-client/connect";
import { AgentUnreachableError } from "../infra/agent-client/errors";
import { mergeReplicaLogs, type ReplicaSource } from "./merge-replicas";

// What the logs stream is named in the viewer: the replica group, or the one container.
export function logsStreamName(
  group: { name: string; service: string; replica?: string | null }[],
): string {
  return group.length > 1 ? group[0]!.service : group[0]!.name;
}

// One container's logs, or every replica's merged into one stream and tagged `web-1`, `web-2`.
export function followGroup(
  conn: AgentConnection,
  appId: string,
  group: { name: string; replica?: string | null }[],
  tail: number,
  opts?: FollowLogsOptions,
): AttachHandle {
  if (group.length === 1)
    return conn.followLogs(appId, group[0]!.name, tail, opts);
  const sources = [];
  try {
    for (const c of group)
      sources.push({
        tag: c.replica ?? c.name,
        handle: conn.followLogs(appId, c.name, tail, {
          ...opts,
          timestamps: true,
        }),
      });
  } catch (e) {
    for (const s of sources) s.handle.close();
    throw e;
  }
  return mergeReplicaLogs(sources, { timestamps: opts?.timestamps ?? false });
}

type LogContainer = { name: string; replica?: string | null };

// What `resolveLogsTarget` found: one server's copies, or each member's when a cluster App is read on several.
export interface LogsPlace {
  server: { id: string };
  group: LogContainer[];
  members?: { server: { id: string; name: string }; group: LogContainer[] }[];
  unavailable?: string[];
}

export function logsUnavailableLine(server: string): string {
  return `Earlier logs on ${server} are unavailable: Deplo cannot reach that server right now.`;
}

// The stream of an App's logs and what to close with it. On several members the lines are tagged
// `web-2 · server-b`, and a member that cannot be read gets one line instead of ending the stream.
export async function openLogs(
  appId: string,
  place: LogsPlace,
  tail: number,
  opts?: FollowLogsOptions,
): Promise<{ handle: AttachHandle; close: () => void }> {
  if (!place.members) {
    const conn = await connectAgent(place.server.id);
    return {
      handle: followGroup(conn, appId, place.group, tail, opts),
      close: () => conn.close(),
    };
  }
  const conns: AgentConnection[] = [];
  const close = () => conns.forEach((c) => c.close());
  const sources: ReplicaSource[] = [];
  const gone = [...(place.unavailable ?? [])];
  try {
    for (const m of place.members) {
      let conn: AgentConnection;
      try {
        conn = await connectAgent(m.server.id);
      } catch {
        gone.push(m.server.name);
        continue;
      }
      conns.push(conn);
      for (const c of m.group)
        sources.push({
          tag: [c.replica, m.server.name].filter(Boolean).join(" · "),
          handle: conn.followLogs(appId, c.name, tail, {
            ...opts,
            timestamps: true,
          }),
        });
    }
    if (sources.length === 0)
      throw new AgentUnreachableError("No server of this app can be reached.");
  } catch (e) {
    for (const s of sources) s.handle.close();
    close();
    throw e;
  }
  return {
    handle: mergeReplicaLogs(sources, {
      timestamps: opts?.timestamps ?? false,
      notices: gone.map(logsUnavailableLine),
    }),
    close,
  };
}
