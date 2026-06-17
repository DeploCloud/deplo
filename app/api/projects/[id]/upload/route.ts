import { type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { read } from "@/lib/store";
import { getProjectById, setProjectUpload } from "@/lib/data/projects";
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
 *         → streams the archive to disk, points the project at it, and kicks
 *           off a production deploy (extract → build method → run).
 *
 * A Route Handler rather than a Server Action because archives blow past the
 * Server Action body-size cap; the raw body streams straight to disk so memory
 * stays flat regardless of archive size. Node runtime: writes to the host FS.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Project ids with an upload streaming right now. The deployment-based 409
 * guard below can't catch a *concurrent upload* — the deployment isn't created
 * until after the (potentially minute-long) stream finishes, so two uploads
 * would both pass it and then race pruneUploads, leaving the project pointing
 * at a deleted archive. This sentinel serialises uploads per project. Sufficient
 * because the app runs as a single Node process (see next.config standalone);
 * a multi-process deploy would need to move this into the store.
 */
const uploadsInFlight = new Set<string>();

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/upload">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId } = await ctx.params;
  const project = await getProjectById(projectId);
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 });

  // Refuse to clobber an archive a build is still extracting: one deploy at a
  // time per project. The client surfaces this 409 message.
  const inFlight = read().deployments.some(
    (d) =>
      d.projectId === projectId &&
      (d.status === "queued" || d.status === "building"),
  );
  if (inFlight) {
    return Response.json(
      { error: "A deploy is already running — wait for it to finish" },
      { status: 409 },
    );
  }

  // Serialise concurrent uploads to the same project (the deploy guard above
  // can't see an upload that hasn't created its deployment yet).
  if (uploadsInFlight.has(projectId)) {
    return Response.json(
      { error: "An upload is already in progress — wait for it to finish" },
      { status: 409 },
    );
  }
  uploadsInFlight.add(projectId);
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
      upload = await storeUpload({ projectId, filename, ext, body: request.body });
    } catch (err) {
      if (err instanceof Error && err.message === ARCHIVE_TOO_LARGE) {
        return Response.json({ error: "Archive too large" }, { status: 413 });
      }
      return Response.json({ error: "Upload failed" }, { status: 500 });
    }

    if (upload.size === 0) {
      await pruneUploads(projectId, project.upload?.id ?? "").catch(() => {});
      return Response.json({ error: "Empty archive" }, { status: 400 });
    }

    // Commit the new pointer FIRST, then prune older upload dirs — the project
    // never points at a deleted archive, and a rejected upload above leaves the
    // previous one intact (its subdir was pruned only on success here).
    await setProjectUpload(projectId, upload);
    await pruneUploads(projectId, upload.id).catch(() => {});
    const deployment = await redeploy(projectId);

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
    uploadsInFlight.delete(projectId);
  }
}
