import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { apps as appsTable } from "@/lib/db/schema/control-plane/apps";
import { gitConnections as gitConnectionsTable } from "@/lib/db/schema/control-plane/integrations";
import { decryptSecret } from "@/lib/crypto";
import { dispatchPushEvent } from "@/lib/deploy/git-webhook-dispatch";
import { providerFor } from "@/lib/git/providers/registry";
import { readTextCapped } from "@/lib/http/body-cap";

// POST is the push webhook for every non-GitHub provider; sniffing headers would let attacker-controlled input pick the verification rule.
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
  // 404 rather than a hint: the token is the only thing between the internet and this endpoint.
  if (!conn) return new Response("not found", { status: 404 });

  const api = providerFor(conn.provider).api;
  if (!api) return new Response("not found", { status: 404 });

  const secret = decryptSecret(conn.webhookSecretEnc);
  // A connection is always minted WITH a secret, so empty here means the ciphertext stopped opening - not an unsigned delivery.
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
  // `unsigned` is Bitbucket with no secret on its side: the unguessable token in this URL is what authenticated the request.

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  // One delivery can move several refs (two branches pushed at once), so each is dispatched on its own.
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
