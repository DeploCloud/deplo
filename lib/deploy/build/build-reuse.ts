import "server-only";

import { createHmac } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import type { DeployRequest, ReuseImage } from "../../agent/gen/agent";
import { SourceKind } from "../../agent/gen/agent";
import { deriveKey } from "../../crypto";
import { getDb } from "../../db/client";
import { deployments } from "../../db/schema/control-plane/deployments";

export const REUSE_IMAGE_CAPABILITY = "deploy.reuse-image";

// Everything a git build reads but the commit; keyed, since build variables can be secrets.
export function buildFingerprint(req: DeployRequest): string {
  const g = req.git;
  return createHmac("sha256", deriveKey("build-fingerprint"))
    .update(
      stableJson({
        buildKind: req.buildKind,
        dockerfile: req.dockerfile ?? null,
        buildSpec: req.buildSpec ?? null,
        git: g && {
          url: withoutCredentials(g.url),
          branch: g.branch,
          subdir: g.subdir,
          submodules: g.submodules,
        },
        env: req.env,
      }),
    )
    .digest("hex");
}

// Records what deployment depId builds and, when nothing asks for a fresh build, offers the newest live
// image of the same app built from the same input; the agent takes it only if the branch has not moved.
export async function offerBuiltImage(
  depId: string,
  serverId: string,
  req: DeployRequest,
  capabilities: string[],
): Promise<ReuseImage | undefined> {
  if (req.sourceKind !== SourceKind.SOURCE_KIND_GIT || req.buildOnly) return;
  const fingerprint = buildFingerprint(req);
  const db = getDb();
  await db
    .update(deployments)
    .set({ buildFingerprint: fingerprint })
    .where(eq(deployments.id, depId));
  if (
    req.forceRecreate ||
    req.noBuildCache ||
    req.pullBaseImages ||
    !capabilities.includes(REUSE_IMAGE_CAPABILITY)
  )
    return;
  const [hit] = await db
    .select({
      imageRef: deployments.imageRef,
      commitSha: deployments.commitSha,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.appId, req.projectId),
        eq(deployments.deployKey, req.slug),
        eq(deployments.serverId, serverId),
        eq(deployments.status, "ready"),
        eq(deployments.buildFingerprint, fingerprint),
        ne(deployments.id, depId),
      ),
    )
    .orderBy(desc(deployments.createdAt), desc(deployments.seq))
    .limit(1);
  if (!hit?.imageRef || !hit.commitSha) return;
  return { imageRef: hit.imageRef, commitSha: hit.commitSha };
}

function withoutCredentials(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return url;
  }
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}
