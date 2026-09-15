import "server-only";

import { and, eq, sql } from "drizzle-orm";
import type { ServedIconTarget } from "../../apps/favicon-agent";
import {
  detectTreeFavicon,
  detectGithubFavicon,
  detectAppFilesFavicon,
  detectServedAppFavicon,
} from "../../apps/favicon-detect";
import { isGithubRepo } from "../../apps/favicon-shared";
import {
  supportsFrameworkDetection,
  type FrameworkId,
} from "../../apps/framework-catalog";
import {
  detectRepoFramework,
  detectTreeFramework,
} from "../../apps/framework-source";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { publishAppChanged } from "../../graphql/pubsub";
import { nowIso } from "../../ids";
import type { BuildMethod, GitRepo } from "../../types/build";

async function setLogoIfUnset(
  appId: string,
  logo: string | null,
): Promise<void> {
  if (!logo) return;
  const updated = await getDb()
    .update(appsTable)
    .set({ logo, logoTone: null, updatedAt: nowIso() })
    .where(and(eq(appsTable.id, appId), sql`${appsTable.logo} is null`))
    .returning({ id: appsTable.id });
  if (updated.length > 0) publishAppChanged(appId);
}

export async function autoDetectLogoFromTree(
  appId: string,
  currentLogo: string | null,
  root: string,
  rootDirectory: string | null | undefined,
): Promise<void> {
  if (currentLogo) return;
  try {
    await setLogoIfUnset(appId, await detectTreeFavicon(root, rootDirectory));
  } catch {}
}

export function autoDetectRepoLogo(
  appId: string,
  currentLogo: string | null,
  repo: Parameters<typeof detectGithubFavicon>[0],
  rootDirectory: string | null | undefined,
): void {
  if (currentLogo || !isGithubRepo(repo)) return;
  void detectGithubFavicon(repo, rootDirectory)
    .then((logo) => setLogoIfUnset(appId, logo))
    .catch(() => {});
}

export async function setFramework(
  appId: string,
  framework: FrameworkId | null,
): Promise<void> {
  const updated = await getDb()
    .update(appsTable)
    .set({ framework, updatedAt: nowIso() })
    .where(
      and(
        eq(appsTable.id, appId),
        framework === null
          ? sql`${appsTable.framework} is not null`
          : sql`${appsTable.framework} is distinct from ${framework}`,
      ),
    )
    .returning({ id: appsTable.id });
  if (updated.length > 0) publishAppChanged(appId);
}

export function canRecognizeFramework(app: {
  source: string;
  build: { buildMethod: BuildMethod };
}): boolean {
  if (!supportsFrameworkDetection(app.build.buildMethod)) return false;
  return app.source !== "docker-image" && app.source !== "compose";
}

export function autoDetectRepoFramework(
  appId: string,
  repo: GitRepo,
  rootDirectory: string | null | undefined,
): void {
  void detectRepoFramework(repo, rootDirectory)
    .then((hints) => setFramework(appId, hints.framework))
    .catch(() => {});
}

export async function autoDetectFrameworkFromTree(
  appId: string,
  root: string,
  rootDirectory: string | null | undefined,
): Promise<void> {
  try {
    await setFramework(appId, await detectTreeFramework(root, rootDirectory));
  } catch {}
}

const ICON_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

export function autoDetectComposeLogo(
  appId: string,
  currentLogo: string | null,
  serverId: string,
  slug: string,
  target: ServedIconTarget | null,
): void {
  if (currentLogo) return;
  void (async () => {
    const fromFiles = await detectAppFilesFavicon(serverId, slug).catch(
      () => null,
    );
    if (fromFiles) {
      await setLogoIfUnset(appId, fromFiles);
      return;
    }
    if (!target) return;
    for (let attempt = 0; ; attempt++) {
      const logo = await detectServedAppFavicon(serverId, target).catch(
        () => null,
      );
      if (logo) {
        await setLogoIfUnset(appId, logo);
        return;
      }
      if (attempt >= ICON_RETRY_DELAYS_MS.length) return;
      await new Promise((r) => setTimeout(r, ICON_RETRY_DELAYS_MS[attempt]));
    }
  })().catch(() => {});
}
