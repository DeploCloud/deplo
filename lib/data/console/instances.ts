import "server-only";

import { readAgent } from "../../infra/agent-client/connect";
import type { App } from "../../types/app";
import { primaryDomainApp } from "../domains/primary-domain";
import { byReplicaIndex, tagReplicas } from "./replicas";

export interface ConsoleInstance {
  name: string;
  service: string;
  image: string;
  running: boolean;
  exposed: boolean;
  user: string;
  workdir: string;
  openStdin: boolean;
  tty: boolean;
  state: string;
  health: string;
  restartCount: number;
  startedAtUnix: number;
  answer?: string;
  // `web-2` when this is one of several copies of its service, else null.
  replica?: string | null;
}

export function containerName(p: App, deployKey: string = p.slug): string {
  return `deplo-${deployKey}`;
}

export async function listInstances(p: App): Promise<ConsoleInstance[]> {
  const exposeService = await primaryDomainApp(p.id);
  const conn = await readAgent(p.serverId);
  try {
    return tagReplicas(
      orderInstances(p, await conn.listInstances(p.id, p.slug, exposeService)),
      p.slug,
    );
  } finally {
    conn.close();
  }
}

export function orderInstances(
  p: App,
  instances: ConsoleInstance[],
): ConsoleInstance[] {
  const own = (i: ConsoleInstance) => i.service === p.slug;
  return [...instances].sort((a, b) => {
    if (own(a) !== own(b)) return own(a) ? -1 : 1;
    if (a.exposed !== b.exposed) return a.exposed ? -1 : 1;
    if (a.running !== b.running) return a.running ? -1 : 1;
    return a.service.localeCompare(b.service) || byReplicaIndex(a, b);
  });
}

// A logs target of the picker that names one server's copy: `<container>@<server id>`.
export const ON_SERVER = "@";
