// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { type NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { deployments as deploymentsTable } from "@/lib/db/schema/control-plane";
import { getAppById, setAppUpload } from "@/lib/data/apps";
import { requireAppCapability } from "@/lib/data/node-access";
import {
  storeUpload,
  pruneUploads,
  archiveExt,
  MAX_UPLOAD_BYTES,
  ARCHIVE_TOO_LARGE,
} from "@/lib/deploy/upload";

/**
 * Upload a code archive for an "upload"-source project.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Belt-and-braces CSRF check: refuse a state-changing request whose `Origin`
 * points at another site.
 */
function isCrossSite(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    "";
  return originHost !== host;
}

/**
 * App ids with an upload streaming right now. Sufficient because the app runs as a
 * single Node process (see next.config standalone); a multi-process deploy would
 * need to move this into the store.
 */
const uploadsInFlight = new Set<string>();

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/apps/[id]/upload">,
) {
  if (isCrossSite(request))
    return Response.json(
      { error: "Cross-site request refused" },
      { status: 403 },
    );

  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: appId } = await ctx.params;
  const project = await getAppById(appId);
  if (!project)
    return Response.json({ error: "App not found" }, { status: 404 });

  // Gate BEFORE any bytes hit disk: setAppUpload re-checks `deploy` (plus the
  // folder gate), but only after a potentially 512 MiB stream has already been
  // written. A viewer-only member must be refused here, not after the write.
  try {
    await requireAppCapability(appId, "deploy_apps");
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "You don't have permission to deploy";
    return Response.json({ error: message }, { status: 403 });
  }

  // Refuse to clobber an archive a build is still extracting: one deploy at a
  // time per project. The client surfaces this 409 message. Deployments are
  // relational now - query the in-flight statuses directly.
  const inFlightRows = await getDb()
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable)
    .where(
      and(
        eq(deploymentsTable.appId, appId),
        inArray(deploymentsTable.status, ["queued", "building"]),
      ),
    )
    .limit(1);
  if (inFlightRows.length > 0) {
    return Response.json(
      { error: "A deploy is already running - wait for it to finish" },
      { status: 409 },
    );
  }

  // Serialise concurrent uploads to the same project (the deploy guard above
  // can't see an upload that hasn't created its deployment yet).
  if (uploadsInFlight.has(appId)) {
    return Response.json(
      { error: "An upload is already in progress - wait for it to finish" },
      { status: 409 },
    );
  }
  uploadsInFlight.add(appId);
  try {
    const filename =
      request.headers.get("x-upload-filename")?.trim() || "archive.tar.gz";
    const ext = archiveExt(filename);
    if (!ext) {
      return Response.json(
        { error: "Unsupported archive: use .tar.gz, .tgz, .tar or .zip" },
        { status: 415 },
      );
    }

    // Cheap fast-fail when the client declares an oversized length; the
    // streaming cap in storeUpload is the real guard (Content-Length can be
    // absent or lie).
    const declared = Number(request.headers.get("content-length") || "0");
    if (declared > MAX_UPLOAD_BYTES) {
      return Response.json({ error: "Archive too large" }, { status: 413 });
    }

    let upload;
    try {
      upload = await storeUpload({ appId, filename, ext, body: request.body });
    } catch (err) {
      if (err instanceof Error && err.message === ARCHIVE_TOO_LARGE) {
        return Response.json({ error: "Archive too large" }, { status: 413 });
      }
      return Response.json({ error: "Upload failed" }, { status: 500 });
    }

    if (upload.size === 0) {
      await pruneUploads(appId, project.upload?.id ?? "").catch(() => {});
      return Response.json({ error: "Empty archive" }, { status: 400 });
    }

    // Commit the new pointer FIRST, then prune older upload dirs - the app never points
    // at a deleted archive, and a rejected upload above leaves the previous one intact
    // (its subdir was pruned only on success here).
    try {
      await setAppUpload(appId, upload);
    } catch {
      await pruneUploads(appId, project.upload?.id ?? "").catch(() => {});
      return Response.json({ error: "Upload failed" }, { status: 500 });
    }
    await pruneUploads(appId, upload.id).catch(() => {});

    // No deploy here - the archive is stored and the app points at it. The caller
    // deploys on demand (Save & Deploy), which is what lets the server be chosen before
    // the first build runs.
    return Response.json({
      ok: true,
      upload: {
        filename: upload.filename,
        size: upload.size,
        uploadedAt: upload.uploadedAt,
      },
    });
  } finally {
    uploadsInFlight.delete(appId);
  }
}
