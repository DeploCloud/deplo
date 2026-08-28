import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  githubInstallation as githubInstallationTable,
  apps as appsTable,
} from "@/lib/db/schema/control-plane";
import { decryptSecret } from "@/lib/crypto";
import { findAppByAppId } from "@/lib/github/app";
import { parsePushEvent } from "@/lib/deploy/git-webhook";
import { dispatchPushEvent } from "@/lib/deploy/git-webhook-dispatch";
import { handlePullRequestDelivery } from "@/lib/github/webhook-pull-request";

/**
 * Inbound GitHub App webhook. Verifies the HMAC signature against the receiving
 * App's webhook secret, then triggers an auto-redeploy of any project wired to the
 * pushed repo + branch.
 */
export async function POST(request: Request) {
  const raw = await request.text();

  const appId = Number(
    request.headers.get("x-github-hook-installation-target-id"),
  );
  const app = Number.isInteger(appId) ? await findAppByAppId(appId) : null;
  if (!app) {
    // No connected App matches this delivery's target id. Logged because an
    // operator staring at "auto-deploy never fires" has no other way to learn
    // the delivery was acknowledged-and-dropped here rather than at the filter.
    console.warn(
      `[github-webhook] ignored: no connected App for appId=${appId}`,
    );
    return new Response("ignored", { status: 202 });
  }

  const secret = decryptSecret(app.webhookSecretEnc);
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!secret || !verifySignature(raw, secret, signature)) {
    // The realistic cause is DEPLO_SECRET rotating after the App was created,
    // so the stored webhook secret can no longer be decrypted (empty) - every
    // delivery then 401s. Name it so it isn't mistaken for a GitHub problem.
    console.warn(
      `[github-webhook] 401 invalid signature for app=${app.slug}` +
        (secret
          ? ""
          : " (stored webhook secret is empty - DEPLO_SECRET changed?)"),
    );
    return new Response("invalid signature", { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  // Pull request deliveries drive preview deployments; the push arm below is
  // untouched. `app.id` rides along for the same reason it is used below: the
  // delivery may only act on installations of the App whose secret just verified it.
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
  // Normalise the ref/commit metadata once; per-app gating (push vs tag,
  // watch paths) happens below against each candidate's stored config.
  const pushEvent = parsePushEvent(payload);
  if (!fullName || !pushEvent.refName || !numericInstall) {
    // A ref with no name (or a delivery missing repo/installation) has nothing to
    // match. Worth a line so it's not confused with a missing-config drop.
    console.warn(
      `[github-webhook] push ignored: ref=${payload.ref} repo=${fullName ?? "?"} install=${numericInstall ?? "?"}`,
    );
    return new Response("ok", { status: 200 });
  }

  // The installation MUST belong to the App the signature was verified against.
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

  // Apps are relational (cut-set c): the github-source candidates for this
  // installation, matched in SQL on the flattened repo_* columns.
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
