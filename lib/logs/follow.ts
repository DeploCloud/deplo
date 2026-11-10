import type { AttachHandle } from "../infra/docker";
import type {
  AgentConnection,
  FollowLogsOptions,
} from "../infra/agent-client/connection";
import { mergeReplicaLogs } from "./merge-replicas";

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
