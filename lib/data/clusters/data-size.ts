import "server-only";

import { appDisk } from "../../apps/failover-copy";
import { connectAgent } from "../../infra/agent-client/connect";
import { VOLUME_USAGE_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { loadAppGraph } from "../app-graph-load";
import { appOwnVolumeNames } from "../project-backup-descriptor";

// ponytail: an App's size is measured at most once a minute per process; a copy that grows past it shows next time.
const sizes = new Map<string, { at: number; bytes: number; largest: number }>();

/** What an App's Volumes hold now, measured on the server it runs on; 0 when that server cannot say. */
export async function volumeBytes(
  serverId: string,
  volumes: string[],
): Promise<number> {
  return (await volumeSizes(serverId, volumes)).bytes;
}

/** volumeBytes, and the biggest file: a copy that rebuilds it holds the old and the new one at once (ADR-0043). */
export async function volumeSizes(
  serverId: string,
  volumes: string[],
): Promise<{ bytes: number; largest: number }> {
  const key = `${serverId}|${volumes.join(",")}`;
  const hit = sizes.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  let got = { bytes: 0, largest: 0 };
  const conn = await connectAgent(serverId);
  try {
    const hello = await conn.hello();
    if (hello.capabilities?.includes(VOLUME_USAGE_CAPABILITY))
      got = await conn.volumeSizes(volumes);
  } finally {
    conn.close();
  }
  sizes.set(key, { at: Date.now(), ...got });
  return got;
}

/** What a cluster App's data takes, for a placement or a failover (ADR-0043); 0 when it keeps none or nobody can say. */
export async function appDataBytes(appId: string): Promise<number> {
  const app = await loadAppGraph(appId);
  if (!app?.serverId || appDisk(app) !== "volume") return 0;
  const names = appOwnVolumeNames(app);
  if (names.length === 0) return 0;
  return volumeBytes(app.serverId, names).catch(() => 0);
}

/** Test seam: forget every measure. */
export const __forgetSizes = () => sizes.clear();
