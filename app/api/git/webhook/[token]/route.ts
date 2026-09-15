import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { apps as appsTable } from "@/lib/db/schema/control-plane/apps";
import { gitConnections as gitConnectionsTable } from "@/lib/db/schema/control-plane/integrations";
import { decryptSecret } from "@/lib/crypto";
import { dispatchPushEvent } from "@/lib/deploy/git-webhook-dispatch";
import { providerFor } from "@/lib/git/providers/registry";
import { readTextCapped } from "@/lib/http/body-cap";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const raw = await readTextCapped(request);
  if (raw instanceof Response) return raw;

  const conn = (
    await getDb()
      .select()
      .from(gitConnectionsTable)
      .where(eq(gitConnectionsTable.webhookToken, token))
      .limit(1)
  )[0];
  if (!conn) return new Response("not found", { status: 404 });

  const api = providerFor(conn.provider).api;
  if (!api) return new Response("not found", { status: 404 });

  const secret = decryptSecret(conn.webhookSecretEnc);
  const verdict = secret ? api.verify(secret, request.headers, raw) : "bad";
  if (verdict === "bad") {
    console.warn(
      `[git-webhook] 401 invalid signature for ${conn.provider} connection ${conn.id}` +
        (secret
          ? ""
          : " (stored webhook secret is empty - DEPLO_SECRET changed?)"),
    );
    return new Response("invalid signature", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  const pushes = api.parsePush(request.headers, payload);
  if (pushes.length === 0) return new Response("ok", { status: 200 });

  for (const push of pushes) {
    await dispatchPushEvent({
      match: eq(appsTable.repoConnectionId, conn.id),
      repoFullName: push.repoFullName,
      event: push.event,
      creator: push.author,
      provider: conn.provider,
      commitMessage: push.commitMessage,
      logTag: "git-webhook",
    });
  }

  return new Response("ok", { status: 200 });
}
