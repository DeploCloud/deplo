import "server-only";

// Plugin runtime (ADR-0005), deferred (ADR-0013): only naming and the boot sweep's teardown are left - revive through the agent, not the socket.

import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
import { docker } from "../infra/docker";

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
const APPS_DIR = join(DATA_DIR, "apps");

// The plugin slug - the stable, per-team identity seeding the container name, compose project and stack file.
export function pluginSlug(catalogId: string, teamSlug: string): string {
  return `${catalogId}__${teamSlug}`;
}

// Deterministic, so a sweep is a lookup.
function pluginContainerName(slug: string): string {
  return `deplo-app-${slug}`;
}

function pluginStackFile(slug: string): string {
  return join(APPS_DIR, `${slug}.yml`);
}

// The path router lived in the compose labels, so removing the stack file leaves no orphaned Traefik router.
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
