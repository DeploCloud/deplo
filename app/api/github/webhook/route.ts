import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  githubInstallation as githubInstallationTable,
  services as servicesTable,
  serviceBuild as serviceBuildTable,
} from "@/lib/db/schema/control-plane";
import { decryptSecret } from "@/lib/crypto";
import { findAppByAppId } from "@/lib/github/app";
import { startDeployment } from "@/lib/deploy/build";
import { parseWatchPaths } from "@/lib/data/service-graph-rows";
import { parsePushEvent, shouldAutoDeploy } from "@/lib/deploy/git-webhook";

/**
 * Inbound GitHub App webhook. Verifies the HMAC signature against the receiving
 * App's webhook secret, then triggers an auto-redeploy of any project wired to
 * the pushed repo + branch. Best-effort: unmatched or unverifiable deliveries
 * are acknowledged without action.
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
    console.warn(`[github-webhook] ignored: no connected App for appId=${appId}`);
    return new Response("ignored", { status: 202 });
  }

  const secret = decryptSecret(app.webhookSecretEnc);
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!secret || !verifySignature(raw, secret, signature)) {
    // The realistic cause is DEPLO_SECRET rotating after the App was created,
    // so the stored webhook secret can no longer be decrypted (empty) — every
    // delivery then 401s. Name it so it isn't mistaken for a GitHub problem.
    console.warn(
      `[github-webhook] 401 invalid signature for app=${app.slug}` +
        (secret ? "" : " (stored webhook secret is empty — DEPLO_SECRET changed?)"),
    );
    return new Response("invalid signature", { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  if (event !== "push") return new Response("ok", { status: 200 });

  let payload: PushPayload;
  try {
    payload = JSON.parse(raw) as PushPayload;
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  const fullName = payload.repository?.full_name;
  const numericInstall = payload.installation?.id;
  // Normalise the ref/commit metadata once; per-service gating (push vs tag,
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

  const installRows = await getDb()
    .select()
    .from(githubInstallationTable)
    .where(eq(githubInstallationTable.installationId, numericInstall))
    .limit(1);
  const install = installRows[0];
  if (!install) {
    console.warn(
      `[github-webhook] no installation row for numeric id ${numericInstall} (repo=${fullName})`,
    );
    return new Response("ok", { status: 200 });
  }

  // Services are relational (cut-set c): the github-source candidates for this
  // installation, filtered in SQL on the flattened repo_* columns.
  const githubServices = await getDb()
    .select()
    .from(servicesTable)
    .where(
      and(
        eq(servicesTable.source, "github"),
        eq(servicesTable.repoInstallationId, install.id),
      ),
    );
  // First cut on the row-local facts (auto-deploy + repo match). The root-dir
  // "skip unchanged" filter needs each candidate's build row (root_directory +
  // skip_unchanged_deployments live on service_build, not the flattened services
  // row), so load those in one query keyed by service id before the final filter.
  const candidates = githubServices.filter(
    (p) => p.autoDeploy && p.repoRepo === fullName,
  );
  const buildRows = candidates.length
    ? await getDb()
        .select()
        .from(serviceBuildTable)
        .where(
          inArray(
            serviceBuildTable.serviceId,
            candidates.map((p) => p.id),
          ),
        )
    : [];
  const buildById = new Map(buildRows.map((b) => [b.serviceId, b]));
  const targets = candidates.filter((p) =>
    shouldAutoDeploy(
      {
        branch: p.repoBranch || "main",
        triggerType: p.repoTriggerType === "tag" ? "tag" : "push",
        watchPaths: parseWatchPaths(p.repoWatchPaths),
        rootDirectory: buildById.get(p.id)?.rootDirectory ?? null,
        skipUnchanged: buildById.get(p.id)?.skipUnchangedDeployments ?? false,
      },
      pushEvent,
    ),
  );

  if (targets.length === 0) {
    // The silent-failure heart of this endpoint: a delivered, verified push
    // that matches no project returns 200 with no deploy. Dump every github
    // service's match-relevant fields so the exact mismatched clause (source /
    // autoDeploy / repo / installationId / branch / trigger / watch paths) is
    // obvious from one log line.
    console.warn(
      `[github-webhook] no auto-deploy target: repo=${fullName} ref=${pushEvent.refName} ` +
        `isTag=${pushEvent.isTag} install=${install.id}; candidates=` +
        JSON.stringify(
          githubServices.map((p) => ({
            id: p.id,
            autoDeploy: p.autoDeploy,
            repo: p.repoRepo,
            branch: p.repoBranch,
            triggerType: p.repoTriggerType,
            watchPaths: p.repoWatchPaths,
            installationId: p.repoInstallationId,
          })),
        ),
    );
  }

  for (const p of targets) {
    try {
      await startDeployment(p.id, {
        environment: "production",
        creator: payload.pusher?.name || "github",
        commitMessage:
          payload.head_commit?.message || (pushEvent.isTag ? "Tag" : "Push"),
        // For a tag trigger the deploy checks out the tag itself; for a push it's
        // the tracked branch (pushEvent.refName === repoBranch here).
        branch: pushEvent.refName,
      });
    } catch {
      /* keep processing the rest */
    }
  }

  return new Response("ok", { status: 200 });
}

function verifySignature(body: string, secret: string, header: string): boolean {
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
