import "server-only";

import { eq } from "drizzle-orm";
import { decryptSecretOrThrow } from "../../crypto";
import { loadEnvVarsForApp } from "../../data/app-graph-load";
import {
  loadAutoInjectedVarsForApp,
  loadSharedVarsForApp,
} from "../../data/shared-vars/deploy-entries";
import { getDb } from "../../db/client";
import { appPreviewEnvVars as appPreviewEnvVarsTable } from "../../db/schema/control-plane/env-vars";
import type { EnvTarget } from "../../types/env";
import {
  resolveEnvEntries,
  type EnvEntryType,
  type PreviewOverrideEntry,
} from "../env-resolve";

export interface PreviewEnvContext {
  host: string;
  url: string;
  branch: string;
  prNumber: number;
  isFork: boolean;
}

function previewEnvExtras(ctx: PreviewEnvContext): Record<string, string> {
  return {
    DEPLO_ENVIRONMENT: "preview",
    DEPLO_PREVIEW: "1",
    DEPLO_PREVIEW_HOST: ctx.host,
    DEPLO_PREVIEW_URL: ctx.url,
    DEPLO_GIT_BRANCH: ctx.branch,
    DEPLO_PR_NUMBER: String(ctx.prNumber),
  };
}

async function resolvedEntries(
  appId: string,
  target: EnvTarget,
  preview: PreviewEnvContext | null,
) {
  const [vars, sharedVars, autoInjected, previewOverrides] = await Promise.all([
    loadEnvVarsForApp(appId),
    loadSharedVarsForApp(appId),
    loadAutoInjectedVarsForApp(appId),
    target === "preview" ? loadPreviewEnvOverrides(appId) : Promise.resolve([]),
  ]);
  const dropSecrets = Boolean(preview?.isFork);
  const keep = <T extends { type: EnvEntryType }>(
    list: T[],
    inherited = true,
  ): T[] =>
    dropSecrets
      ? inherited
        ? []
        : list.filter((e) => e.type !== "secret")
      : list;
  return resolveEnvEntries(
    target,
    appId,
    keep(vars),
    keep(sharedVars),
    keep(autoInjected),
    keep(previewOverrides, false),
  );
}

export async function appEnv(
  appId: string,
  target: EnvTarget = "production",
  opts: { preview?: PreviewEnvContext | null } = {},
): Promise<Record<string, string>> {
  const preview = opts.preview ?? null;
  const entries = await resolvedEntries(appId, target, preview);
  const out: Record<string, string> = preview ? previewEnvExtras(preview) : {};
  for (const e of entries) {
    out[e.key] = decryptSecretOrThrow(e.valueEnc, `The variable ${e.key}`);
  }
  return out;
}

async function loadPreviewEnvOverrides(
  appId: string,
): Promise<PreviewOverrideEntry[]> {
  const rows = await getDb()
    .select({
      key: appPreviewEnvVarsTable.key,
      valueEnc: appPreviewEnvVarsTable.valueEnc,
      type: appPreviewEnvVarsTable.type,
    })
    .from(appPreviewEnvVarsTable)
    .where(eq(appPreviewEnvVarsTable.appId, appId))
    .orderBy(appPreviewEnvVarsTable.key);
  return rows.map((r) => ({
    key: r.key,
    valueEnc: r.valueEnc,
    type: r.type === "secret" ? ("secret" as const) : ("plain" as const),
  }));
}

export async function appEnvKeys(
  appId: string,
  target: EnvTarget = "production",
  opts: { preview?: PreviewEnvContext | null } = {},
): Promise<string[]> {
  const preview = opts.preview ?? null;
  const entries = await resolvedEntries(appId, target, preview);
  const seen = new Set<string>(
    preview ? Object.keys(previewEnvExtras(preview)) : [],
  );
  for (const e of entries) {
    seen.add(e.key);
  }
  return [...seen];
}
