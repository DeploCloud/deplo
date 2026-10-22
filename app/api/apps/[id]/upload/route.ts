import { type NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getDb } from "@/lib/db/client";
import { deployments as deploymentsTable } from "@/lib/db/schema/control-plane/deployments";
import { getAppById } from "@/lib/data/apps/listing";
import { setAppUpload } from "@/lib/data/apps/settings";
import { requireAppCapability } from "@/lib/data/node-access";
import {
  storeUpload,
  pruneUploads,
  archiveExt,
  MAX_UPLOAD_BYTES,
  ARCHIVE_TOO_LARGE,
} from "@/lib/deploy/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  try {
    // Gate BEFORE any bytes hit disk: setAppUpload re-checks deploy only once the whole stream is written.
    await requireAppCapability(appId, "deploy_apps");
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "You don't have permission to deploy";
    return Response.json({ error: message }, { status: 403 });
  }

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

    try {
      await setAppUpload(appId, upload);
    } catch {
      await pruneUploads(appId, project.upload?.id ?? "").catch(() => {});
      return Response.json({ error: "Upload failed" }, { status: 500 });
    }
    await pruneUploads(appId, upload.id).catch(() => {});

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
