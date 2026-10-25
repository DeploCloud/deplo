import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import type { SourceCompose } from "../../agent/gen/agent";
import { getDb } from "../../db/client";
import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import type { CertProvider } from "../../types/domain";
import { findComposeFile } from "../agent-deploy";

export function forkFullName(cloneUrl: string): string {
  try {
    return new URL(cloneUrl).pathname.replace(/^\/+/, "").replace(/\.git$/, "");
  } catch {
    return "";
  }
}

export async function loadPreviewForDeploy(previewId: string): Promise<{
  id: string;
  host: string;
  certProvider: CertProvider;
  prNumber: number;
  isFork: boolean;
  headCloneUrl: string;
  approvedSha: string | null;
  port: number | null;
} | null> {
  const rows = await getDb()
    .select({
      id: appPreviewsTable.id,
      host: appPreviewsTable.host,
      certProvider: appPreviewsTable.certProvider,
      prNumber: appPreviewsTable.prNumber,
      isFork: appPreviewsTable.isFork,
      headCloneUrl: appPreviewsTable.headCloneUrl,
      approvedSha: appPreviewsTable.approvedSha,
      port: appPreviewsTable.port,
    })
    .from(appPreviewsTable)
    .where(eq(appPreviewsTable.id, previewId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, certProvider: row.certProvider as CertProvider };
}

const MAX_SOURCE_COMPOSE_BYTES = 512 * 1024;

export async function readUploadCompose(
  buildDir: string,
  preferred?: string | null,
): Promise<SourceCompose> {
  const path = await findComposeFile(buildDir, preferred);
  if (!path)
    throw new Error(
      `No ${preferred?.trim() || "docker-compose.yml"} in the uploaded files.`,
    );
  const content = await readFile(join(buildDir, path), "utf8");
  if (Buffer.byteLength(content) > MAX_SOURCE_COMPOSE_BYTES)
    throw new Error(`${path} is larger than 512 KB.`);
  return { path, content };
}
