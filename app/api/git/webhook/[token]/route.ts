import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import {
  apps as appsTable,
  gitConnections as gitConnectionsTable,
} from "@/lib/db/schema/control-plane";
import { decryptSecret } from "@/lib/crypto";
import { dispatchPushEvent } from "@/lib/deploy/git-webhook-dispatch";
import { providerFor } from "@/lib/git/providers";

/**
 * Inbound push webhook for every git provider that is not GitHub.
 *
 * ONE route for all of them, keyed by the opaque `token` in its own URL: that
 * token identifies the connection, and the connection says which provider sent
 * the delivery and which secret verifies it. Sniffing headers to guess the
 * provider would be both fragile and a way to pick the verification rule from
 * attacker-controlled input.
 *
 * Session-free by construction, like GitHub's: a delivery is authenticated by
 * its signature, never by a user. What happens after verification is the shared
 * dispatcher, so the trigger rules are the same ones GitHub gets.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const raw = await request.text();

  const conn = (
    await getDb()
      .select()
      .from(gitConnectionsTable)
      .where(eq(gitConnectionsTable.webhookToken, token))
      .limit(1)
  )[0];
  // No connection for this URL. 404 rather than a hint: the token is the only
  // thing standing between the internet and this endpoint.
  if (!conn) return new Response("not found", { status: 404 });

  const api = providerFor(conn.provider).api;
  if (!api) return new Response("not found", { status: 404 });

  const secret = decryptSecret(conn.webhookSecretEnc);
  // An unreadable secret is NOT an unsigned delivery. `decryptSecret` fails
  // closed to `""`, and every verifier below would then compare against
  // something an attacker can produce themselves: an empty token for GitLab, an
  // HMAC under an empty key for Gitea and Bitbucket. A connection is always
  // minted WITH a secret, so empty here means the ciphertext stopped opening -
  // refuse, exactly as the GitHub route does on the same condition.
  const verdict = secret ? api.verify(secret, request.headers, raw) : "bad";
  if (verdict === "bad") {
    // Same trap GitHub's route names: a rotated DEPLO_SECRET leaves a webhook
    // secret that no longer decrypts, and then every delivery 401s forever.
    console.warn(
      `[git-webhook] 401 invalid signature for ${conn.provider} connection ${conn.id}` +
        (secret ? "" : " (stored webhook secret is empty — DEPLO_SECRET changed?)"),
    );
    return new Response("invalid signature", { status: 401 });
  }
  // `unsigned` is Bitbucket with no secret configured on its side: there is
  // nothing to check, and the unguessable token in this URL is what
  // authenticated the request - the same bar the deploy hook clears.

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  // One delivery can move several refs (pushing two branches at once), so each
  // parsed ref is dispatched on its own.
  const pushes = api.parsePush(request.headers, payload);
  if (pushes.length === 0) return new Response("ok", { status: 200 });

  for (const push of pushes) {
    await dispatchPushEvent({
      match: eq(appsTable.repoConnectionId, conn.id),
      repoFullName: push.repoFullName,
      event: push.event,
      creator: push.author,
      commitMessage: push.commitMessage,
      logTag: "git-webhook",
    });
  }

  return new Response("ok", { status: 200 });
}
