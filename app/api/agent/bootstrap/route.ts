import { ensureStoreReady } from "@/lib/store";
import { completeBootstrap } from "@/lib/data/servers";
import { signResponse, BootstrapError } from "@/lib/agent/bootstrap";

/**
 * The call-home BOOTSTRAP endpoint (PLAN Part B, P1-P4). UNAUTHENTICATED: the
 * caller is a brand-new agent that has no session and no mTLS identity yet — its
 * trust comes entirely from the single-use bootstrap token (operator
 * authorisation) + the CSR's proof-of-possession, NOT from a logged-in user. So,
 * like the GitHub webhook, it bypasses getCurrentUser() and must run the backfill
 * gate (ensureStoreReady) itself before reading the relational `servers` table.
 *
 * Flow:
 *   1. The agent has already authenticated US (P2/P3): over HTTPS it pinned our
 *      cert fingerprint before POSTing here; over plain HTTP it relies on the
 *      response HMAC below.
 *   2. We validate the token against a provisioning server, sign the agent's CSR
 *      with the control-plane CA (SANs = the server row's declared address, never
 *      a self-reported one), pin the cert fingerprint, and flip the server to
 *      `online` — all in completeBootstrap().
 *   3. We HMAC-sign the JSON response body with the raw token (the secret the
 *      agent holds) so a network attacker who never had the token cannot
 *      substitute their own CA. The agent verifies this MAC before trusting the
 *      returned CA — the value that anchors all future mTLS.
 */
export async function POST(request: Request) {
  await ensureStoreReady();

  let body: {
    token?: unknown;
    csrPem?: unknown;
    agentPort?: unknown;
    advertisedHost?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token : "";
  const csrPem = typeof body.csrPem === "string" ? body.csrPem : "";
  if (!token || !csrPem) {
    return Response.json(
      { error: "token and csrPem are required" },
      { status: 400 },
    );
  }
  const agentPort =
    typeof body.agentPort === "number" ? body.agentPort : undefined;
  const advertisedHost =
    typeof body.advertisedHost === "string" ? body.advertisedHost : undefined;

  try {
    const { certPem, caPem } = await completeBootstrap({
      token,
      csrPem,
      agentPort,
      advertisedHost,
    });
    // The agent recomputes this HMAC with its copy of the token and refuses a
    // mismatch — binding the response (and the CA it carries) to a party that
    // knew the token. Serialise the SAME bytes we sign so the agent's recompute
    // matches exactly.
    const payload = JSON.stringify({ certPem, caPem });
    const mac = signResponse(token, payload);
    return new Response(payload, {
      status: 200,
      headers: {
        "content-type": "application/json",
        // The agent reads this header, recomputes signResponse(token, body), and
        // compares in constant time before trusting the body.
        "x-deplo-bootstrap-mac": mac,
      },
    });
  } catch (e) {
    if (e instanceof BootstrapError) {
      // A bad/expired/used token or malformed CSR: 401 (the caller is not, or no
      // longer, authorised) — never reveal which server or why beyond the reason
      // code, which is safe to share (it does not leak the token).
      return Response.json({ error: e.reason }, { status: 401 });
    }
    // A lost race (token consumed concurrently) or unexpected failure.
    return Response.json(
      { error: e instanceof Error ? e.message : "bootstrap failed" },
      { status: 409 },
    );
  }
}
