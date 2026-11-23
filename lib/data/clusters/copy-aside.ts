import "server-only";

import { connectAgent } from "../../infra/agent-client/connect";
import type {
  AgentConnection,
  SetAsideCopy,
} from "../../infra/agent-client/connection";
import {
  NEWEST_WINS_CAPABILITY,
  SET_ASIDE_FILES_CAPABILITY,
} from "../../infra/agent-client/hello-capabilities";
import { copyVolumeBetween } from "../volume-migration";

// A moved App's two copies: the one that ran last wins, and the other is set aside where the App runs, never written over.
// https://deplo.build/docs/operations/clusters/failover#set-aside-copies

/** When a server's copy of a stack last ran: `running` is now. */
export interface Ran {
  exists: boolean;
  lastRanMs: number;
  running: boolean;
}

/** Whether `there` ran after `here` did. A lease places a cluster App on one member, so one running now is the writer. */
export function ranLater(there: Ran, here: Ran): boolean {
  if (there.running) return true;
  if (here.running) return false;
  return there.lastRanMs > here.lastRanMs;
}

export async function readRan(
  agent: AgentConnection,
  slug: string,
): Promise<Ran> {
  const s = await agent.readStack(slug);
  return {
    exists: s.exists,
    lastRanMs: s.lastRanMs ?? 0,
    running: s.running ?? false,
  };
}

async function newestWins(agent: AgentConnection): Promise<boolean> {
  return !!(await agent.hello()).capabilities?.includes(NEWEST_WINS_CAPABILITY);
}

/** What an App's Files folder is set aside as on its servers, listed and removed like a volume's copy. */
export const filesAsideOf = (slug: string) => `deplo-${slug}.files`;

const stamp = (at: Date) =>
  at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

/** Sets these volumes aside on the server itself; none from an agent too old to (it keeps the old behaviour). */
export async function setAsideOn(
  serverId: string,
  slug: string,
  names: string[],
): Promise<SetAsideCopy[]> {
  const agent = await connectAgent(serverId);
  try {
    if (!(await newestWins(agent))) return [];
    return await agent.setAside(slug, names);
  } finally {
    agent.close();
  }
}

/**
 * Copies `from`'s volumes, and its Files folder of `slug`, into new set-aside copies on `to`, the server the App stays
 * on. Throws when it cannot.
 */
export async function setAsideOnto(
  from: string,
  to: string,
  names: string[],
  slug?: string,
): Promise<SetAsideCopy[]> {
  const source = await connectAgent(from);
  try {
    const dest = await connectAgent(to);
    try {
      if (!(await newestWins(dest)))
        throw new Error("its agent is too old to keep another server's copy");
      const at = new Date();
      const out: SetAsideCopy[] = [];
      for (const of of names) {
        const name = `${of}-aside-${stamp(at)}`;
        const res = await copyVolumeBetween(
          source,
          dest,
          of,
          name,
          undefined,
          undefined,
          of,
        );
        if (!res.empty)
          out.push({
            volumeName: name,
            of,
            atMs: at.getTime(),
            bytes: res.bytes,
          });
      }
      // The Files folder is set aside on `from` first, then copied like a volume, and the copy there goes.
      const caps = (await source.hello()).capabilities ?? [];
      if (slug && caps.includes(SET_ASIDE_FILES_CAPABILITY))
        for (const f of await source.setAside(slug, [])) {
          const res = await copyVolumeBetween(
            source,
            dest,
            f.volumeName,
            f.volumeName,
            undefined,
            undefined,
            f.of,
          );
          await source.removeSetAside(f.volumeName).catch(() => null);
          if (!res.empty) out.push({ ...f, bytes: res.bytes });
        }
      // What each copy takes on disk, as the App's page lists it; a stream's bytes are compressed.
      const usage = await dest
        .volumeUsage(out.map((c) => c.volumeName))
        .catch(() => null);
      return out.map((c) => ({
        ...c,
        bytes: usage?.get(c.volumeName) ?? c.bytes,
      }));
    } finally {
      dest.close();
    }
  } finally {
    source.close();
  }
}
