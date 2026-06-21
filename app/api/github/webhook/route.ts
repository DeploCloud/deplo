import { createHmac, timingSafeEqual } from "node:crypto";
import { read, ensureStoreReady } from "@/lib/store";
import { decryptSecret } from "@/lib/crypto";
import { findAppByAppId } from "@/lib/github/app";
import { startDeployment } from "@/lib/deploy/build";

/**
 * Inbound GitHub App webhook. Verifies the HMAC signature against the receiving
 * App's webhook secret, then triggers an auto-redeploy of any project wired to
 * the pushed repo + branch. Best-effort: unmatched or unverifiable deliveries
 * are acknowledged without action.
 */
export async function POST(request: Request) {
  // Unauthenticated endpoint: GitHub calls it directly, so it never passes
  // through the dashboard layout / getCurrentUser() that hydrates the store in
  // Postgres mode. Hydrate explicitly or a cold worker would drop the push.
  await ensureStoreReady();

  const raw = await request.text();

  const appId = Number(
    request.headers.get("x-github-hook-installation-target-id"),
  );
  const app = Number.isInteger(appId) ? findAppByAppId(appId) : null;
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
  const branch = payload.ref?.replace(/^refs\/heads\//, "");
  const numericInstall = payload.installation?.id;
  if (!fullName || !branch || !numericInstall) {
    // A branch/tag delete push has a null ref→empty branch; tag pushes have a
    // non-heads ref. Nothing to deploy, but worth a line so it's not confused
    // with a missing-config drop.
    console.warn(
      `[github-webhook] push ignored: ref=${payload.ref} repo=${fullName ?? "?"} install=${numericInstall ?? "?"}`,
    );
    return new Response("ok", { status: 200 });
  }

  const d = read();
  const install = (d.githubInstallations ?? []).find(
    (i) => i.installationId === numericInstall,
  );
  if (!install) {
    console.warn(
      `[github-webhook] no installation row for numeric id ${numericInstall} (repo=${fullName})`,
    );
    return new Response("ok", { status: 200 });
  }

  const targets = d.projects.filter(
    (p) =>
      p.source === "github" &&
      p.autoDeploy &&
      p.repo?.repo === fullName &&
      p.repo?.installationId === install.id &&
      (p.repo?.branch || "main") === branch,
  );

  if (targets.length === 0) {
    // The silent-failure heart of this endpoint: a delivered, verified push
    // that matches no project returns 200 with no deploy. Dump every github
    // project's match-relevant fields so the exact mismatched clause (source /
    // autoDeploy / repo / installationId / branch) is obvious from one log line.
    console.warn(
      `[github-webhook] no auto-deploy target: repo=${fullName} branch=${branch} ` +
        `install=${install.id}; candidates=` +
        JSON.stringify(
          d.projects
            .filter((p) => p.source === "github")
            .map((p) => ({
              id: p.id,
              autoDeploy: p.autoDeploy,
              repo: p.repo?.repo,
              branch: p.repo?.branch,
              installationId: p.repo?.installationId,
            })),
        ),
    );
  }

  for (const p of targets) {
    try {
      startDeployment(p.id, {
        environment: "production",
        creator: payload.pusher?.name || "github",
        commitMessage: payload.head_commit?.message || "Push",
        branch,
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

interface PushPayload {
  ref?: string;
  repository?: { full_name?: string };
  installation?: { id?: number };
  pusher?: { name?: string };
  head_commit?: { message?: string };
}
