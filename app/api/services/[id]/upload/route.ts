import { type NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { deployments as deploymentsTable } from "@/lib/db/schema/control-plane";
import { getServiceById, setServiceUpload } from "@/lib/data/services";
import { redeploy } from "@/lib/data/deployments";
import {
  storeUpload,
  pruneUploads,
  archiveExt,
  MAX_UPLOAD_BYTES,
  ARCHIVE_TOO_LARGE,
} from "@/lib/deploy/upload";

/**
 * Upload a code archive for an "upload"-source project, then deploy it.
 *
 *   POST  body = raw archive bytes, `X-Upload-Filename: <name>` header
 *         → streams the archive to disk, points the service at it, and kicks
 *           off a production deploy (extract → build method → run).
 *
 * A Route Handler rather than a Server Action because archives blow past the
 * Server Action body-size cap; the raw body streams straight to disk so memory
 * stays flat regardless of archive size. Node runtime: writes to the host FS.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Service ids with an upload streaming right now. The deployment-based 409
 * guard below can't catch a *concurrent upload* — the deployment isn't created
 * until after the (potentially minute-long) stream finishes, so two uploads
 * would both pass it and then race pruneUploads, leaving the service pointing
 * at a deleted archive. This sentinel serialises uploads per project. Sufficient
 * because the app runs as a single Node process (see next.config standalone);
 * a multi-process deploy would need to move this into the store.
 */
const uploadsInFlight = new Set<string>();

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/services/[id]/upload">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: serviceId } = await ctx.params;
  const project = await getServiceById(serviceId);
  if (!project) return Response.json({ error: "Service not found" }, { status: 404 });

  // Refuse to clobber an archive a build is still extracting: one deploy at a
  // time per project. The client surfaces this 409 message. Deployments are
  // relational now — query the in-flight statuses directly.
  const inFlightRows = await getDb()
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable)
    .where(
      and(
        eq(deploymentsTable.serviceId, serviceId),
        inArray(deploymentsTable.status, ["queued", "building"]),
      ),
    )
    .limit(1);
  if (inFlightRows.length > 0) {
    return Response.json(
      { error: "A deploy is already running — wait for it to finish" },
      { status: 409 },
    );
  }

  // Serialise concurrent uploads to the same project (the deploy guard above
  // can't see an upload that hasn't created its deployment yet).
  if (uploadsInFlight.has(serviceId)) {
    return Response.json(
      { error: "An upload is already in progress — wait for it to finish" },
      { status: 409 },
    );
  }
  uploadsInFlight.add(serviceId);
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
      upload = await storeUpload({ serviceId, filename, ext, body: request.body });
    } catch (err) {
      if (err instanceof Error && err.message === ARCHIVE_TOO_LARGE) {
        return Response.json({ error: "Archive too large" }, { status: 413 });
      }
      return Response.json({ error: "Upload failed" }, { status: 500 });
    }

    if (upload.size === 0) {
      await pruneUploads(serviceId, project.upload?.id ?? "").catch(() => {});
      return Response.json({ error: "Empty archive" }, { status: 400 });
    }

    // Commit the new pointer FIRST, then prune older upload dirs — the service
    // never points at a deleted archive, and a rejected upload above leaves the
    // previous one intact (its subdir was pruned only on success here).
    await setServiceUpload(serviceId, upload);
    await pruneUploads(serviceId, upload.id).catch(() => {});
    const deployment = await redeploy(serviceId);

    return Response.json({
      ok: true,
      upload: {
        filename: upload.filename,
        size: upload.size,
        uploadedAt: upload.uploadedAt,
      },
      deploymentId: deployment.id,
    });
  } finally {
    uploadsInFlight.delete(serviceId);
  }
}
