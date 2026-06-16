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
  if (!app) return new Response("ignored", { status: 202 });

  const secret = decryptSecret(app.webhookSecretEnc);
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!secret || !verifySignature(raw, secret, signature)) {
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
    return new Response("ok", { status: 200 });
  }

  const d = read();
  const install = (d.githubInstallations ?? []).find(
    (i) => i.installationId === numericInstall,
  );
  if (!install) return new Response("ok", { status: 200 });

  const targets = d.projects.filter(
    (p) =>
      p.source === "github" &&
      p.autoDeploy &&
      p.repo?.repo === fullName &&
      p.repo?.installationId === install.id &&
      (p.repo?.branch || "main") === branch,
  );

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
