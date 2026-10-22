import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { apps as appsTable } from "@/lib/db/schema/control-plane/apps";
import { githubInstallation as githubInstallationTable } from "@/lib/db/schema/control-plane/integrations";
import { decryptSecret } from "@/lib/crypto";
import { findAppByAppId } from "@/lib/github/app";
import { parsePushEvent } from "@/lib/deploy/git-webhook";
import { dispatchPushEvent } from "@/lib/deploy/git-webhook-dispatch";
import { handlePullRequestDelivery } from "@/lib/github/webhook-pull-request";
import { readTextCapped } from "@/lib/http/body-cap";

export async function POST(request: Request) {
  const raw = await readTextCapped(request);
  if (raw instanceof Response) return raw;

  const appId = Number(
    request.headers.get("x-github-hook-installation-target-id"),
  );
  const app = Number.isInteger(appId) ? await findAppByAppId(appId) : null;
  if (!app) {
    console.warn(
      `[github-webhook] ignored: no connected App for appId=${appId}`,
    );
    return new Response("ignored", { status: 202 });
  }

  const secret = decryptSecret(app.webhookSecretEnc);
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!secret || !verifySignature(raw, secret, signature)) {
    console.warn(
      `[github-webhook] 401 invalid signature for app=${app.slug}` +
        (secret
          ? ""
          : " (stored webhook secret is empty - DEPLO_SECRET changed?)"),
    );
    return new Response("invalid signature", { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  if (event === "pull_request") return handlePullRequestDelivery(raw, app.id);
  if (event !== "push") return new Response("ok", { status: 200 });

  let payload: PushPayload;
  try {
    payload = JSON.parse(raw) as PushPayload;
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  const fullName = payload.repository?.full_name;
  const numericInstall = payload.installation?.id;
  const pushEvent = parsePushEvent(payload);
  if (!fullName || !pushEvent.refName || !numericInstall) {
    console.warn(
      `[github-webhook] push ignored: ref=${payload.ref} repo=${fullName ?? "?"} install=${numericInstall ?? "?"}`,
    );
    return new Response("ok", { status: 200 });
  }

  // The installation MUST belong to the App whose secret verified this signature.
  const installRows = await getDb()
    .select()
    .from(githubInstallationTable)
    .where(
      and(
        eq(githubInstallationTable.installationId, numericInstall),
        eq(githubInstallationTable.appId, app.id),
      ),
    )
    .limit(1);
  const install = installRows[0];
  if (!install) {
    console.warn(
      `[github-webhook] no installation row for numeric id ${numericInstall} on app=${app.slug} (repo=${fullName})`,
    );
    return new Response("ok", { status: 200 });
  }

  await dispatchPushEvent({
    match: and(
      eq(appsTable.source, "github"),
      eq(appsTable.repoInstallationId, install.id),
    )!,
    repoFullName: fullName,
    event: pushEvent,
    creator: payload.pusher?.name || "github",
    provider: "github",
    commitMessage:
      payload.head_commit?.message || (pushEvent.isTag ? "Tag" : "Push"),
    logTag: "github-webhook",
  });

  return new Response("ok", { status: 200 });
}

function verifySignature(
  body: string,
  secret: string,
  header: string,
): boolean {
  if (!header.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface PushCommitFiles {
  added?: string[];
  modified?: string[];
  removed?: string[];
}

interface PushPayload {
  ref?: string;
  deleted?: boolean;
  repository?: { full_name?: string };
  installation?: { id?: number };
  pusher?: { name?: string };
  head_commit?: ({ message?: string } & PushCommitFiles) | null;
  commits?: PushCommitFiles[];
}
