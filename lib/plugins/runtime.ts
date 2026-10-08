import "server-only";

import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
import { docker } from "../infra/docker";
import { dataDir } from "../data-dir";

export function pluginSlug(catalogId: string, teamSlug: string): string {
  return `${catalogId}__${teamSlug}`;
}

function pluginContainerName(slug: string): string {
  return `deplo-app-${slug}`;
}

function pluginStackFile(slug: string): string {
  return join(dataDir(), "apps", `${slug}.yml`);
}

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
