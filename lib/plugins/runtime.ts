import "server-only";

/**
 * What is left of the plugin runtime (ADR-0005): naming, and the teardown the boot
 * sweep uses to remove a container an older version installed. The feature is
 * deferred (ADR-0013) and everything that STARTED a plugin is gone - read ADR-0013
 * before reviving it, and bring it back through the agent, not the socket.
 */

import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
import { docker } from "../infra/docker";

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
const APPS_DIR = join(DATA_DIR, "apps");

/**
 * The plugin slug - the stable, per-team identity that seeds the container name,
 * the compose project and the stack file.
 */
export function pluginSlug(catalogId: string, teamSlug: string): string {
  return `${catalogId}__${teamSlug}`;
}

/** The container name for a plugin slug - deterministic, so a sweep is a lookup. */
function pluginContainerName(slug: string): string {
  return `deplo-app-${slug}`;
}

/** Absolute path of a plugin's rendered compose file. */
function pluginStackFile(slug: string): string {
  return join(APPS_DIR, `${slug}.yml`);
}

/**
 * Remove a plugin's container and its stack file, leaving no orphaned Traefik
 * router behind (the path router lived in the compose labels).
 */
export async function destroyPluginContainer(slug: string): Promise<void> {
  const stackFile = pluginStackFile(slug);
  if (await fileExists(stackFile)) {
    await docker(
      [
        "compose",
        "-p",
        pluginContainerName(slug),
        "-f",
        stackFile,
        "down",
        "--remove-orphans",
      ],
      { timeout: 120_000, noThrow: true },
    ).catch(() => {});
  } else {
    await docker(["rm", "-f", pluginContainerName(slug)], {
      timeout: 30_000,
      noThrow: true,
    }).catch(() => {});
  }
  await rm(stackFile, { force: true }).catch(() => {});
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
