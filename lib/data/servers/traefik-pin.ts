import "server-only";

import { TRAEFIK_IMAGE, withTraefikImage } from "../../deploy/traefik-stack";
import {
  applyTraefikConfig,
  fetchHostInfo,
  withTraefikStackLock,
} from "../../infra/agent-client/host-ops";
import { onAgentLink } from "../../infra/agent-link/registry";
import { recordActivity } from "../activity";
import { instanceFrozen } from "../deplo-move/freeze";
import { getServerById } from "./roster";

interface Pin {
  off: (() => void) | null;
  /** Checked since this process started: a relink does not ask again. */
  done: Set<string>;
  running: Map<string, Promise<void>>;
  reported: Set<string>;
}

const KEY = Symbol.for("deplo.traefik-pin");
const g = globalThis as unknown as { [KEY]?: Pin };
const pin: Pin = (g[KEY] ??= {
  off: null,
  done: new Set(),
  running: new Map(),
  reported: new Set(),
});

/** Moves each server's Traefik to TRAEFIK_IMAGE when it links. Start it before the door opens. */
export function startTraefikPin(): void {
  if (pin.off) return;
  pin.off = onAgentLink((e) => {
    if (e.type === "up") void bringTraefikToPin(e.serverId);
  });
}

export function bringTraefikToPin(serverId: string): Promise<void> {
  if (pin.done.has(serverId)) return Promise.resolve();
  const running = pin.running.get(serverId);
  if (running) return running;
  const run = reconcile(serverId)
    .catch((e) =>
      console.error(`[deplo] Traefik update on ${serverId} failed:`, e),
    )
    .finally(() => pin.running.delete(serverId));
  pin.running.set(serverId, run);
  return run;
}

async function reconcile(serverId: string): Promise<void> {
  if (await instanceFrozen()) return;
  const server = await getServerById(serverId);
  if (!server || server.importOnly) return;

  const res = await withTraefikStackLock(serverId, async () => {
    // Empty: Deplo did not install this server's Traefik, so it is not Deplo's to move.
    const yaml = (await fetchHostInfo(serverId)).traefikComposeYaml;
    const next = yaml ? withTraefikImage(yaml) : null;
    return next ? applyTraefikConfig(serverId, { composeYaml: next }) : null;
  });
  const version = TRAEFIK_IMAGE.slice(TRAEFIK_IMAGE.indexOf(":") + 1);
  if (res && !res.ok) {
    // Once per process: it is retried on every link, and the trail needs it once.
    if (!pin.reported.has(serverId)) {
      pin.reported.add(serverId);
      await recordActivity(
        "server",
        `Could not update Traefik on ${server.name} to ${version}: ${res.error || "it did not restart"}. Deplo retries when the server reconnects.`,
        "Deplo",
      );
    }
    return;
  }
  pin.done.add(serverId);
  if (res)
    await recordActivity(
      "server",
      `Updated Traefik on ${server.name} to ${version}`,
      "Deplo",
    );
}
